import { useRef, useState } from "react";
import type * as React from "react";
import type { ShellView } from "../../server/snapshot.ts";
import { TerminalTab, useShellChoice } from "./TerminalTab.tsx";
import { TERMINAL_HEIGHT, panelHeight } from "./terminalPlace.ts";

export interface TerminalPanelProps {
  sessionId: string;
  cwd: string;
  shells: ShellView[];
  // Calls an /api route for this session.
  call: (path: string, body: Record<string, unknown>) => Promise<unknown>;
  height: number;
  onHeight: (height: number) => void;
  onMove: () => void;
  onHide: () => void;
  onLink: (event: MouseEvent, uri: string) => void;
}

// The terminal as a panel under the desk, across both panes. It shows the focused chat's shells, and the
// shell it shows is the one the chat's dock remembers.
export function TerminalPanel({ sessionId, cwd, shells, call, height, onHeight, onMove, onHide, onLink }: TerminalPanelProps) {
  const [shell, pick] = useShellChoice(sessionId);
  const [dragging, setDragging] = useState(false);
  const panelRef = useRef<HTMLElement | null>(null);

  // The desk column the panel sits in, which bounds its height.
  function columnHeight(): number {
    return panelRef.current?.parentElement?.getBoundingClientRect().height ?? 0;
  }

  function beginDrag(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const panel = panelRef.current;
    if (!panel) return;
    const bottom = panel.getBoundingClientRect().bottom;
    const column = columnHeight();
    setDragging(true);
    function move(ev: PointerEvent) {
      onHeight(panelHeight(bottom - ev.clientY, column));
    }
    function stop() {
      setDragging(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  }

  function onGripKey(event: React.KeyboardEvent<HTMLDivElement>) {
    const step = event.key === "ArrowUp" ? 24 : event.key === "ArrowDown" ? -24 : 0;
    if (!step) return;
    event.preventDefault();
    onHeight(panelHeight(height + step, columnHeight()));
  }

  return (
    <section
      className={dragging ? "terminal-panel is-dragging" : "terminal-panel"}
      ref={panelRef}
      style={{ height }}
      aria-label="Terminal"
      data-testid="terminal-panel"
    >
      <div
        className="terminal-panel-grip"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize terminal"
        aria-valuenow={height}
        tabIndex={0}
        onPointerDown={beginDrag}
        onKeyDown={onGripKey}
        onDoubleClick={() => onHeight(panelHeight(TERMINAL_HEIGHT, columnHeight()))}
      />
      <TerminalTab
        sessionId={sessionId}
        cwd={cwd}
        shells={shells}
        shellId={shell}
        onShell={pick}
        call={call}
        place="bottom"
        onMove={onMove}
        onHide={onHide}
        onLink={onLink}
      />
    </section>
  );
}
