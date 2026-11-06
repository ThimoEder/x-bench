import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { paneRect, sameRect, type PaneRect } from "../browser/browserPane.ts";
import { FillWindowIcon, FullScreenIcon } from "../icons.tsx";

interface UnityStats {
  // The desktop app has no addon to draw with.
  missing?: boolean;
  connected: boolean;
  fps: number;
  frames: number;
  width: number;
  height: number;
  inputMs: number;
  // The Unity project whose Editor takes the touches and keys, found in the chat's folder.
  project: string | null;
}

interface UnityBridge {
  unityBounds(bounds: PaneRect | null): void;
  // The shown chat's folder, where the Unity project is looked for.
  unityFolder(cwd: string | null): void;
  onUnityStats(listener: (stats: UnityStats) => void): () => void;
  unityPointer(x: number, y: number, action: string): void;
  unityKey(key: string, action: string): void;
  // Puts the window into macOS fullscreen, or back. onLeft runs when the window leaves it another way.
  unityFullScreen(flag: boolean, onLeft?: () => void): () => void;
}

// The keys and the finger the game holds down, in Unity's screen pixels.
interface HeldInput {
  keys: Set<string>;
  touch: { x: number; y: number } | null;
}

function letGo(bridge: UnityBridge, held: HeldInput) {
  for (const name of held.keys) bridge.unityKey(name, "up");
  held.keys.clear();
  if (held.touch) bridge.unityPointer(held.touch.x, held.touch.y, "up");
  held.touch = null;
}

// A DOM key code as the Input System's Key name, or null for keys the game does not get.
function unityKey(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1] ?? null;
  const arrow = /^Arrow(Up|Down|Left|Right)$/.exec(code);
  if (arrow) return `${arrow[1]}Arrow`;
  const side = /^(Shift|Control|Alt)(Left|Right)$/.exec(code);
  if (side) return `${side[2]}${side[1] === "Control" ? "Ctrl" : side[1]}`;
  if (/^Digit[0-9]$/.test(code) || ["Space", "Enter", "Escape", "Tab", "Backspace"].includes(code)) return code;
  return null;
}

function unityBridge(): UnityBridge | null {
  const value: unknown = Reflect.get(window, "xBenchDesktop");
  if (typeof value !== "object" || value === null || typeof Reflect.get(value, "unityBounds") !== "function") return null;
  return value as UnityBridge;
}

// Where the frame lands in the slot: the layer fits it in, centred.
function frameBox(element: HTMLElement, width: number, height: number) {
  const box = element.getBoundingClientRect();
  const scale = Math.min(box.width / width, box.height / height);
  const w = width * scale;
  const h = height * scale;
  return { left: box.left + (box.width - w) / 2, top: box.top + (box.height - h) / 2, width: w, height: h };
}

// The Unity Game view, drawn by the desktop app's Metal layer over the slot.
export function UnityView({ visible, cwd }: { visible: boolean; cwd: string }) {
  const slot = useRef<HTMLDivElement>(null);
  const [bridge] = useState(unityBridge);
  const [stats, setStats] = useState<UnityStats | null>(null);
  const held = useRef<HeldInput>({ keys: new Set(), touch: null });
  // Whether the game shows in the slot. While it is covered or hidden, it takes no input.
  const drawn = useRef(false);
  // "window" fills the window with the game, and "screen" also puts the window into macOS fullscreen. The view
  // goes to the page's body for both, since the dock's slide would otherwise hold a fixed box inside the dock.
  const [mode, setMode] = useState<"window" | "screen" | null>(null);

  useEffect(() => bridge?.onUnityStats(setStats), [bridge]);

  useEffect(() => {
    if (!mode || !bridge) return undefined;
    slot.current?.focus();
    const stopWatching = mode === "screen" ? bridge.unityFullScreen(true, () => setMode(null)) : null;
    const leave = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setMode(null);
    };
    window.addEventListener("keydown", leave, true);
    return () => {
      window.removeEventListener("keydown", leave, true);
      if (!stopWatching) return;
      stopWatching();
      bridge.unityFullScreen(false);
    };
  }, [mode, bridge]);

  useEffect(() => {
    if (!bridge || !(visible || mode)) return undefined;
    bridge.unityFolder(cwd);
    let sent: PaneRect | null = null;
    let frame = 0;
    const follow = () => {
      const next = slot.current ? paneRect(slot.current) : null;
      if (!sameRect(next, sent)) {
        sent = next;
        drawn.current = Boolean(next);
        if (!next) letGo(bridge, held.current);
        bridge.unityBounds(next);
      }
      frame = requestAnimationFrame(follow);
    };
    follow();
    // Hiding, closing or moving the slot, and switching to another app, end its keys and finger without a
    // blur or pointerup on it.
    const input = held.current;
    const away = () => letGo(bridge, input);
    window.addEventListener("blur", away);
    return () => {
      cancelAnimationFrame(frame);
      drawn.current = false;
      window.removeEventListener("blur", away);
      bridge.unityBounds(null);
      letGo(bridge, input);
      bridge.unityFolder(null);
    };
  }, [bridge, visible, mode, cwd]);

  function pointer(event: React.PointerEvent<HTMLDivElement>, action: "down" | "move" | "up") {
    if (!bridge || !stats?.width || !slot.current) return;
    if (action === "down" ? !drawn.current : !held.current.touch) return;
    if (action === "down") {
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    const box = frameBox(slot.current, stats.width, stats.height);
    const u = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
    const v = Math.min(1, Math.max(0, (event.clientY - box.top) / box.height));
    const at = { x: u * stats.width, y: (1 - v) * stats.height };
    held.current.touch = action === "up" ? null : at;
    bridge.unityPointer(at.x, at.y, action);
  }

  function key(event: React.KeyboardEvent<HTMLDivElement>, action: "down" | "up") {
    const name = unityKey(event.code);
    if (!bridge || !name) return;
    // Esc leaves fill window and full screen, and Cmd starts the app's shortcuts. A key already down in
    // the game still gets its release.
    if (action === "down" && (!drawn.current || event.metaKey || (mode && name === "Escape") || held.current.keys.has(name))) return;
    if (action === "up" && !held.current.keys.delete(name)) return;
    event.preventDefault();
    if (action === "down") held.current.keys.add(name);
    bridge.unityKey(name, action);
  }

  // Keys and a finger still down when the view loses focus would stay pressed in the game.
  function release() {
    if (bridge) letGo(bridge, held.current);
  }

  if (!bridge) return <div className="dock-empty">The Unity view needs the desktop app.</div>;
  const view = (
    <div className={mode ? `unity-view is-full is-${mode}` : "unity-view"}>
      <div className="unity-status">
        <span>
          {stats?.missing
            ? "The Unity view is not built. Run desktop/unity/unity-view/build.sh and restart X Bench."
            : !stats?.project
            ? "No Unity Editor with the Pipeline package runs in this chat's folder."
            : stats.connected
            ? `${stats.project.split("/").pop()} · ${stats.fps.toFixed(0)} fps · ${stats.width}×${stats.height} · input ${stats.inputMs.toFixed(0)} ms`
            : `Waiting for ${stats.project.split("/").pop()}'s Game view. Enter play mode in Unity, with X Bench's Unity package installed.`}
        </span>
        <span className="unity-modes">
          <button
            type="button"
            className="icon"
            aria-label={mode === "window" ? "Back to the dock (Esc)" : "Fill the window"}
            title={mode === "window" ? "Back to the dock (Esc)" : "Fill the window"}
            aria-pressed={mode === "window"}
            onClick={() => setMode(mode === "window" ? null : "window")}
          >
            <FillWindowIcon />
          </button>
          <button
            type="button"
            className="icon"
            aria-label={mode === "screen" ? "Leave full screen (Esc)" : "Full screen"}
            title={mode === "screen" ? "Leave full screen (Esc)" : "Full screen"}
            aria-pressed={mode === "screen"}
            onClick={() => setMode(mode === "screen" ? null : "screen")}
          >
            <FullScreenIcon />
          </button>
        </span>
      </div>
      <div
        className="unity-slot"
        ref={slot}
        tabIndex={0}
        onKeyDown={(event) => key(event, "down")}
        onKeyUp={(event) => key(event, "up")}
        onBlur={release}
        onPointerDown={(event) => pointer(event, "down")}
        onPointerMove={(event) => pointer(event, "move")}
        onPointerUp={(event) => pointer(event, "up")}
        onPointerCancel={(event) => pointer(event, "up")}
      />
    </div>
  );
  return mode ? createPortal(view, document.body) : view;
}
