import { useState } from "react";
import {
  canDo,
  cardBadge,
  checked,
  columnFor,
  columnTone,
  isSavedTask,
  linkedList,
  messageOf,
  nodeOf,
  relationKinds,
  type BoardCall,
  type BoardView,
  type DetailTask,
  type Linked,
} from "./boardData.ts";
import { AlertIcon, PlusIcon, TypeIcon } from "./boardIcons.tsx";

export interface RelationsProps {
  board: BoardView;
  task: DetailTask;
  call: BoardCall;
  onChanged: (task: DetailTask) => void;
  onOpen: (taskId: unknown) => void;
}

export function relationLabel(kind: string): string {
  const text = kind.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// The open ticket's linked tickets and sub-tasks, which a board that writes relations adds and removes here.
export function RelationsSection({ board, task, call, onChanged, onOpen }: RelationsProps) {
  const kinds = relationKinds(board);
  const related = linkedList(task.related);
  const subtasks = canDo(board, "subtasks") ? linkedList(task.subtasks) : [];
  const doneSubtasks = subtasks.filter((item) => item.done).length;
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState("");
  const [otherId, setOtherId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const base = `/api/board/tasks/${encodeURIComponent(String(task.id))}/relations`;
  const picked = kinds.includes(kind) ? kind : (kinds[0] ?? "");

  async function change(request: () => Promise<unknown>) {
    if (busy) return false;
    setBusy(true);
    setError("");
    try {
      onChanged(checked(await request(), isSavedTask).task);
      return true;
    } catch (failure) {
      setError(messageOf(failure) || "Couldn't change the relation");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function add() {
    const other = otherId.trim().replace(/^#/, "");
    if (!other || !picked) return;
    if (await change(() => call(base, { otherTaskId: other, kind: picked }, "PUT", { silent: true }))) close();
  }

  // A row's Remove, when the board writes the relation that row shows.
  function removal(item: Linked) {
    const relation = item.relation;
    if (!relation || !kinds.includes(relation)) return undefined;
    return () => { change(() => call(`${base}/${encodeURIComponent(String(item.id))}/${relation}`, null, "DELETE", { silent: true })); };
  }

  function close() {
    setAdding(false);
    setOtherId("");
    setError("");
  }

  return (
    <>
      {related.length || kinds.length ? (
        <section>
          <h3 className="ticket-h">
            Linked tickets
            {kinds.length ? (
              <button
                type="button"
                className={`text-button ticket-link-add${adding ? " is-on" : ""}`}
                title="Link a ticket"
                aria-label="Link a ticket"
                aria-expanded={adding}
                onClick={() => (adding ? close() : setAdding(true))}
              >
                <PlusIcon />
              </button>
            ) : null}
          </h3>
          {adding ? (
            <form
              className="ticket-link-form"
              onSubmit={(event) => {
                event.preventDefault();
                add();
              }}
            >
              <div className="ticket-link-line">
                <select aria-label="Relation" value={picked} onChange={(event) => setKind(event.target.value)}>
                  {kinds.map((item) => <option key={item} value={item}>{relationLabel(item)}</option>)}
                </select>
                <input
                  aria-label="Other ticket"
                  className={error ? "is-bad" : undefined}
                  value={otherId}
                  placeholder="Ticket id"
                  maxLength={80}
                  autoFocus
                  spellCheck={false}
                  onChange={(event) => {
                    setOtherId(event.target.value);
                    setError("");
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") close();
                  }}
                />
                <button type="submit" className="primary" disabled={busy || !otherId.trim()}>Link</button>
              </div>
            </form>
          ) : null}
          {error ? (
            <p className="ticket-link-alert" role="alert">
              <AlertIcon />
              {error}
            </p>
          ) : null}
          <div className="ticket-rows">
            {related.map((item) => (
              <LinkedRow key={`${item.kind}-${String(item.id)}`} board={board} item={item} onOpen={onOpen} onRemove={removal(item)} busy={busy} />
            ))}
          </div>
        </section>
      ) : null}
      {subtasks.length ? (
        <section>
          <h3 className="ticket-h">
            Sub-tasks
            <span className="ticket-count">{`${doneSubtasks} of ${subtasks.length} done`}</span>
            <span className="ticket-progress" aria-hidden="true">
              <i style={{ width: `${Math.round((doneSubtasks / subtasks.length) * 100)}%` }} />
            </span>
          </h3>
          <div className="ticket-rows">
            {subtasks.map((item) => (
              <LinkedRow key={String(item.id)} board={board} item={item} subtask onOpen={onOpen} onRemove={removal(item)} busy={busy} />
            ))}
          </div>
        </section>
      ) : null}
    </>
  );
}

interface LinkedRowProps {
  board: BoardView;
  item: Linked;
  subtask?: boolean;
  onOpen: (taskId: unknown) => void;
  onRemove?: () => void;
  // A relation change is running, so Remove waits for it.
  busy?: boolean;
}

export function LinkedRow({ board, item, subtask, onOpen, onRemove, busy }: LinkedRowProps) {
  const column = columnFor(board.columns, item.status);
  const key = cardBadge(board, { id: item.id });
  const tone = column ? columnTone(column) : item.done ? "var(--status-done)" : "var(--status-open)";
  const body = (
    <>
      {subtask ? (canDo(board, "types") ? <TypeIcon type="subtask" /> : null) : <span className="ticket-rel">{item.kind}</span>}
      <span className="ticket-row-key">{key}</span>
      <span className="ticket-row-title">{item.title}</span>
      {item.status !== null ? (
        <span className="ticket-state" style={{ "--tone": tone }}>{nodeOf(column?.title ?? item.status)}</span>
      ) : null}
    </>
  );
  if (!onRemove) return <button type="button" className="ticket-row" onClick={() => onOpen(item.id)}>{body}</button>;
  return (
    <div className="ticket-row">
      <button type="button" className="ticket-row-main" onClick={() => onOpen(item.id)}>{body}</button>
      <button type="button" className="text-button ticket-unlink" aria-label={`Remove the link to ${String(item.id)}`} disabled={busy} onClick={onRemove}>
        Remove
      </button>
    </div>
  );
}
