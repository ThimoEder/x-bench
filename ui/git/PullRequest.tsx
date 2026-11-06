import { useCallback, useEffect, useRef, useState } from "react";
import type { PullRequest } from "../../server/git/pullRequest.ts";
import { isRecord } from "../../bridge/lenient.ts";
import type { SessionCall } from "../chat/Transcript.tsx";
import { watchGit } from "./gitWatch.ts";

export async function readPull(act: SessionCall): Promise<PullRequest | null> {
  const data = await act("/api/git/pr", {}, "POST", { quiet: true, silent: true });
  return isRecord(data) && isRecord(data.pr) ? (data.pr as unknown as PullRequest) : null;
}

// where is the folder and branch: a new one drops the pull request at once, before GitHub answers.
export function usePullRequest(act: SessionCall, running: boolean, enabled: boolean, where: string): { pr: PullRequest | null; refresh: () => void } {
  const [pr, setPr] = useState<PullRequest | null>(null);
  const [checkout, setCheckout] = useState(0);
  const actRef = useRef(act);
  actRef.current = act;

  useEffect(() => setPr(null), [where, checkout]);

  useEffect(() => {
    if (!enabled) return;
    let cancel = false;
    async function load() {
      try {
        const next = await readPull(actRef.current);
        if (!cancel) setPr((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
      } catch {
        // Keep the last state. A missed check should not hide the chip.
      }
    }
    load();
    const unwatch = watchGit(load, 60000, 60000);
    return () => {
      cancel = true;
      unwatch();
    };
  }, [running, enabled, where, checkout]);

  const refresh = useCallback(() => setCheckout((count) => count + 1), []);
  return { pr: enabled ? pr : null, refresh };
}

function names(list: string[]): string {
  return list.length > 5 ? `${list.slice(0, 5).join(", ")} and ${list.length - 5} more` : list.join(", ");
}

export function pullLabel(pr: PullRequest): string {
  switch (pr.status) {
    case "merged": return "Merged";
    case "closed": return "Closed";
    case "conflict": return `Merge conflicts with ${pr.base}`;
    case "failing": return `${names(pr.failing)} failing`;
    case "running": return `${pr.pending.length} ${pr.pending.length === 1 ? "check" : "checks"} running`;
    case "draft": return "Draft";
    case "blocked": return pr.review === "CHANGES_REQUESTED" ? "Changes requested" : pr.review === "REVIEW_REQUIRED" ? "Review required" : "Blocked from merging";
    case "behind": return `Behind ${pr.base}`;
    case "checking": return "Checking mergeability";
    case "ready": return "Ready to merge";
  }
}

export function pullPrompt(pr: PullRequest): string | null {
  const done = "Run the project's checks, then push. Call pr_status at the end and tell me the result.";
  // The branch can change between the click and the agent's turn.
  const check = `First check that this folder is on branch ${pr.branch || pr.head}. If it is not, stop and tell me.`;
  if (pr.status === "conflict") {
    return `${check} Pull request #${pr.number} (${pr.head} → ${pr.base}) has merge conflicts. Fetch the latest ${pr.base} of ${pr.repo || "the repository it targets"}, which may be another remote than origin, merge it into this branch, and resolve each conflict, keeping the intent of both sides. ${done}`;
  }
  if (pr.status === "failing") {
    return `${check} On pull request #${pr.number}, ${names(pr.failing)} failed. Read the failed logs with gh pr checks and gh run view --log-failed, and fix the cause. ${done}`;
  }
  return null;
}

function PullIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="4" cy="3.5" r="1.7" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="4" cy="12.5" r="1.7" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="12" cy="12.5" r="1.7" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M4 5.2v5.6M12 10.8V6a2 2 0 0 0-2-2H7.5M9 2.5 7.5 4 9 5.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function PullChip({ pr }: { pr: PullRequest }) {
  const label = pullLabel(pr);
  return (
    <a
      className={`pull-chip pull-${pr.status}`}
      data-testid="pull-chip"
      href={pr.url}
      target="_blank"
      rel="noreferrer"
      title={`#${pr.number} ${pr.title}: ${label}`}
      aria-label={`Pull request ${pr.number}: ${label}. Open on GitHub.`}
    >
      <span key={pr.status} className="pull-mark">
        <PullIcon />
      </span>
      <span>#{pr.number}</span>
      {pr.status === "running" ? <span className="pull-dot" /> : null}
    </a>
  );
}

// The row under the shelf when the pull request needs the person: merge conflicts or a failing check.
export function PullNotice({ pr, running, act, onStale }: { pr: PullRequest; running: boolean; act: SessionCall; onStale: () => void }) {
  const [checking, setChecking] = useState(false);
  // False once the row is gone, for example after a checkout, so a check still on its way sends nothing.
  const shown = useRef(true);
  useEffect(() => {
    shown.current = true;
    return () => {
      shown.current = false;
    };
  }, []);
  if (!pullPrompt(pr)) return null;

  async function ask() {
    setChecking(true);
    try {
      const fresh = await readPull(act);
      const text = fresh?.number === pr.number ? pullPrompt(fresh) : null;
      if (!shown.current) return;
      if (text) await act("/api/prompt", { text });
      else onStale();
    } catch {
      if (shown.current) onStale();
    } finally {
      if (shown.current) setChecking(false);
    }
  }

  return (
    <div className={`shelf-notice pull-${pr.status}`} data-testid="pull-notice" role="status">
      <PullIcon />
      <span className="shelf-notice-text">
        <b>#{pr.number}</b> · {pullLabel(pr)}
      </span>
      <button type="button" className="primary" disabled={running || checking} onClick={() => void ask()}>
        {pr.status === "conflict" ? "Resolve in chat" : "Fix in chat"}
      </button>
      <a href={pr.url} target="_blank" rel="noreferrer">Open ↗</a>
    </div>
  );
}
