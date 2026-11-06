import { useEffect, useRef, useState } from "react";
import { useCloseOutside } from "../useCloseOutside.ts";
import type { KeyboardEvent } from "react";
import type { GitBranch, GitRefs, GitWorktree } from "../../server/git/git.ts";
import { filterRefs } from "../refs.ts";
import { watchGit } from "./gitWatch.ts";
import { OptionCheck } from "../OptionMenu.tsx";
import { CaretIcon } from "../icons.tsx";
import type { ApiCall } from "../launchToken.ts";
import type { WorktreePlan } from "../folder/draftWorktree.ts";
import { leaveRef } from "../leaveRef.ts";

// A /api/git/refs or /api/folder/refs reply (FolderRefs), or the empty view after a failed load.
type BranchView = Omit<GitRefs, "worktree" | "defaultBranch"> & { worktree?: boolean; defaultBranch?: string; error?: string };

type BranchItem = (GitBranch & { kind: "branch"; key: string }) | (GitWorktree & { kind: "worktree"; key: string });

export interface BranchMenuProps {
  call: ApiCall;
  cwd?: string | null;
  onOpenFolder?: (path: string | undefined) => void | Promise<unknown>;
  onBranch?: (branch: string) => void;
  // A draft's worktree box. While it is ticked, picking a branch sets the ref the worktree starts from.
  worktree?: WorktreePlan;
  onWorktree?: (plan: WorktreePlan) => void;
  unscoped?: boolean;
}

const empty: BranchView = { branch: "", root: "", branches: [], worktrees: [] };

export function BranchMenu({ call, cwd, onOpenFolder, onBranch, worktree, onWorktree, unscoped = false }: BranchMenuProps) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<BranchView | null>(null);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const root = useRef<HTMLDivElement | null>(null);
  const search = useRef<HTMLInputElement | null>(null);
  const callRef = useRef(call);
  const loadSeq = useRef(0);
  callRef.current = call;
  const refsPath = unscoped ? "/api/folder/refs" : "/api/git/refs";
  const onBranchRef = useRef(onBranch);
  onBranchRef.current = onBranch;
  const branch = typeof view?.branch === "string" ? view.branch : "";
  const loaded = Boolean(view);
  // An empty branch means a detached HEAD, which has no pull request to show.
  useEffect(() => {
    if (loaded) onBranchRef.current?.(branch);
  }, [branch, loaded]);
  const checkoutPath = unscoped ? "/api/folder/checkout" : "/api/git/checkout";

  useEffect(() => {
    if (unscoped && !cwd) {
      setView(null);
      return undefined;
    }
    // A draft's refs belong to its folder, so the previous folder's stay out of the chip while the new ones load.
    if (unscoped) setView(null);
    let cancel = false;
    const seq = ++loadSeq.current;
    callRef
      .current(refsPath, unscoped ? { cwd } : {}, "POST", { quiet: true })
      .then((data) => {
        if (!cancel && seq === loadSeq.current) setView(isRefs(data) ? data : null);
      })
      .catch((failure: unknown) => {
        if (!cancel && seq === loadSeq.current) setView({ ...empty, error: failure instanceof Error ? failure.message : undefined });
      });
    return () => {
      cancel = true;
    };
  }, [cwd, refsPath, unscoped]);

  // Through remote access the branch is read when the page shows again and when the menu opens.
  useEffect(() => {
    if (unscoped) return undefined;
    return watchGit(() => {
      const seq = ++loadSeq.current;
      callRef
        .current(refsPath, {}, "POST", { quiet: true })
        .then((data) => {
          if (seq === loadSeq.current) setView(isRefs(data) ? data : null);
        })
        .catch(() => {});
    }, 4000, null);
  }, [refsPath, unscoped]);

  useEffect(() => {
    if (open) search.current?.focus();
  }, [open]);
  useCloseOutside(open, root, () => setOpen(false));

  if (!view) {
    if (!unscoped) return null;
    return (
      <div className="branch-menu">
        <div className="branch-chip">
          <button type="button" className="branch-trigger" data-testid="branch-menu" disabled aria-label="Branch and worktree">
            <span className="branch-name">Git</span>
            <CaretIcon />
          </button>
          {onWorktree ? (
            <>
              <span className="branch-rule" aria-hidden="true" />
              <button type="button" className="branch-worktree-select" data-testid="new-worktree" disabled aria-pressed={false}>
                <span className="branch-check" aria-hidden="true" />
                worktree
              </button>
            </>
          ) : null}
        </div>
      </div>
    );
  }

  const shown = filterRefs(view, query);
  const items: BranchItem[] = [
    ...shown.branches.map((branch) => ({ kind: "branch" as const, key: `branch:${branch.name}`, ...branch })),
    ...shown.worktrees.map((tree) => ({ kind: "worktree" as const, key: `worktree:${tree.path}`, ...tree })),
  ];
  const highlighted = items[Math.min(index, Math.max(items.length - 1, 0))] || null;
  const aligned = !view.root || !cwd || sameFolder(view.root, cwd);
  const branchLabel = (aligned ? view.branch || "Git" : "Git") as string;
  const place = folderName(aligned ? view.root : cwd) || folderName(cwd);
  const inWorktree = aligned
    ? Boolean(view.worktree) || isGrokWorktree(view.root) || isGrokWorktree(cwd)
    : isGrokWorktree(cwd);
  // A new worktree starts from a checkout, never from inside another worktree.
  const canPlan = Boolean(view.root) && !inWorktree;
  const armed = canPlan && Boolean(worktree?.on);
  const plannedRef = armed ? worktree?.gitRef || view.defaultBranch || (typeof view.branch === "string" && view.branch) || "HEAD" : "";
  const label = plannedRef || branchLabel;

  async function refresh(): Promise<unknown> {
    const seq = ++loadSeq.current;
    const data = await call(refsPath, unscoped ? { cwd } : {});
    if (seq === loadSeq.current) setView(isRefs(data) ? data : null);
    return data;
  }

  function toggle() {
    setError("");
    setQuery("");
    setIndex(0);
    setOpen((current) => !current);
    if (!open) refresh().catch((failure: unknown) => setError(failure instanceof Error ? failure.message : ""));
  }

  function toggleWorktree() {
    if (!onWorktree || busy || !view || !canPlan) return;
    // An empty gitRef is the default branch, which the host fetches when the worktree is made.
    onWorktree({ on: !armed, gitRef: worktree?.gitRef || "" });
    setOpen(false);
    setQuery("");
  }

  async function choose(item: BranchItem | null) {
    if (!item || busy) return;
    setError("");
    if (item.kind === "worktree") {
      if (item.current || item.path === cwd) {
        setOpen(false);
        return;
      }
      setBusy("Opening…");
      try {
        await onOpenFolder?.(item.path);
        setOpen(false);
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : "");
      } finally {
        setBusy("");
      }
      return;
    }
    if (armed) {
      onWorktree?.({ on: true, gitRef: item.name });
      setOpen(false);
      setQuery("");
      return;
    }
    if (item.current) {
      setOpen(false);
      return;
    }
    setBusy("Checking out…");
    try {
      await call(checkoutPath, unscoped ? { cwd, branch: item.name } : { branch: item.name });
      setView((current) => ({
        ...(current || empty),
        branch: item.name,
        branches: (current?.branches ?? []).map((branch) => ({ ...branch, current: branch.name === item.name })),
      }));
      setOpen(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "");
    } finally {
      setBusy("");
    }
  }

  function onSearchKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setIndex((current) => (items.length ? (current + 1) % items.length : 0));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setIndex((current) => (items.length ? (current - 1 + items.length) % items.length : 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(highlighted);
    }
  }

  return (
    <div className={open ? "branch-menu open" : "branch-menu"} ref={root}>
      <div className="branch-chip">
        <button
          type="button"
          className="branch-trigger"
          data-testid="branch-menu"
          aria-label="Branch and worktree"
          aria-haspopup="dialog"
          aria-expanded={open}
          title={armed && plannedRef !== branchLabel ? `Worktree from ${plannedRef}. This folder stays on ${branchLabel}.` : cwd || label}
          onClick={toggle}
        >
          {inWorktree ? <WorktreeIcon /> : null}
          {place ? <span key={place} className="branch-kicker">{place}:</span> : null}
          <span key={label} className="branch-name">{label}</span>
          <CaretIcon />
        </button>
        {onWorktree ? (
          <>
            <span className="branch-rule" aria-hidden="true" />
            <button
              type="button"
              className="branch-worktree-select"
              data-testid="new-worktree"
              aria-pressed={armed}
              disabled={Boolean(busy) || !canPlan}
              title={inWorktree ? "This folder is a worktree already" : armed ? `New worktree from ${plannedRef} when you send` : "New worktree when you send"}
              onClick={toggleWorktree}
            >
              <span className={armed ? "branch-check on" : "branch-check"} aria-hidden="true">
                {armed ? <CheckIcon /> : null}
              </span>
              worktree
            </button>
          </>
        ) : null}
      </div>
      {open ? (
        <div ref={leaveRef} className="branch-popover" role="dialog" aria-label="Branches and worktrees">
          <input
            ref={search}
            data-testid="branch-search"
            value={query}
            spellCheck="false"
            placeholder="Search branches"
            onChange={(event) => {
              setQuery(event.target.value);
              setIndex(0);
            }}
            onKeyDown={onSearchKey}
          />
          {error || view.error ? <p className="branch-error">{error || view.error}</p> : null}
          <div className="branch-scroll">
            {shown.branches.length ? (
              <section>
                <p className="branch-label">Branches</p>
                <ul className="branch-list">
                  {shown.branches.map((branch, row) => (
                    <li key={branch.name}>
                      <button
                        type="button"
                        className={highlighted?.key === `branch:${branch.name}` ? "active" : ""}
                        onMouseEnter={() => setIndex(row)}
                        onClick={() => choose(items[row] ?? null)}
                      >
                        <span>{branch.name}</span>
                        <span className={branch.current ? "muted branch-current" : "muted"}>{branch.current ? "current" : branch.remote ? "remote" : ""}</span>
                        {branch.current ? <OptionCheck /> : null}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {shown.worktrees.length ? (
              <section>
                <p className="branch-label">Worktrees</p>
                <ul className="branch-list">
                  {shown.worktrees.map((tree, row) => (
                    <li key={tree.path}>
                      <button
                        type="button"
                        className={highlighted?.key === `worktree:${tree.path}` ? "active" : ""}
                        onMouseEnter={() => setIndex(shown.branches.length + row)}
                        onClick={() => choose(items[shown.branches.length + row] ?? null)}
                      >
                        <span>{tree.label}</span>
                        <span className={tree.current ? "muted branch-current" : "muted"}>{tree.current ? "current" : tree.ref}</span>
                        {tree.current ? <OptionCheck /> : null}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {!shown.branches.length && !shown.worktrees.length ? <p className="branch-empty">No matching branches</p> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function CheckIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M2.1 6.2 4.7 8.8 9.9 3.2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function WorktreeIcon() {
  return (
    <svg className="worktree-icon" width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M2.2 8h6.6M6.2 3.7 11.6 8 6.2 12.3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function isGrokWorktree(folder: unknown): boolean {
  return /[/\\]\.grok[/\\]worktrees[/\\]/i.test(String(folder || ""));
}

function sameFolder(left: unknown, right: unknown): boolean {
  return String(left || "").replace(/[/\\]+$/, "") === String(right || "").replace(/[/\\]+$/, "");
}

function folderName(folder: unknown): string {
  const trimmed = String(folder || "").replace(/[/\\]+$/, "");
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

function isRefs(value: unknown): value is BranchView {
  return (
    isRecord(value) &&
    Array.isArray(value.branches) &&
    value.branches.every(isBranch) &&
    Array.isArray(value.worktrees) &&
    value.worktrees.every(isWorktree) &&
    (value.worktree === undefined || typeof value.worktree === "boolean") &&
    (value.defaultBranch === undefined || typeof value.defaultBranch === "string") &&
    (value.error === undefined || typeof value.error === "string")
  );
}

function isBranch(value: unknown): value is GitBranch {
  return isRecord(value) && typeof value.name === "string" && typeof value.current === "boolean" && typeof value.remote === "boolean";
}

function isWorktree(value: unknown): value is GitWorktree {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.path === "string" &&
    typeof value.label === "string" &&
    typeof value.ref === "string" &&
    typeof value.current === "boolean"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
