import { useEffect, useEffectEvent, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isRecord } from "../../bridge/lenient.ts";
import type { GitView } from "../../server/git/git.ts";
import { BranchIcon, Stat } from "./GitChanges.tsx";

export type WorktreeVerb = "delete" | "archive";

export type WorktreeBody = { worktree: boolean; discard?: boolean };

type Send = (body: WorktreeBody) => Promise<unknown>;

export type WorktreeGuard = (verb: WorktreeVerb, send: Send, onAsk?: () => void) => Promise<boolean>;

interface Ask {
  verb: WorktreeVerb;
  changes: GitView;
  send: Send;
  settle: (gone: boolean) => void;
  fail: (error: unknown) => void;
}

function changesOf(reply: unknown): GitView | null {
  return isRecord(reply) && isRecord(reply.changes) && Array.isArray(reply.changes.files) ? (reply.changes as unknown as GitView) : null;
}

// guard resolves once the person answers the dialog: true when the chat went, false on Cancel. One guard runs at a
// time, and another started meanwhile resolves false without sending, so its answer cannot take over an armed Discard.
export function useWorktreeDiscard() {
  const [ask, setAsk] = useState<Ask | null>(null);
  const running = useRef(false);

  const guard: WorktreeGuard = async (verb, send, onAsk) => {
    if (running.current) return false;
    running.current = true;
    try {
      const changes = changesOf(await send({ worktree: true }));
      if (!changes) return true;
      onAsk?.();
      return await new Promise<boolean>((settle, fail) => {
        setAsk({ verb, changes, send, settle, fail });
      });
    } finally {
      running.current = false;
    }
  };

  const dialog = ask ? createPortal(<WorktreeDiscard ask={ask} onClose={() => setAsk(null)} />, document.body) : null;
  return { guard, dialog };
}

function total(changes: GitView, key: "additions" | "deletions"): number {
  return changes.files.reduce((sum, file) => sum + (Number(file[key]) || 0), 0);
}

function WorktreeDiscard({ ask, onClose }: { ask: Ask; onClose: () => void }) {
  const { verb, changes } = ask;
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState<"" | "keep" | "discard">("");
  const keep = useRef<HTMLButtonElement | null>(null);
  const count = changes.files.length;
  const files = `${count} uncommitted file${count === 1 ? "" : "s"}`;

  useEffect(() => keep.current?.focus(), []);

  function cancel() {
    if (busy) return;
    onClose();
    ask.settle(false);
  }

  const onEscape = useEffectEvent(cancel);
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onEscape();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  async function answer(discard: boolean) {
    if (discard && !armed) {
      setArmed(true);
      return;
    }
    setBusy(discard ? "discard" : "keep");
    try {
      await ask.send(discard ? { worktree: true, discard: true } : { worktree: false });
      ask.settle(true);
    } catch (error) {
      ask.fail(error);
    }
    onClose();
  }

  return (
    <div className="worktree-scrim" onMouseDown={(event) => event.target === event.currentTarget && cancel()}>
      <div className="switch-confirm worktree-discard" role="alertdialog" aria-modal="true" aria-labelledby="worktree-discard-title" aria-describedby="worktree-discard-note" data-testid="worktree-discard">
        <h3 id="worktree-discard-title">{files} in this worktree</h3>
        <p className="git-branch">
          <BranchIcon />
          {changes.branch ? <b className="git-branch-name">{String(changes.branch)}</b> : null}
          {changes.commit ? <span className="git-sha">{changes.commit}</span> : null}
          <Stat additions={total(changes, "additions")} deletions={total(changes, "deletions")} />
        </p>
        <ul className="worktree-files">
          {changes.files.map((file) => {
            const path = String(file.path);
            const name = path.lastIndexOf("/") + 1;
            return (
              <li key={path}>
                <span className="git-path">
                  <span className="git-dir">{path.slice(0, name)}</span>
                  {path.slice(name)}
                </span>
                {file.type === "untracked" ? <span className="worktree-new">new</span> : null}
                <Stat additions={file.additions} deletions={file.deletions} />
              </li>
            );
          })}
        </ul>
        <p id="worktree-discard-note" className="switch-note">
          Deleting the worktree throws these changes away.{changes.branch ? " The branch keeps every commit." : ""}
        </p>
        <div className="switch-actions">
          <button type="button" className="ghost" disabled={Boolean(busy)} onClick={cancel}>
            Cancel
          </button>
          <button type="button" className={armed ? "danger is-armed" : "danger"} disabled={Boolean(busy)} onClick={() => void answer(true)}>
            {busy === "discard" ? "Discarding…" : armed ? `Discard ${count === 1 ? "1 file" : `${count} files`}?` : "Discard changes"}
          </button>
          <button type="button" className="primary" ref={keep} disabled={Boolean(busy)} onClick={() => void answer(false)}>
            {busy === "keep" ? (verb === "delete" ? "Deleting…" : "Archiving…") : verb === "delete" ? "Delete the chat only" : "Archive the chat only"}
          </button>
        </div>
      </div>
    </div>
  );
}
