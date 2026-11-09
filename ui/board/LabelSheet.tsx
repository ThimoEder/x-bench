import { useState } from "react";
import type { FormEvent } from "react";
import { TrashIcon } from "./boardIcons.tsx";
import {
  canDo,
  cssValue,
  isDetailTask,
  isRecord,
  keyOf,
  labelIn,
  LIST_COLORS,
  messageOf,
  nodeOf,
  sameId,
  type BoardCall,
  type BoardLabel,
  type BoardView,
  type DetailTask,
} from "./boardData.ts";

export interface LabelSheetProps {
  board: BoardView;
  cwd: string;
  call: BoardCall;
  // The open ticket, which a new label also goes on, or null.
  taskId: unknown;
  onAdded: (label: BoardLabel, task: DetailTask | null) => void;
  onDeleted: (label: BoardLabel) => void;
  onClose: () => void;
}

export function LabelSheet({ board, cwd, call, taskId, onAdded, onDeleted, onClose }: LabelSheetProps) {
  const labels = (board.labels || []).filter((label) => label.title);
  const colors = canDo(board, "labelColors");
  const deletes = canDo(board, "labelDeletes");
  const onTicket = taskId !== null && taskId !== undefined;
  const adds = onTicket || canDo(board, "standaloneLabels");
  const copy = [
    "Every label on this board.",
    adds && colors ? "Pick a new label's color as you add it." : "",
    onTicket ? "A new label also goes on the open ticket." : "",
  ].filter(Boolean).join(" ");
  const [name, setName] = useState("");
  const [color, setColor] = useState<string | null>(null);
  const [palette, setPalette] = useState(false);
  const [asking, setAsking] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = name.trim();
    if (!title || busy) return;
    if (labels.some((label) => label.title === title)) {
      setError(`“${title}” is already a label.`);
      return;
    }
    setBusy(true);
    setError("");
    setPalette(false);
    try {
      const result = await call("/api/board/labels", { cwd, title, color: colors ? color : null, ...(onTicket ? { taskId } : {}) }, "POST", { silent: true });
      const label = isRecord(result) ? labelIn(result.label) : undefined;
      if (!label) throw new Error("Request failed");
      onAdded(label, isRecord(result) && isDetailTask(result.task) ? result.task : null);
      setName("");
      setColor(null);
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  }

  async function remove(label: BoardLabel) {
    setBusy(true);
    setError("");
    try {
      await call(`/api/board/labels/${encodeURIComponent(String(label.id))}`, { cwd }, "DELETE", { silent: true });
      onDeleted(label);
      setAsking(null);
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="sheet-scrim"
      onClick={() => !busy && onClose()}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) onClose();
      }}
    >
      <div className="sheet is-small label-sheet" role="dialog" aria-labelledby="label-sheet-title" onClick={(event) => event.stopPropagation()}>
        <h2 id="label-sheet-title">Labels</h2>
        <p className="sheet-copy">{copy}</p>
        {labels.length ? (
          <ul className="label-rows">
            {labels.map((label) =>
              sameId(asking, label.id) ? (
                <li key={keyOf(label.id)} className="label-row is-asking">
                  <span>
                    Delete <strong>{nodeOf(label.title)}</strong>? It comes off every ticket.
                  </span>
                  <button type="button" className="text-button" disabled={busy} onClick={() => setAsking(null)}>Cancel</button>
                  <button type="button" className="danger-fill" disabled={busy} autoFocus onClick={() => remove(label)}>Delete</button>
                </li>
              ) : (
                <li key={keyOf(label.id)} className="label-row">
                  <span className="board-pill" style={label.color ? { "--pill": cssValue(label.color) } : undefined}>{nodeOf(label.title)}</span>
                  {deletes ? (
                    <button type="button" className="icon" aria-label={`Delete ${String(label.title)}`} title="Delete" disabled={busy} onClick={() => setAsking(label.id)}>
                      <TrashIcon />
                    </button>
                  ) : null}
                </li>
              ),
            )}
          </ul>
        ) : (
          <p className="board-quiet">No labels on this board yet.</p>
        )}
        {adds ? (
          <>
            <form className="label-new board-label-add" onSubmit={add}>
              {colors ? (
                <button
                  type="button"
                  className={color ? "label-swatch" : "label-swatch is-none"}
                  disabled={busy}
                  style={color ? { background: color } : undefined}
                  aria-label="Color for the new label"
                  aria-expanded={palette}
                  onClick={() => setPalette((value) => !value)}
                />
              ) : null}
              <input aria-label="New label" placeholder="New label" maxLength={40} value={name} readOnly={busy} autoFocus onChange={(event) => setName(event.target.value)} />
              <button type="submit" className="primary" disabled={busy || !name.trim()}>Add</button>
            </form>
            {colors && palette ? (
              <div className="column-palette label-palette" role="listbox" aria-label="Colors for the new label">
                {LIST_COLORS.map(([colorName, hex]) => (
                  <button
                    key={colorName}
                    type="button"
                    role="option"
                    aria-label={colorName}
                    aria-selected={color === hex}
                    className={color === hex ? "is-picked" : ""}
                    style={{ background: hex }}
                    onClick={() => {
                      setColor(hex);
                      setPalette(false);
                    }}
                  />
                ))}
                <button
                  type="button"
                  role="option"
                  aria-label="No color"
                  aria-selected={!color}
                  className={color ? "is-none" : "is-none is-picked"}
                  onClick={() => {
                    setColor(null);
                    setPalette(false);
                  }}
                />
              </div>
            ) : null}
          </>
        ) : (
          <p className="board-quiet">Add a new label from a ticket's + Label.</p>
        )}
        {error ? <p className="sheet-error">{error}</p> : null}
        <div className="sheet-actions">
          <button type="button" className="text-button" disabled={busy} onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
