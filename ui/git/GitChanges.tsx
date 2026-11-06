import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { revealScroll } from "./diffFollow.ts";
import { gitSnapshot, remoteReviewWatchMs, reviewUpdate, reviewWatchMs, watchGit } from "./gitWatch.ts";
import type { ReactNode } from "react";
import type { PresentedSession } from "../../server/present.ts";
import type { DiffBase } from "../../server/git/localGit.ts";
import { remotePage, type CallOptions } from "../launchToken.ts";

export type ChangeScope = DiffBase;

// A changed file as git listed it. Its fields pass through unchecked.
export type ListedFile = Record<string, unknown>;

export interface GitChangesProps {
  session: Pick<PresentedSession, "id" | "cwd" | "status">;
  call: (path: string, body: Record<string, unknown>, method?: string, options?: CallOptions) => Promise<unknown>;
  onOpen?: (file: ListedFile | null, options?: { refresh: boolean }) => void | Promise<void>;
  // root is the repository root the listed paths are relative to.
  onStack?: (files: ListedFile[], root: string) => void;
  onSelect?: (file: ListedFile) => void;
  activePath?: unknown;
  watch?: boolean;
  reviewNonce?: number;
  scope?: ChangeScope;
  onScope?: (scope: ChangeScope) => void;
  // The pane head's slot the scope and revert controls render into.
  headSlot?: HTMLElement | null;
}

// A GitView from /api/git, or the placeholder a failed poll shows.
interface GitInfo {
  branch?: unknown;
  commit?: string;
  root?: unknown;
  error?: string;
  files?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// The list itself when every row is an object, so an unchanged list keeps its identity.
function listedFiles(files: unknown): ListedFile[] {
  if (!Array.isArray(files)) return [];
  const rows: unknown[] = files;
  return rows.every(isRecord) ? rows : rows.filter(isRecord);
}

function isGitInfo(value: unknown): value is GitInfo {
  return (
    isRecord(value) &&
    (value.commit === undefined || typeof value.commit === "string") &&
    (value.error === undefined || typeof value.error === "string")
  );
}

// /api/git/revert answers a RevertResult.
function skippedMessages(data: unknown): unknown[] {
  if (!isRecord(data) || !Array.isArray(data.skipped)) return [];
  const rows: unknown[] = data.skipped;
  return rows.map((item) => (isRecord(item) ? item.message : undefined)).filter(Boolean);
}

// /api/git/diff answers { patch: GitPatch | null }.
export function patchText(data: unknown): string {
  const patch = isRecord(data) ? data.patch : undefined;
  return (isRecord(patch) && typeof patch.patch === "string" && patch.patch) || "";
}

export function GitChanges({ session, call, onOpen, onStack, onSelect, activePath = "", watch = false, reviewNonce = 0, scope = "head", onScope, headSlot }: GitChangesProps) {
  const [info, setInfo] = useState<GitInfo | null>(null);
  // The scope info was loaded for. Until it matches scope, the list on screen belongs to the other scope.
  const [infoScope, setInfoScope] = useState(scope);
  const [selected, setSelected] = useState<unknown>("");
  const [patch, setPatch] = useState("");
  const [opening, setOpening] = useState(false);
  const [armed, setArmed] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [revertNote, setRevertNote] = useState("");
  const callRef = useRef(call);
  const onOpenRef = useRef(onOpen);
  const onStackRef = useRef(onStack);
  const onSelectRef = useRef(onSelect);
  const selectedRef = useRef<unknown>("");
  const snapshotRef = useRef("");
  const watchedId = useRef(session.id);
  const listRef = useRef<HTMLUListElement | null>(null);
  callRef.current = call;
  onOpenRef.current = onOpen;
  onStackRef.current = onStack;
  onSelectRef.current = onSelect;
  selectedRef.current = selected;

  useEffect(() => {
    if (!watch) return undefined;
    let cancel = false;
    let pending = false;
    if (watchedId.current !== session.id) {
      watchedId.current = session.id;
      selectedRef.current = "";
      snapshotRef.current = "";
      setSelected("");
      setPatch("");
    }
    async function load() {
      if (pending || cancel) return;
      pending = true;
      try {
        const data = await callRef.current("/api/git", { base: scope }, "POST", { quiet: true });
        if (cancel) return;
        const files = listedFiles(isRecord(data) ? data.files : undefined);
        const stacked = Boolean(onStackRef.current);
        const selectedPath = files.some((file) => file.path === selectedRef.current) ? selectedRef.current : "";
        if (selectedRef.current && !selectedPath && !stacked) {
          selectedRef.current = "";
          setSelected("");
          setPatch("");
          await onOpenRef.current?.(null);
        }
        const update = reviewUpdate(snapshotRef.current, data, stacked ? "" : (selectedPath as string));
        snapshotRef.current = update.snapshot;
        if (isGitInfo(update.info)) {
          setInfo(update.info);
          setInfoScope(scope);
        }
        if (stacked) {
          onStackRef.current?.(files, String((isRecord(data) && data.root) || ""));
          return;
        }
        if (update.clear) {
          selectedRef.current = "";
          setSelected("");
          setPatch("");
          await onOpenRef.current?.(null);
          return;
        }
        if (selectedPath && update.refresh) await onOpenRef.current?.(update.refresh, { refresh: true });
      } catch {
        if (cancel || snapshotRef.current) return;
        const failed = { branch: "", files: [], error: "Git status failed" };
        snapshotRef.current = gitSnapshot(failed);
        setInfo(failed);
        setInfoScope(scope);
      } finally {
        pending = false;
      }
    }
    load();
    const running = session.status === "running";
    const unwatch = watchGit(() => void load(), reviewWatchMs(running), remoteReviewWatchMs(running));
    return () => {
      cancel = true;
      unwatch();
    };
  }, [session.id, session.status, watch, scope]);

  const files = infoScope === scope ? listedFiles(info?.files) : [];
  const shownKey = files.map((file) => `${file.path}\0${file.additions || 0}\0${file.deletions || 0}`).join("\n");
  const marked = onSelect ? activePath : selected;
  // shortcut: names the default branch main or master, read it from origin/HEAD if a repo uses another name.
  const switchable = scope === "main" || (info?.branch !== "main" && info?.branch !== "master");
  // Reverting committed work would discard commits, so only uncommitted changes revert.
  const revertable = scope === "head" && !info?.error && files.length > 0;

  useEffect(() => {
    if (!info || !onStackRef.current) return;
    onStackRef.current(files, String(info.root || ""));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- shownKey stands for files
  }, [info, shownKey]);

  useEffect(() => {
    if (!marked || !listRef.current) return;
    const list = scrollParent(listRef.current);
    const button = [...listRef.current.querySelectorAll<HTMLElement>("[data-path]")].find((node) => node.dataset.path === marked);
    if (!list || !button) return;
    const listRect = list.getBoundingClientRect();
    const rect = button.getBoundingClientRect();
    const next = revealScroll(list.scrollTop, listRect.top, listRect.bottom, rect.top, rect.bottom);
    if (next !== list.scrollTop) list.scrollTop = next;
  }, [marked]);

  useEffect(() => {
    if (!info || !selectedRef.current || onSelectRef.current) return;
    if (files.some((file) => file.path === selectedRef.current)) return;
    selectedRef.current = "";
    setSelected("");
    setPatch("");
    onOpenRef.current?.(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- shownKey stands for files
  }, [info, shownKey]);

  useEffect(() => {
    if (!reviewNonce) return;
    selectedRef.current = "";
    setSelected("");
    setPatch("");
  }, [reviewNonce]);

  useEffect(() => {
    setArmed(false);
    setRevertNote("");
  }, [scope, session.id]);

  function choose(next: ChangeScope) {
    if (next === scope) return;
    setArmed(false);
    snapshotRef.current = "";
    onScope?.(next);
  }

  async function openFolder() {
    if (opening || !session.cwd) return;
    setOpening(true);
    try {
      await call("/api/folder/open", {});
    } catch {
      // App surfaces the message.
    } finally {
      setOpening(false);
    }
  }

  async function revertChanges() {
    if (reverting || session.status === "running") return;
    if (!armed) {
      setArmed(true);
      return;
    }
    setReverting(true);
    setRevertNote("");
    try {
      const data = await call("/api/git/revert", { paths: files.map((file) => file.path) });
      const skipped = skippedMessages(data);
      setRevertNote(skipped.join(" "));
      setArmed(false);
      try {
        const git = await call("/api/git", { base: scope });
        snapshotRef.current = gitSnapshot(git);
        if (isGitInfo(git)) setInfo(git);
      } catch {
        // The files are already reverted. The next poll refreshes the list.
      }
    } catch {
      setArmed(false);
    } finally {
      setReverting(false);
    }
  }

  async function openFile(file: ListedFile) {
    setArmed(false);
    if (onSelectRef.current) {
      onSelectRef.current(file);
      return;
    }
    if (selected === file.path) {
      selectedRef.current = "";
      setSelected("");
      setPatch("");
      onOpen?.(null);
      return;
    }
    selectedRef.current = file.path;
    setSelected(file.path);
    if (onOpen) {
      onOpen(file);
      return;
    }
    const data = await call("/api/git/diff", { path: file.path, base: scope });
    setPatch(patchText(data));
  }

  const additions = files.reduce((sum, file) => sum + (Number(file.additions) || 0), 0);
  const deletions = files.reduce((sum, file) => sum + (Number(file.deletions) || 0), 0);
  const tools =
    info && (switchable || revertable) ? (
      <div className="git-scope-row">
        {switchable ? (
          <div className="git-scope" role="group" aria-label="Changes to show" data-testid="git-scope">
            <span className="git-scope-thumb" style={{ transform: `translateX(${scope === "main" ? 100 : 0}%)` }} aria-hidden="true" />
            <button type="button" aria-pressed={scope === "head"} disabled={reverting} title="Changes since the last commit" onClick={() => choose("head")}>
              <span>Uncommitted</span>
            </button>
            <button type="button" aria-pressed={scope === "main"} data-testid="git-scope-main" disabled={reverting} title="Changes since this branch left main, committed or not" onClick={() => choose("main")}>
              <span>Branch</span>
            </button>
          </div>
        ) : null}
        {revertable ? (
          <button
            type="button"
            className={armed ? "git-revert is-armed" : "git-revert"}
            data-testid="git-revert"
            title={session.status === "running" ? "Wait until this turn finishes" : revertLabel(armed)}
            aria-label={session.status === "running" ? "Wait until this turn finishes" : revertLabel(armed)}
            disabled={reverting || session.status === "running"}
            onClick={revertChanges}
          >
            <RevertIcon />
            {armed ? <span>Revert?</span> : null}
          </button>
        ) : null}
      </div>
    ) : null;

  return (
    <section className="git-changes" data-testid="git-changes">
      {tools && headSlot ? createPortal(tools, headSlot) : tools}
      <div className="git-changes-head">
      <p className="git-branch">
        <BranchIcon />
        <b className="git-branch-name">{(info?.branch || "Git") as ReactNode}</b>
        {info?.commit ? <span className="git-sha">{info.commit}</span> : null}
        <Stat additions={additions} deletions={deletions} />
        {remotePage() ? null : (
          <button
            type="button"
            className="git-open-folder"
            data-testid="open-folder"
            title="Open folder"
            aria-label="Open folder"
            disabled={opening || !session.cwd}
            onClick={openFolder}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M1.8 4.4c0-.8.6-1.4 1.4-1.4h3.2l1.3 1.5h5.1c.8 0 1.4.6 1.4 1.4v6.1c0 .8-.6 1.4-1.4 1.4H3.2c-.8 0-1.4-.6-1.4-1.4V4.4Z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )}
      </p>
      </div>
      <div className="git-changes-scroll">
      {revertNote ? <p className="git-revert-note" data-testid="git-revert-note">{revertNote}</p> : null}
      {info?.error ? <p className="muted">{info.error}</p> : null}
      {info && !info.error && infoScope === scope && files.length === 0 ? (
        <p className="muted" data-testid="git-empty">
          No changes
        </p>
      ) : null}
      <ul ref={listRef}>
        {files.map((file) => (
          <li key={file.path as string}>
            <button
              type="button"
              data-path={file.path}
              aria-current={marked === file.path ? "true" : undefined}
              className={marked === file.path ? "active" : ""}
              onClick={() => openFile(file)}
            >
              <span className="git-path">
                <span className="git-dir">{String(file.path).slice(0, String(file.path).lastIndexOf("/") + 1)}</span>
                {String(file.path).slice(String(file.path).lastIndexOf("/") + 1)}
              </span>
              <Stat additions={file.additions} deletions={file.deletions} />
            </button>
            {selected === file.path && !onOpen ? <Patch text={patch} /> : null}
          </li>
        ))}
      </ul>
      </div>
    </section>
  );
}

function Patch({ text }: { text: string }) {
  if (!text) return <p className="muted">No patch</p>;
  return (
    <pre className="git-patch" data-testid="git-patch">
      {text.split("\n").map((line, index) => (
        <span key={index} className={lineClass(line)}>
          {line || " "}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}

function Stat({ additions, deletions }: { additions: unknown; deletions: unknown }) {
  return (
    <span className="git-stat">
      {additions ? <span className="add">+{additions as ReactNode}</span> : null}
      {deletions ? <span className="del">−{deletions as ReactNode}</span> : null}
    </span>
  );
}

function BranchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="7" cy="6" r="2.2" />
      <circle cx="7" cy="18" r="2.2" />
      <circle cx="17" cy="8" r="2.2" />
      <path d="M7 8.2v7.6M17 10.2c0 3.8-4 4.3-9.2 6.1" />
    </svg>
  );
}

function scrollParent(node: HTMLElement): HTMLElement | null {
  let parent = node.parentElement;
  while (parent) {
    const overflow = getComputedStyle(parent).overflowY;
    if (overflow === "auto" || overflow === "scroll") return parent;
    parent = parent.parentElement;
  }
  return null;
}

function revertLabel(armed: boolean): string {
  return armed ? "Revert all changes?" : "Revert all changes";
}

function RevertIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11" />
    </svg>
  );
}

function lineClass(line: string): string {
  if (line.startsWith("+") && !line.startsWith("+++")) return "add";
  if (line.startsWith("-") && !line.startsWith("---")) return "del";
  if (line.startsWith("@@")) return "meta";
  return "";
}
