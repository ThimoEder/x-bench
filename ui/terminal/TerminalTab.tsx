import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { ComponentType } from "react";
import type { ShellView } from "../../server/snapshot.ts";
import { dockPlaces, useDockPlace } from "../dock/dockMemory.ts";
import type { TerminalPlace } from "./terminalPlace.ts";
import { TerminalIcon } from "./Terminal.tsx";
import type { TerminalScreenProps } from "./TerminalScreen.tsx";
import { useStableCallback } from "../useStableCallback.ts";

const LazyScreen = lazy(() => import("./TerminalScreen.tsx"));

// Sessions that had a shell during this visit. Their Terminal tab shows the empty state once the last shell
// closes, where a session's first visit starts a shell by itself.
const hadShells = new Set<string>();

// The shell a chat's terminal shows. It lives in the chat's dock memory, so the dock and the panel under the
// desk show the same one.
export function useShellChoice(sessionId: string): [string, (shellId: string) => void] {
  const shell = useDockPlace(sessionId, "shell") ?? "";
  const choose = useCallback((next: string) => dockPlaces.save(sessionId, { shell: next || undefined }), [sessionId]);
  return [shell, choose];
}

export interface TerminalTabProps {
  sessionId: string;
  cwd: string;
  shells: ShellView[];
  // The shell to show, when the session still has it.
  shellId: string;
  onShell: (shellId: string) => void;
  // Calls an /api route for this session.
  call: (path: string, body: Record<string, unknown>) => Promise<unknown>;
  // Whether the dock or panel is open.
  active?: boolean;
  place?: TerminalPlace;
  // Moves the terminal to the other place.
  onMove?: () => void;
  // Hides the panel under the desk.
  onHide?: () => void;
  onLink: (event: MouseEvent, uri: string) => void;
  screen?: ComponentType<TerminalScreenProps>;
}

export function TerminalTab({ sessionId, cwd, shells, shellId, onShell, call, active = true, place = "dock", onMove, onHide, onLink, screen: Screen = LazyScreen }: TerminalTabProps) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const shown = shells.find((shell) => shell.id === shellId) ?? shells.at(-1) ?? null;
  const folder = folderName(cwd);

  const empty = shells.length === 0;
  const startShell = useStableCallback(start);

  useEffect(() => {
    setError("");
  }, [sessionId]);

  // Only a terminal on screen counts as a visit: a closed dock that remembers its Terminal tab starts nothing.
  useEffect(() => {
    if (!active || hadShells.has(sessionId)) return;
    hadShells.add(sessionId);
    if (empty) void startShell();
  }, [sessionId, empty, active, startShell]);

  async function start() {
    if (starting) return;
    setStarting(true);
    setError("");
    try {
      const data = await call("/api/terminal/open", sizeOf(bodyRef.current));
      const id = shellIdOf(data);
      if (id) onShell(id);
    } catch (failure) {
      setError(failure instanceof Error && failure.message ? failure.message : "Couldn't start a shell");
    } finally {
      setStarting(false);
    }
  }

  function close(shell: ShellView) {
    if (shell.id === shown?.id) {
      const index = shells.indexOf(shell);
      onShell(shells[index + 1]?.id ?? shells[index - 1]?.id ?? "");
    }
    call("/api/terminal/close", { shellId: shell.id }).catch(() => {});
  }

  return (
    <section className={place === "bottom" ? "terminal-tab bottom" : "terminal-tab"} data-testid="terminal-tab">
      <div className="terminal-strip">
        <div className="terminal-shells" role="tablist" aria-label="Shells">
          {shells.map((shell) => (
            <div key={shell.id} className={shell.id === shown?.id ? "terminal-shell active" : "terminal-shell"}>
              <button
                type="button"
                role="tab"
                className="terminal-shell-pick"
                aria-selected={shell.id === shown?.id}
                title={shell.label}
                onClick={() => onShell(shell.id)}
              >
                {shell.running ? <span className="terminal-running" aria-label="Running" /> : null}
                <span className="terminal-shell-label">{shell.label}</span>
                {shell.exitCode === null ? null : (
                  <span className="terminal-exit" aria-label={`Exited with code ${shell.exitCode}`}>
                    {shell.exitCode}
                  </span>
                )}
              </button>
              <button type="button" className="terminal-shell-close" aria-label={`Close ${shell.label}`} onClick={() => close(shell)}>
                <svg width="10" height="10" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M4 4.2 12 12.2M12 4.2 4 12.2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          ))}
          <button type="button" className="terminal-new" aria-label="New shell" title="New shell" disabled={starting} onClick={() => void start()}>
            <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <span className="terminal-folder" title={cwd}>
          {folder}
        </span>
        {onMove ? (
          <button
            type="button"
            className="terminal-tool"
            aria-label={place === "bottom" ? "Move the terminal into the review dock" : "Move the terminal under the chat"}
            title={place === "bottom" ? "Move into the review dock" : "Move under the chat"}
            onClick={onMove}
          >
            {place === "bottom" ? <DockIcon /> : <BottomIcon />}
          </button>
        ) : null}
        {onHide ? (
          <button type="button" className="terminal-tool" aria-label="Hide the terminal" title="Hide (Ctrl-`)" onClick={onHide}>
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        ) : null}
      </div>
      <div className="terminal-body" ref={bodyRef}>
        {error ? <p className="terminal-error" role="alert">{error}</p> : null}
        {shown ? (
          <Suspense fallback={<div className="terminal-screen" />}>
            <Screen key={shown.id} shellId={shown.id} active={active} onLink={onLink} />
          </Suspense>
        ) : (
          <div className="terminal-empty" data-testid="terminal-empty">
            <span className="terminal-empty-glyph">
              <TerminalIcon />
            </span>
            <p className="terminal-empty-title">No shell in {folder}</p>
            <p className="terminal-empty-text">A shell starts in this session's folder and keeps running while you switch chats.</p>
            <button type="button" className="primary" disabled={starting} onClick={() => void start()}>
              {starting ? "Starting…" : "New shell"}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

function BottomIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2" y="2.5" width="12" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M2.6 9.6h10.8" stroke="currentColor" strokeWidth="1.3" />
      <rect x="3" y="10.2" width="10" height="2.6" rx="0.8" fill="currentColor" opacity="0.55" />
    </svg>
  );
}

function DockIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2" y="2.5" width="12" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M9.6 3.1v9.8" stroke="currentColor" strokeWidth="1.3" />
      <rect x="10.2" y="3.4" width="3" height="9.2" rx="0.8" fill="currentColor" opacity="0.55" />
    </svg>
  );
}

function folderName(cwd: string): string {
  return cwd.split(/[/\\]/).filter(Boolean).at(-1) || cwd || "this folder";
}

// The size a shell starts at, from the space the screen will fill. The screen sends its exact size when it
// attaches.
function sizeOf(element: HTMLElement | null): { cols: number; rows: number } {
  const width = element?.clientWidth || 0;
  const height = element?.clientHeight || 0;
  return { cols: Math.max(20, Math.floor((width - 16) / 7.2)) || 80, rows: Math.max(5, Math.floor((height - 8) / 14.4)) || 24 };
}

// /api/terminal/open answers { shell: ShellView }.
function shellIdOf(data: unknown): string {
  if (typeof data !== "object" || data === null) return "";
  const shell: unknown = Reflect.get(data, "shell");
  const id: unknown = typeof shell === "object" && shell !== null ? Reflect.get(shell, "id") : "";
  return typeof id === "string" ? id : "";
}
