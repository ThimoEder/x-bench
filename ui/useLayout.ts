import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { dockPlaces, useDockPlace } from "./dock/dockMemory.ts";
import { DOCK_LIMIT, DOCK_MIN, dockCap, dockWidthForPull, pullForDockWidth, settleDockWidth, shownDock, storedDock } from "./dock/dockReach.ts";
import { TERMINAL_HEIGHT, TERMINAL_HEIGHT_KEY, TERMINAL_MIN_HEIGHT, TERMINAL_PLACE_KEY, storedTerminalPlace } from "./terminal/terminalPlace.ts";
import type { TerminalPlace } from "./terminal/terminalPlace.ts";
import { storedFlag } from "./stored.ts";

export type Edge = "sidebar" | "dock" | "split";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function storedNumber(key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null || raw === "") return fallback;
    const value = Number(raw);
    if (Number.isFinite(value)) return clamp(value, min, max);
  } catch {
    // Ignore storage failures and keep the layout default.
  }
  return fallback;
}

// dockChat is the focused chat. A covered dock stays shut without changing its choice.
export function useLayout(dockChat: string | null, dockCovered: boolean) {
  const [sidebarOpen, setSidebarOpen] = useState(() => storedFlag("x-bench-sidebar", true));
  const [sidebarWidth, setSidebarWidth] = useState(() => storedNumber("x-bench-sidebar-width", 280, 240, 440));
  const [dockWidth, setDockWidth] = useState(() => storedNumber("x-bench-dock-width", 440, 320, 760));
  const [workspaceWidth, setWorkspaceWidth] = useState(0);
  const workspaceObserver = useRef<ResizeObserver | null>(null);
  // The dock's width before it reached across the chat, where it returns when it closes.
  const dockRestWidth = useRef(dockWidth);
  const [splitRatio, setSplitRatio] = useState(() => storedNumber("x-bench-split", 0.5, 0.28, 0.72));
  const [dragging, setDragging] = useState<Edge | null>(null);
  const [terminalPlace, setTerminalPlace] = useState<TerminalPlace>(() => storedTerminalPlace());
  const [terminalHeight, setTerminalHeight] = useState(() => storedNumber(TERMINAL_HEIGHT_KEY, TERMINAL_HEIGHT, TERMINAL_MIN_HEIGHT, 2000));
  const chat = useRef(dockChat);
  chat.current = dockChat;

  useEffect(() => {
    try {
      localStorage.setItem("x-bench-sidebar", sidebarOpen ? "1" : "0");
      localStorage.setItem("x-bench-sidebar-width", String(sidebarWidth));
      localStorage.setItem("x-bench-dock-width", String(dockWidth));
      localStorage.setItem("x-bench-split", String(splitRatio));
      localStorage.setItem(TERMINAL_PLACE_KEY, terminalPlace);
      localStorage.setItem(TERMINAL_HEIGHT_KEY, String(terminalHeight));
    } catch {
      // Layout still works without persistence.
    }
  }, [sidebarOpen, sidebarWidth, dockWidth, splitRatio, terminalPlace, terminalHeight]);

  // A chat never resized takes the last width.
  useLayoutEffect(() => {
    const width = dockChat ? dockPlaces.get(dockChat)?.width : undefined;
    if (width !== undefined) setDockWidth(width);
  }, [dockChat]);
  useEffect(() => {
    if (chat.current) dockPlaces.save(chat.current, { width: dockWidth });
  }, [dockWidth]);

  const observeWorkspace = useCallback((node: HTMLDivElement | null) => {
    workspaceObserver.current?.disconnect();
    workspaceObserver.current = null;
    if (!node) return;
    const observer = new ResizeObserver(() => setWorkspaceWidth(node.getBoundingClientRect().width));
    observer.observe(node);
    workspaceObserver.current = observer;
  }, []);

  // Each chat keeps its dock open or closed. A new chat starts with it closed.
  const chatDockOpen = useDockPlace(dockChat, "open") ?? false;
  const dockOpen = !dockCovered && chatDockOpen;
  // Beside the chat the dock stops at its cap, which leaves the chat CHAT_MIN. Past the cap it reaches across the
  // chat, which keeps its width underneath. A stored width comes back once the window has room for it.
  const dockLimit = dockCap(workspaceWidth);
  const dockShown = shownDock(dockWidth, workspaceWidth);
  const dockSlotWidth = Math.min(dockShown, dockLimit);
  const reaching = dockOpen && dockShown > dockLimit;
  const dockMax = Math.max(dockLimit, workspaceWidth);

  function setDockOpen(next: boolean | ((open: boolean) => boolean), sessionId = chat.current) {
    const current = (sessionId ? dockPlaces.get(sessionId)?.open : undefined) ?? false;
    const open = typeof next === "function" ? next(current) : next;
    const rest = (sessionId ? dockPlaces.get(sessionId)?.rest : undefined) ?? dockRestWidth.current;
    if (!open) setDockWidth((width) => (width > DOCK_LIMIT ? rest : width));
    if (sessionId) dockPlaces.save(sessionId, { open });
  }

  function beginResize(event: ReactPointerEvent<HTMLDivElement>, edge: Edge) {
    event.preventDefault();
    const startX = event.clientX;
    const startSidebar = sidebarWidth;
    const startPull = pullForDockWidth(dockShown, dockLimit);
    if (edge === "dock" && !reaching) {
      dockRestWidth.current = dockSlotWidth;
      if (chat.current) dockPlaces.save(chat.current, { rest: dockSlotWidth });
    }
    const limit = dockLimit;
    const reachFull = workspaceWidth;
    const bounds = edge === "split" ? event.currentTarget.parentElement?.getBoundingClientRect() : null;
    setDragging(edge);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic events and some browsers skip capture. Window listeners still track the drag.
    }
    function move(ev: PointerEvent) {
      if (edge === "sidebar") setSidebarWidth(clamp(startSidebar + ev.clientX - startX, 240, 440));
      else if (edge === "dock") {
        setDockWidth(storedDock(dockWidthForPull(startPull + startX - ev.clientX, reachFull, limit), reachFull));
      }
      else if (bounds) setSplitRatio(clamp((ev.clientX - bounds.left) / bounds.width, 0.28, 0.72));
    }
    function stop() {
      setDragging(null);
      if (edge === "dock") setDockWidth(settleDockWidth);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  }

  function nudge(edge: Edge, direction: number) {
    const step = direction * 24;
    if (edge === "sidebar") setSidebarWidth((width) => clamp(width + step, 240, 440));
    else if (edge === "dock") {
      setDockWidth((width) => storedDock(clamp(shownDock(width, workspaceWidth) - step, DOCK_MIN, dockMax), workspaceWidth));
    }
    else setSplitRatio((ratio) => clamp(ratio + direction * 0.04, 0.28, 0.72));
  }

  function onSeparatorKey(edge: Edge, event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      nudge(edge, -1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      nudge(edge, 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      if (edge === "sidebar") setSidebarWidth(240);
      else if (edge === "dock") setDockWidth(760);
      else setSplitRatio(0.28);
    } else if (event.key === "End") {
      event.preventDefault();
      if (edge === "sidebar") setSidebarWidth(440);
      else if (edge === "dock") setDockWidth(320);
      else setSplitRatio(0.72);
    }
  }

  return {
    sidebarOpen, setSidebarOpen, sidebarWidth, setSidebarWidth,
    workspaceWidth, observeWorkspace, splitRatio, setSplitRatio, dragging,
    terminalPlace, setTerminalPlace, terminalHeight, setTerminalHeight,
    dockOpen, setDockOpen, setDockWidth, dockShown, dockLimit, dockSlotWidth, dockMax, reaching,
    beginResize, onSeparatorKey,
  };
}

export type Layout = ReturnType<typeof useLayout>;
