import { useEffect, useRef, useState } from "react";
import type { ShellView } from "../../server/snapshot.ts";
import { remotePage, type ApiCall } from "../launchToken.ts";
import { watchGit } from "../git/gitWatch.ts";

export interface TerminalToggleProps {
  // The session's shells. The icon carries a dot while a command runs in one of them.
  shells?: ShellView[];
  open: boolean;
  onToggle: () => void;
}

// The icon on the shelf that shows and hides the session's terminal, in the review dock or under the desk.
export function TerminalToggle({ shells = [], open, onToggle }: TerminalToggleProps) {
  if (remotePage()) return null;
  const running = shells.some((shell) => shell.running);
  return (
    <button
      type="button"
      className={open ? "terminal-toggle open" : "terminal-toggle"}
      data-testid="terminal-toggle"
      aria-label={running ? "Terminal, a command is running" : "Terminal"}
      aria-pressed={open}
      title="Terminal (Ctrl-`)"
      onClick={onToggle}
    >
      <TerminalIcon />
      {running ? <span className="terminal-running" aria-hidden="true" /> : null}
    </button>
  );
}

export function TerminalIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 4.5 6.5 8 3 11.5M8 11.5h5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export interface ShelfDiffProps {
  call: ApiCall;
  running: boolean;
  onOpen: () => void;
}

export function ShelfDiff({ call, running, onOpen }: ShelfDiffProps) {
  const [diff, setDiff] = useState<{ additions: number; deletions: number } | null>(null);
  const callRef = useRef(call);
  callRef.current = call;

  useEffect(() => {
    let cancel = false;
    let pending = false;
    async function load() {
      if (pending) return;
      pending = true;
      try {
        const data = await callRef.current("/api/git", {}, "POST", { quiet: true });
        if (cancel || !data || !isRecord(data) || data.error) return;
        const next = lineCounts(data.files);
        setDiff((current) =>
          current && current.additions === next.additions && current.deletions === next.deletions ? current : next,
        );
      } catch {
        // Keep the last count. A missed status check should not clear it.
      } finally {
        pending = false;
      }
    }
    load();
    // Not on the session's revision: that changes with every streamed chunk, and each check runs git. Through
    // remote access the count is read only when a turn starts or ends and when the page shows again.
    const unwatch = watchGit(() => void load(), running ? 4000 : 15000, null);
    return () => {
      cancel = true;
      unwatch();
    };
  }, [running]);

  if (!diff || (!diff.additions && !diff.deletions)) return null;
  return (
    <button
      type="button"
      className="git-stat shelf-diff"
      data-testid="shelf-diff"
      aria-label={`${diff.additions} lines added, ${diff.deletions} lines removed since the last commit. Open review.`}
      onClick={onOpen}
    >
      <span className="add">+{diff.additions}</span>
      <span className="del">−{diff.deletions}</span>
    </button>
  );
}

function lineCounts(files: unknown): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const file of fileRows(files)) {
    additions += Number(file.additions) || 0;
    deletions += Number(file.deletions) || 0;
  }
  return { additions, deletions };
}

// The /api/git reply lists GitFile rows.
function fileRows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
