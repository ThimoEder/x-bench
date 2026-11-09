import { useCallback, useRef, useState } from "react";
import type { DragEvent, KeyboardEvent } from "react";
import { columnStatus, NO_SETTINGS, resolveMoves, type BoardSettings, type ColumnSettings, type MoveColumn, type MoveKey } from "../../server/board/boardSettings.ts";
import { CloseIcon } from "../icons.tsx";
import { EyeIcon, GripIcon } from "./boardIcons.tsx";
import {
  boardSettings,
  columnTone,
  keyOf,
  LIST_COLORS,
  nodeOf,
  taskStatus,
  type BoardCall,
  type BoardColumn,
  type BoardView,
} from "./boardData.ts";

// The board's settings as a board load last answered them, and the saves that change them. A save shows at once. A
// refused one shows in the error banner, takes the page back to the settings the host has, and loads the board again.
export function useBoardSettings(cwd: string, call: BoardCall, onRefused: () => void) {
  const [settings, setSettings] = useState<BoardSettings>(NO_SETTINGS);
  // A save sends the whole settings, so an answer older than the page's own state must not replace it.
  const saving = useRef(0);
  // The settings the host has: what a load last answered or a save last stored.
  const confirmed = useRef(NO_SETTINGS);
  // Saves go out one after another, so the newest settings reach the host last.
  const sent = useRef<Promise<unknown>>(Promise.resolve());
  const take = useCallback((value: unknown) => {
    const next = boardSettings(value);
    if (!next) return;
    confirmed.current = next;
    if (!saving.current) setSettings(next);
  }, []);

  async function send(next: BoardSettings, method: string) {
    setSettings(next);
    saving.current += 1;
    const save = sent.current.then(() => call("/api/board/settings", { cwd, ...(method === "PUT" ? { settings: next } : {}) }, method));
    sent.current = save.catch(() => {});
    try {
      await save;
      confirmed.current = next;
    } catch {
      // A later save still on its way carries this change too.
      if (saving.current === 1) setSettings(confirmed.current);
      onRefused();
    } finally {
      saving.current -= 1;
    }
  }

  const save = (next: BoardSettings) => send(next, "PUT");
  return {
    settings,
    take,
    save,
    setColumn(column: BoardColumn, change: ColumnSettings) {
      const status = columnStatus(column.value);
      return save({ ...settings, columns: { ...settings.columns, [status]: { ...settings.columns[status], ...change } } });
    },
    reset: () => send(NO_SETTINGS, "DELETE"),
  };
}

export interface BoardSettingsPaneProps {
  // The board with its settings applied, so its columns come in their order and colors.
  board: BoardView;
  // The columns in the source's order, in which a move finds its column by name.
  source: BoardColumn[];
  settings: BoardSettings;
  onSave: (settings: BoardSettings) => void;
  onReset: () => void;
  onPaint: (column: BoardColumn, color: string | null) => void;
  onClose: () => void;
}

export function BoardSettingsPane({ board, source, settings, onSave, onReset, onPaint, onClose }: BoardSettingsPaneProps) {
  return (
    <aside className="board-settings" aria-labelledby="board-settings-title">
      <header>
        <h2 id="board-settings-title">Board settings</h2>
        <button type="button" className="icon" aria-label="Close board settings" title="Close" autoFocus onClick={onClose}>
          <CloseIcon />
        </button>
      </header>
      <ColumnList board={board} settings={settings} onSave={onSave} onPaint={onPaint} />
      <MoveList board={board} source={source} settings={settings} onSave={onSave} />
      <div className="sheet-actions">
        <button type="button" className="text-button" onClick={onReset}>Reset</button>
      </div>
    </aside>
  );
}

// picked is the column's color name, empty for none.
export function ColumnPalette({ title, picked, onPick }: { title: string; picked: unknown; onPick: (name: string | null) => void }) {
  return (
    <div className="column-palette" role="listbox" aria-label={`Colors for ${title}`}>
      {LIST_COLORS.map(([name, hex]) => (
        <button
          key={name}
          type="button"
          role="option"
          aria-label={name}
          aria-selected={picked === name}
          className={picked === name ? "is-picked" : ""}
          style={{ background: hex }}
          onClick={() => onPick(name)}
        />
      ))}
      <button type="button" role="option" aria-label="No color" aria-selected={!picked} className={picked ? "is-none" : "is-none is-picked"} onClick={() => onPick(null)} />
    </div>
  );
}

function moved(list: string[], from: number, to: number): string[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  if (item !== undefined) next.splice(to, 0, item);
  return next;
}

interface ColumnListProps {
  board: BoardView;
  settings: BoardSettings;
  onSave: (settings: BoardSettings) => void;
  onPaint: (column: BoardColumn, color: string | null) => void;
}

function ColumnList({ board, settings, onSave, onPaint }: ColumnListProps) {
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [palette, setPalette] = useState<string | null>(null);
  const statuses = board.columns.map((column) => columnStatus(column.value));

  function reorder(from: number, to: number) {
    if (from !== to && to >= 0 && to < statuses.length) onSave({ ...settings, order: moved(statuses, from, to) });
  }

  function toggle(status: string, hidden: boolean) {
    onSave({ ...settings, columns: { ...settings.columns, [status]: { ...settings.columns[status], hidden } } });
  }

  return (
    <section className="board-settings-part">
      <h3>Columns</h3>
      <p className="sheet-copy">Drag a column to reorder it. A hidden column leaves the board, and agents can still move tickets there.</p>
      <ul className="board-settings-columns">
        {board.columns.map((column, index) => {
          const status = statuses[index] ?? "";
          const hidden = settings.columns[status]?.hidden === true;
          const title = String(column.title ?? "");
          return (
            <li
              key={keyOf(status)}
              className={[hidden ? "is-hidden" : "", over === index && dragging !== index ? "is-over" : ""].filter(Boolean).join(" ") || undefined}
              draggable
              onDragStart={(event: DragEvent<HTMLLIElement>) => {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", status);
                setDragging(index);
              }}
              onDragOver={(event) => {
                if (dragging === null) return;
                event.preventDefault();
                setOver(index);
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (dragging !== null) reorder(dragging, index);
                setDragging(null);
                setOver(null);
              }}
              onDragEnd={() => {
                setDragging(null);
                setOver(null);
              }}
            >
              <div className="board-settings-column">
                <button
                  type="button"
                  className="icon board-settings-grip"
                  aria-label={`Move ${title}. Arrow keys move it up or down`}
                  onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
                    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                    event.preventDefault();
                    reorder(index, index + (event.key === "ArrowUp" ? -1 : 1));
                  }}
                >
                  <GripIcon />
                </button>
                <button
                  type="button"
                  className="column-swatch"
                  style={{ background: columnTone(column) }}
                  aria-label={`Color for ${title}`}
                  aria-expanded={palette === status}
                  onClick={() => setPalette((current) => (current === status ? null : status))}
                />
                <span className="board-settings-name">{nodeOf(column.title)}</span>
                <span className="board-column-count">{board.tasks.filter((task) => taskStatus(task) === column.value).length}</span>
                <button
                  type="button"
                  className="icon"
                  aria-label={hidden ? `Show ${title}` : `Hide ${title}`}
                  aria-pressed={hidden}
                  title={hidden ? "Show" : "Hide"}
                  onClick={() => toggle(status, !hidden)}
                >
                  <EyeIcon off={hidden} />
                </button>
              </div>
              {palette === status ? (
                <ColumnPalette
                  title={title}
                  picked={column.colorName}
                  onPick={(name) => {
                    onPaint(column, name);
                    setPalette(null);
                  }}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const MOVES: { key: MoveKey; label: string; hint: string; none: string }[] = [
  { key: "create", label: "New ticket", hint: "An agent creates a ticket", none: "Board default" },
  { key: "start", label: "Work starts", hint: "A chat starts on the ticket", none: "Don't move" },
  { key: "review", label: "Pull request opened", hint: "Not a draft, or marked ready", none: "Don't move" },
  { key: "done", label: "Merged", hint: "A merge or a commit on main", none: "Ask which column" },
];

// Column names as the board's headers show them, which capitalize each word in CSS. An option takes no such style.
function capitalized(title: string): string {
  return title.replace(/(^|\s)(\p{Ll})/gu, (_, space: string, letter: string) => space + letter.toUpperCase());
}

// The columns a ticket can move to. A column without a status, or with an empty one, takes no move.
function moveColumns(columns: BoardColumn[]): MoveColumn[] {
  return columns.flatMap((column) => (
    column.value === null || column.value === undefined || column.value === "" ? [] : [{ status: String(column.value), title: String(column.title ?? "") }]
  ));
}

interface MoveListProps {
  board: BoardView;
  source: BoardColumn[];
  settings: BoardSettings;
  onSave: (settings: BoardSettings) => void;
}

function MoveList({ board, source, settings, onSave }: MoveListProps) {
  const columns = moveColumns(board.columns);
  const resolved = resolveMoves(moveColumns(source), settings);

  function pick(key: MoveKey, status: string) {
    const moves = { ...settings.moves };
    const column = columns.find((item) => item.status === status);
    if (column) moves[key] = column;
    else if (key === "create") delete moves[key];
    else moves[key] = null;
    onSave({ ...settings, moves });
  }

  return (
    <section className="board-settings-part">
      <h3>Automatic moves</h3>
      <p className="sheet-copy">Where agents move a ticket linked to their chat.</p>
      {MOVES.map((move) => {
        const current = resolved[move.key];
        const gone = current && !columns.some((column) => column.status === current.status);
        return (
          <label key={move.key} className="sheet-field board-settings-move">
            <span>
              {move.label}
              <small>{move.hint}</small>
            </span>
            <select value={current?.status ?? ""} onChange={(event) => pick(move.key, event.target.value)}>
              <option value="">{move.none}</option>
              {gone ? <option value={current.status}>{`${capitalized(current.title)} (not on the board)`}</option> : null}
              {columns.map((column) => (
                <option key={column.status} value={column.status}>{capitalized(column.title)}</option>
              ))}
            </select>
          </label>
        );
      })}
    </section>
  );
}
