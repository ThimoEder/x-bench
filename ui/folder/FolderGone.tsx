import { useRef, useState } from "react";
import { useCloseOutside } from "../useCloseOutside.ts";
import type { GoneFolder } from "../../server/folder/goneFolder.ts";
import type { SessionCall } from "../chat/Transcript.tsx";
import { leaveRef } from "../leaveRef.ts";

export interface FolderGoneProps {
  gone: GoneFolder;
  archived?: boolean;
  // A turn still runs: the chat moves once it ends.
  running?: boolean;
  act: SessionCall;
  call: (path: string, body: Record<string, unknown>) => Promise<unknown>;
}

// Takes the composer's place in a chat whose folder is gone: continue it somewhere else, or archive or unarchive it.
export function FolderGone({ gone, archived = false, running = false, act, call }: FolderGoneProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const root = useRef<HTMLDivElement | null>(null);

  useCloseOutside(open, root, () => setOpen(false));

  async function run(label: string, work: () => Promise<unknown>) {
    setOpen(false);
    setBusy(label);
    try {
      await work();
    } catch {
      // The banner shows what failed.
    } finally {
      setBusy(null);
    }
  }

  function relocate(to: "worktree" | "checkout") {
    run(to === "worktree" ? "Creating worktree…" : "Moving chat…", () => act("/api/relocate", { to }));
  }

  function chooseFolder() {
    run("Moving chat…", async () => {
      const picked = await call("/api/browse", { pick: true });
      const cwd = isRecord(picked) && typeof picked.cwd === "string" ? picked.cwd : "";
      if (cwd) await act("/api/relocate", { to: "folder", cwd });
    });
  }

  function archive() {
    run("Archiving…", async () => {
      await act("/api/archive");
      await act("/api/leave");
    });
  }

  function unarchive() {
    run("Unarchiving…", () => act("/api/unarchive"));
  }

  const worktree = Boolean(gone.home);
  const home = gone.home ? baseName(gone.home) : "";
  return (
    <div className="folder-gone" role="status">
      <span className="folder-gone-icon" aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 4.5h4l1.5 1.5H14v6.5H2z" />
          <path d="M6.2 8.3 9.8 11M9.8 8.3 6.2 11" />
        </svg>
      </span>
      <div className="folder-gone-body">
        <div className="folder-gone-title">{worktree ? "This worktree was removed" : "This chat's folder is gone"}</div>
        <div className="folder-gone-path" title={gone.path}>
          {gone.path}
        </div>
        {running ? <div className="folder-gone-wait">The chat can move once this reply ends.</div> : null}
        <div className="folder-gone-actions">
          {worktree ? (
            <div className="split-button" ref={root}>
              <button type="button" className="split-main" disabled={Boolean(busy) || running} onClick={() => relocate("worktree")}>
                {busy || "New worktree"}
              </button>
              <button
                type="button"
                className="split-toggle"
                disabled={Boolean(busy) || running}
                aria-label="More ways to continue"
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={() => setOpen((current) => !current)}
              >
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                  <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              {open ? (
                <div ref={leaveRef} className="session-menu split-menu" role="menu">
                  <button type="button" role="menuitem" onClick={() => relocate("checkout")}>
                    {gone.branch ? `Continue on ${gone.branch}` : `Continue in ${home}`}
                    <span className="folder-gone-hint">{gone.branch ? `In ${home}, on the branch it has checked out` : `In ${home}`}</span>
                  </button>
                </div>
              ) : null}
            </div>
          ) : (
            <button type="button" className="folder-gone-primary" disabled={Boolean(busy) || running} onClick={chooseFolder}>
              {busy || "Choose a folder…"}
            </button>
          )}
          <button type="button" disabled={Boolean(busy)} onClick={archived ? unarchive : archive}>
            {archived ? "Unarchive chat" : "Archive chat"}
          </button>
        </div>
      </div>
    </div>
  );
}

function baseName(folder: string): string {
  return folder.split(/[\\/]/).filter(Boolean).pop() || folder;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
