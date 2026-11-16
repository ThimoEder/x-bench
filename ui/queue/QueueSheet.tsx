import { useEffect, useRef, useState } from "react";
import { DEFAULT_SLOTS, FINISH_LABELS, FINISH_MODES, MAX_SLOTS, type FinishMode } from "../../server/queue/queuePlan.ts";
import type { QueuePlan } from "../../server/queue/queueRead.ts";
import type { ComposerCatalog } from "../../server/snapshot.ts";
import { OptionMenu } from "../OptionMenu.tsx";
import { ThreadSheet } from "../board/ThreadSheet.tsx";
import { EditIcon } from "../board/boardIcons.tsx";
import { isRecord, messageOf, type BoardCall } from "../board/boardData.ts";
import { composerOptions, draftChoice, withPick, type DraftPicks } from "../chat/composer/draftConfig.ts";

export interface QueueSheetProps {
  cwd: string;
  taskId: unknown;
  title: string;
  call: BoardCall;
  catalog: ComposerCatalog;
  picks: DraftPicks;
  onPick: (id: string, value: string) => void;
  onStarted: () => void;
  onCancel: () => void;
  // The sub-tickets the ticket's page shows already, which the sheet draws while it reads their order.
  known?: KnownTicket[];
}

export type KnownTicket = Pick<QueuePlan["items"][number], "id" | "title" | "done">;

const MODE_HINTS: Record<FinishMode, string> = {
  merged: "The next chat starts from the latest main once the pull request before it is merged.",
  pr: "The next chat starts from the branch before it as soon as its pull request opens, as stacked pull requests.",
};

const MAIN = "main";

function isPlan(value: unknown): value is QueuePlan {
  return isRecord(value) && Array.isArray(value.items) && Array.isArray(value.outside);
}

// The prerequisites that are no sub-ticket of the parent, each as done, queued in another run, or not queued.
function OutsideTickets({ outside }: { outside: QueuePlan["outside"] }) {
  return (
    <div className="queue-outside" data-testid="queue-outside">
      <p>Waits on tickets outside this one:</p>
      <ul>
        {outside.map((ticket) => (
          <li key={ticket.id}>
            <span className="queue-id">{ticket.id}</span>
            <span className="queue-title">{ticket.title}</span>
            <span className="queue-needs">{ticket.done ? "Done" : ticket.queued ? "Queued" : "Not queued"}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Esc closes the sheet from wherever focus is, unless held: while it starts, or a menu or the prompt's own sheet is open over it.
function useEscape(held: boolean, onCancel: () => void) {
  const latest = useRef({ held, onCancel });
  latest.current = { held, onCancel };
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape" || latest.current.held) return;
      // Handled, so the ticket under the sheet stays open.
      event.preventDefault();
      latest.current.onCancel();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}

// A ticket's sub-tasks as its page holds them, for the rows the sheet draws while the order loads.
export function knownTickets(subtasks: unknown): KnownTicket[] {
  if (!Array.isArray(subtasks)) return [];
  return subtasks.flatMap((item) => (isRecord(item) && item.id ? [{ id: String(item.id), title: String(item.title ?? ""), done: item.done === true }] : []));
}

export function QueueSheet({ cwd, taskId, title, call, catalog, picks: firstPicks, onPick, onStarted, onCancel, known = [] }: QueueSheetProps) {
  const [plan, setPlan] = useState<QueuePlan | null>(null);
  const [mode, setMode] = useState<FinishMode>("merged");
  const [slots, setSlots] = useState(DEFAULT_SLOTS);
  const [picks, setPicks] = useState<DraftPicks>(firstPicks);
  // The model and effort picked for the main chat (MAIN) or one sub-ticket, in place of the run's.
  const [own, setOwn] = useState<Record<string, DraftPicks>>({});
  // A sub-ticket's prompt, where it was edited.
  const [prompts, setPrompts] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<QueuePlan["items"][number] | null>(null);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancel = false;
    call("/api/queues/check", { taskId }, "POST", { silent: true })
      .then((data) => {
        if (cancel) return;
        if (!isRecord(data) || !isPlan(data.plan)) throw new Error("Couldn't read the sub-tickets");
        setPlan(data.plan);
      })
      .catch((failure: unknown) => {
        if (!cancel) setError(messageOf(failure) || "Couldn't read the sub-tickets");
      });
    return () => {
      cancel = true;
    };
  }, [call, taskId]);

  const open = plan?.items.filter((item) => !item.done) ?? [];
  const rows = plan?.items ?? known.map((item) => ({ ...item, needs: [] }));
  const reading = !plan && !error;
  const refusal = !plan ? "" : plan.cycle ? `These tickets wait on each other: ${plan.cycle.join(" → ")}` : open.length ? "" : "Every sub-ticket is done";

  async function start() {
    if (busy || !plan || refusal) return;
    setBusy(true);
    setError("");
    try {
      const run = draftChoice(catalog, picks);
      const other = (id: string) => {
        const choice = own[id] ? draftChoice(catalog, own[id]) : null;
        return choice && JSON.stringify(choice) !== JSON.stringify(run) ? choice : null;
      };
      const tickets = Object.fromEntries(open.flatMap((item) => {
        const changed = { ...(other(item.id) ? { picks: other(item.id) } : {}), ...(prompts[item.id] ? { prompt: prompts[item.id] } : {}) };
        return Object.keys(changed).length ? [[item.id, changed]] : [];
      }));
      await call("/api/queues", { cwd, taskId, mode, slots, session: run ?? {}, ...(other(MAIN) ? { main: other(MAIN) } : {}), tickets }, "POST", { silent: true });
      onStarted();
    } catch (failure) {
      setError(messageOf(failure) || "Couldn't start the run");
      setBusy(false);
    }
  }

  function pickMenus(id: string, label: string) {
    return (
      <fieldset className="thread-picks queue-model" disabled={busy}>
        {composerOptions(catalog, own[id] ?? picks).map((option) => (
          <OptionMenu
            key={option.id}
            entry={{ option: { ...option, name: `${option.name} for ${label}` }, onChange: (value) => setOwn((current) => ({ ...current, [id]: withPick(catalog, current[id] ?? picks, option.id, value) })) }}
            open={openMenu === `${option.id}:${id}`}
            onToggle={() => setOpenMenu((current) => (current === `${option.id}:${id}` ? null : `${option.id}:${id}`))}
            onClose={() => setOpenMenu(null)}
          />
        ))}
      </fieldset>
    );
  }

  useEscape(busy || Boolean(openMenu) || Boolean(editing), onCancel);

  return (
    <>
    <div className="sheet-scrim" onClick={() => !busy && onCancel()}>
      <form
        className="sheet thread-sheet queue-sheet"
        role="dialog"
        aria-labelledby="queue-sheet-title"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          start();
        }}
      >
        <h2 id="queue-sheet-title">Run sub-tickets</h2>
        <p className="sheet-copy">{`${title}. Each sub-ticket gets a chat in a worktree of its own, once the tickets it waits on are finished. A main chat on this ticket answers your questions.`}</p>
        {rows.length ? (
          <ol className="queue-plan" data-testid="queue-plan" aria-busy={reading}>
            <li>
              <span className="queue-title">Main chat</span>
              {pickMenus(MAIN, "the main chat")}
            </li>
            {rows.map((item) => (
              <li key={item.id} className={item.done ? "is-done" : ""}>
                <span className="queue-id">{item.id}</span>
                <span className="queue-title">{item.title}</span>
                <span className="queue-needs">{item.done ? "Done" : item.needs.length ? `after ${item.needs.join(", ")}` : ""}</span>
                {reading && !item.done ? <i className="skeleton-line queue-reading" data-testid="queue-reading" /> : null}
                {item.done ? null : (
                  <>
                    {pickMenus(item.id, `ticket ${item.id}`)}
                    <button
                      type="button"
                      className={prompts[item.id] ? "queue-prompt is-edited" : "queue-prompt"}
                      data-testid="queue-prompt"
                      aria-label={`${prompts[item.id] ? "Edit the edited prompt" : "Edit the prompt"} for ticket ${item.id}`}
                      title={prompts[item.id] ? "Prompt edited" : "Edit prompt"}
                      disabled={busy}
                      onClick={() => setEditing(item)}
                    >
                      <EditIcon />
                    </button>
                  </>
                )}
              </li>
            ))}
          </ol>
        ) : error ? null : (
          <p className="sheet-copy">Reading the sub-tickets…</p>
        )}
        {plan?.outside.length ? <OutsideTickets outside={plan.outside} /> : null}
        <div className="sheet-field">
          <span>A sub-ticket is finished when its pull request is</span>
          <div className="sheet-switch routine-switch" role="radiogroup" aria-label="Finish mode">
            {FINISH_MODES.map((item) => (
              <button key={item} type="button" role="radio" aria-checked={mode === item} className={mode === item ? "is-picked" : ""} disabled={busy} onClick={() => setMode(item)}>
                {FINISH_LABELS[item]}
              </button>
            ))}
          </div>
          <span className="queue-hint">{MODE_HINTS[mode]}</span>
        </div>
        <label className="sheet-field queue-slots">
          Chats at once
          <input type="number" min={1} max={MAX_SLOTS} value={slots} disabled={busy} onChange={(event) => setSlots(Math.min(MAX_SLOTS, Math.max(1, Math.round(Number(event.target.value)) || 1)))} />
        </label>
        {refusal || error ? <p className="sheet-error">{refusal || error}</p> : null}
        <div className="thread-foot">
          <fieldset className="thread-picks" disabled={busy}>
            <span className="thread-model">
              {composerOptions(catalog, picks).map((option) => (
                <OptionMenu
                  key={option.id}
                  entry={{
                    option,
                    onChange: (value) => {
                      setPicks((current) => withPick(catalog, current, option.id, value));
                      onPick(option.id, value);
                    },
                  }}
                  open={openMenu === option.id}
                  onToggle={() => setOpenMenu((current) => (current === option.id ? null : option.id))}
                  onClose={() => setOpenMenu(null)}
                />
              ))}
            </span>
          </fieldset>
          <button type="button" className="text-button" disabled={busy} onClick={onCancel}>Cancel</button>
          <button type="submit" className="primary" data-testid="queue-start" disabled={busy || !plan || Boolean(refusal)}>
            {busy ? "Starting…" : "Start run"}
          </button>
        </div>
      </form>
    </div>
    {editing ? (
      <ThreadSheet
        cwd={cwd}
        taskId={editing.id}
        title={`${editing.id} ${editing.title}`}
        call={call}
        catalog={catalog}
        picks={own[editing.id] ?? picks}
        onPick={() => {}}
        worktree={{ on: false, gitRef: "" }}
        onWorktree={() => {}}
        onStarted={() => {}}
        onCancel={() => setEditing(null)}
        edit={{
          prompt: prompts[editing.id] ?? null,
          onSave(prompt, next) {
            setOwn((current) => ({ ...current, [editing.id]: next }));
            setPrompts((current) => {
              const rest = { ...current };
              delete rest[editing.id];
              return prompt ? { ...rest, [editing.id]: prompt } : rest;
            });
            setEditing(null);
          },
        }}
      />
    ) : null}
    </>
  );
}
