import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { Snapshot } from "../../server/snapshot.ts";
import { desktopBridge } from "../browser/browserPane.ts";
import type { TerminalPlace } from "../terminal/terminalPlace.ts";
import type { Layout } from "../useLayout.ts";
import { useStableCallback } from "../useStableCallback.ts";
import type { OpenedFile } from "./Dock.tsx";
import { dockPlaces, useDockPlace, type DockTab } from "./dockMemory.ts";

interface DockOptions {
  layout: Layout;
  // focusId is the chat focused last. shownId is the focused chat on the desk, none while a draft is up.
  focusId: string | null;
  setFocusId: (sessionId: string) => void;
  shownId: string | null;
  covered: boolean;
  // The Chat surface has no terminal, so Ctrl-` does nothing there.
  chatting: boolean;
  browserFocus: Snapshot["browser"]["focus"] | undefined;
  deviceFocus: Snapshot["deviceFocus"] | undefined;
}

export function useDock({ layout, focusId, setFocusId, shownId, covered, chatting, browserFocus, deviceFocus }: DockOptions) {
  const { dockOpen, setDockOpen, terminalPlace, setTerminalPlace } = layout;
  const [reviewNonce, setReviewNonce] = useState(0);
  const [terminalNonce, setTerminalNonce] = useState(0);
  // The tabs the dock's one or two panes show for the focused chat.
  const [dockTabs, setDockTabs] = useState<DockTab[]>([]);
  const [openedFile, setOpenedFile] = useState<OpenedFile | null>(null);
  const terminalBelow = useDockPlace(shownId, "terminal");
  const openDockOf = useEffectEvent((sessionId: string) => setDockOpen(true, sessionId));

  // A page opened in a new tab of the focused chat: the dock opens on it.
  const browserCount = browserFocus?.count ?? 0;
  const seenBrowserFocus = useRef(browserCount);
  useEffect(() => {
    if (browserCount === seenBrowserFocus.current) return;
    seenBrowserFocus.current = browserCount;
    if (desktopBridge() && !covered && focusId && browserFocus?.owner === focusId) openDockOf(focusId);
  }, [browserCount, covered, focusId, browserFocus?.owner]);

  // An app launched on a device by the focused chat: the dock opens on the Device tab.
  const deviceCount = deviceFocus?.count ?? 0;
  const seenDeviceFocus = useRef(deviceCount);
  useEffect(() => {
    if (deviceCount === seenDeviceFocus.current) return;
    seenDeviceFocus.current = deviceCount;
    if (!covered && focusId && deviceFocus?.owner === focusId) openDockOf(focusId);
  }, [deviceCount, covered, focusId, deviceFocus?.owner]);

  function terminalShown(sessionId: string): boolean {
    if (!shownId || shownId !== sessionId || covered) return false;
    if (terminalPlace === "bottom") return Boolean(terminalBelow);
    return dockOpen && dockTabs.includes("terminal");
  }

  function openReview(sessionId: string) {
    if (sessionId) setFocusId(sessionId);
    setReviewNonce((nonce) => nonce + 1);
    setDockOpen(true, sessionId || shownId);
  }

  // The shelf's terminal icon and Ctrl-`: the terminal opens where it was placed last, or closes when it shows.
  function toggleTerminal(sessionId: string) {
    if (!sessionId) return;
    setFocusId(sessionId);
    const shown = terminalShown(sessionId);
    if (terminalPlace === "bottom") {
      dockPlaces.save(sessionId, { terminal: !shown });
    } else if (shown) {
      setDockOpen(false, sessionId);
    } else {
      showTerminalTab(sessionId);
    }
  }

  function showTerminalTab(sessionId: string) {
    dockPlaces.save(sessionId, { tab: "terminal" });
    setTerminalNonce((nonce) => nonce + 1);
    setDockOpen(true, sessionId);
  }

  // The strip's move button. The dock stays open on its other tabs when the terminal leaves it.
  function moveTerminal(sessionId: string, to: TerminalPlace) {
    setTerminalPlace(to);
    dockPlaces.save(sessionId, { terminal: to === "bottom" });
    if (to === "dock") showTerminalTab(sessionId);
  }

  function openFile(sessionId: string, filePath: string) {
    if (!sessionId || !filePath) return;
    setFocusId(sessionId);
    setOpenedFile((current) => ({ sessionId, path: filePath, nonce: (current?.nonce || 0) + 1 }));
    setDockOpen(true, sessionId);
  }

  const terminalKey = useStableCallback((event: KeyboardEvent) => {
    if (!event.ctrlKey || event.metaKey || event.altKey || event.key !== "`") return;
    if (!shownId || chatting || covered) return;
    event.preventDefault();
    toggleTerminal(shownId);
  });
  useEffect(() => {
    window.addEventListener("keydown", terminalKey);
    return () => window.removeEventListener("keydown", terminalKey);
  }, [terminalKey]);

  return { reviewNonce, terminalNonce, setDockTabs, openedFile, terminalShown, openReview, toggleTerminal, moveTerminal, openFile };
}
