import { useState, type FormEvent } from "react";
import { checked, isSavedTask, messageOf, type BoardCall, type Checklist, type DetailTask } from "./boardData.ts";
import { PlusIcon } from "./boardIcons.tsx";

// Every reply carries the whole ticket, so the ticket's checklist saves run one at a time and their replies land in order.
export type SaveQueue = <T>(save: () => Promise<T>) => Promise<T>;

export function saveQueue(): SaveQueue {
  let last: Promise<unknown> = Promise.resolve();
  return (save) => {
    const next = last.then(save);
    last = next.catch(() => undefined);
    return next;
  };
}

export interface ChecklistSectionProps {
  taskId: unknown;
  list: Checklist;
  call: BoardCall;
  queue: SaveQueue;
  onChanged: (task: DetailTask) => void;
  onError: (message: string) => void;
}

// One checklist of the open ticket. A ticked box shows at once and goes back when the save fails.
export function ChecklistSection({ taskId, list, call, queue, onChanged, onError }: ChecklistSectionProps) {
  const [ticking, setTicking] = useState<Record<string, boolean>>({});
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const base = `/api/board/tasks/${encodeURIComponent(String(taskId))}`;
  const items = list.items.map((item) => (item.id in ticking ? { ...item, done: ticking[item.id] === true } : item));
  const done = items.filter((item) => item.done).length;

  async function tick(id: string, value: boolean) {
    if (id in ticking) return;
    setTicking((current) => ({ ...current, [id]: value }));
    try {
      onChanged(checked(await queue(() => call(`${base}/check-items/${id}`, { done: value }, "PUT", { silent: true })), isSavedTask).task);
    } catch (failure) {
      onError(messageOf(failure));
    } finally {
      setTicking(({ [id]: _settled, ...rest }) => rest);
    }
  }

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = title.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      onChanged(checked(await queue(() => call(`${base}/checklists/${list.id}/items`, { title: name }, "POST", { silent: true })), isSavedTask).task);
      setTitle("");
    } catch (failure) {
      onError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section data-testid="ticket-checklist">
      <h3 className="ticket-h">
        {list.title || "Checklist"}
        <span className="ticket-count">{`${done} of ${items.length} done`}</span>
        {items.length ? (
          <span className="ticket-progress" aria-hidden="true">
            <i style={{ width: `${Math.round((done / items.length) * 100)}%` }} />
          </span>
        ) : null}
      </h3>
      <div className="ticket-rows">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            role="checkbox"
            aria-checked={item.done}
            className={item.done ? "ticket-row ticket-check is-done" : "ticket-row ticket-check"}
            onClick={() => tick(item.id, !item.done)}
          >
            <span className="ticket-check-box" aria-hidden="true" />
            <span className="ticket-row-title">{item.title}</span>
          </button>
        ))}
        {adding ? (
          <form className="board-label-add" onSubmit={add}>
            <input
              aria-label={`Add an item to ${list.title || "the checklist"}`}
              value={title}
              placeholder="Add an item"
              maxLength={400}
              autoFocus
              disabled={busy}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setAdding(false);
                  setTitle("");
                }
              }}
              onBlur={() => {
                if (!title.trim()) setAdding(false);
              }}
            />
          </form>
        ) : (
          <button type="button" className="ticket-row ticket-check-add" onClick={() => setAdding(true)}>
            <PlusIcon size={12} />
            <span>Add an item</span>
          </button>
        )}
      </div>
    </section>
  );
}
