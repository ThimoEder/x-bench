import { useEffect, useRef, useState } from "react";
import type { ComposerCatalog } from "../../server/snapshot.ts";
import { BranchMenu } from "../git/BranchMenu.tsx";
import { OptionMenu } from "../OptionMenu.tsx";
import { isRecord, messageOf, type BoardCall } from "./boardData.ts";
import { composerOptions, draftChoice, withPick, type DraftPicks } from "../chat/composer/draftConfig.ts";
import { createDraftWorktree, type WorktreePlan } from "../folder/draftWorktree.ts";

export interface ThreadSheetProps {
  cwd: string;
  taskId: unknown;
  title: string;
  call: BoardCall;
  catalog: ComposerCatalog;
  picks: DraftPicks;
  onPick: (id: string, value: string) => void;
  // The worktree box as a new chat starts, and whether the started chat had it ticked.
  worktree: WorktreePlan;
  onWorktree: (on: boolean) => void;
  onStarted: () => void;
  onCancel: () => void;
}

export function ThreadSheet({ cwd, taskId, title, call, catalog, picks: firstPicks, onPick, worktree, onWorktree, onStarted, onCancel }: ThreadSheetProps) {
  const [prompt, setPrompt] = useState<string | null>(null);
  const [hidden, setHidden] = useState(0);
  // The ticket's own title, which names a new worktree.
  const [ticketTitle, setTicketTitle] = useState("");
  // Where the chat runs: the board's folder, another worktree, or the worktree a failed start already made.
  const [place, setPlace] = useState({ cwd, worktree });
  const [picks, setPicks] = useState<DraftPicks>(firstPicks);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancel = false;
    call(`/api/board/tasks/${encodeURIComponent(String(taskId))}/brief?${new URLSearchParams({ cwd })}`, null, "GET", { silent: true })
      .then((data) => {
        if (cancel) return;
        if (!isRecord(data) || typeof data.draft !== "string") throw new Error("Couldn't read the ticket");
        setPrompt(data.draft);
        setHidden(typeof data.hidden === "number" ? data.hidden : 0);
        setTicketTitle(typeof data.title === "string" ? data.title : "");
      })
      .catch((failure: unknown) => {
        if (cancel) return;
        setError(messageOf(failure) || "Couldn't read the ticket");
        setPrompt("");
      });
    return () => {
      cancel = true;
    };
  }, [call, cwd, taskId]);

  // Esc closes the sheet from wherever focus is. It looks before the menus do, since a menu closes itself on
  // the same Esc and the page has already updated by the time a later listener runs; an open menu keeps it.
  const sheet = useRef<HTMLFormElement | null>(null);
  const escape = useRef({ busy, openMenu, onCancel });
  escape.current = { busy, openMenu, onCancel };
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const { busy, openMenu, onCancel } = escape.current;
      if (event.key !== "Escape" || busy || openMenu || sheet.current?.querySelector(".branch-menu.open")) return;
      // Handled, so the ticket under the sheet stays open.
      event.preventDefault();
      onCancel();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  async function start() {
    const text = prompt?.trim();
    if (!text || busy) return;
    setBusy(true);
    setError("");
    const choice = draftChoice(catalog, picks);
    try {
      const moved = await createDraftWorktree(place, choice?.provider, ticketTitle || text, call);
      setPlace(moved);
      await call("/api/board/threads", { cwd: moved.cwd, taskId, prompt: text, session: choice ?? {} }, "POST", { silent: true });
      onWorktree(place.worktree.on || Boolean(place.worktree.made));
      onStarted();
    } catch (failure) {
      setError(messageOf(failure) || "Couldn't start the chat");
      setBusy(false);
    }
  }

  function pick(id: string, value: string) {
    setPicks((current) => withPick(catalog, current, id, value));
    onPick(id, value);
  }

  return (
    <div
      className="sheet-scrim"
      onClick={() => !busy && onCancel()}
    >
      <form
        ref={sheet}
        className="sheet thread-sheet"
        role="dialog"
        aria-labelledby="thread-sheet-title"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          start();
        }}
      >
        <h2 id="thread-sheet-title">New chat</h2>
        <p className="sheet-copy">{title}</p>
        {hidden > 0 ? (
          <p className="thread-note">
            {hidden === 1 ? "1 hidden character was removed from this ticket." : `${hidden} hidden characters were removed from this ticket.`}
          </p>
        ) : null}
        <textarea
          className="thread-prompt"
          aria-label="Prompt"
          value={prompt ?? ""}
          placeholder={prompt === null && !error ? "Reading the ticket…" : "What should the chat do?"}
          readOnly={prompt === null || busy}
          rows={12}
          autoFocus
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              start();
            }
          }}
        />
        {error ? <p className="sheet-error">{error}</p> : null}
        <div className="thread-foot">
          <fieldset className="thread-picks" disabled={busy}>
            <BranchMenu
              call={call}
              cwd={place.cwd}
              unscoped
              worktree={place.worktree}
              onWorktree={(plan) => setPlace((current) => ({ ...current, worktree: plan }))}
              onOpenFolder={(next) => {
                if (next) setPlace({ cwd: next, worktree: { on: false, gitRef: "" } });
              }}
            />
            <span className="thread-model">
              {composerOptions(catalog, picks).map((option) => (
                <OptionMenu
                  key={option.id}
                  entry={{ option, onChange: (value) => pick(option.id, value) }}
                  open={openMenu === option.id}
                  onToggle={() => setOpenMenu((current) => (current === option.id ? null : option.id))}
                  onClose={() => setOpenMenu(null)}
                />
              ))}
            </span>
          </fieldset>
          <button type="button" className="text-button" disabled={busy} onClick={onCancel}>Cancel</button>
          <button type="submit" className="primary" disabled={busy || !prompt?.trim()}>
            {busy ? "Starting…" : "Start chat"}
          </button>
        </div>
      </form>
    </div>
  );
}
