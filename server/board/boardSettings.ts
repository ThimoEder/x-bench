// How X Bench shows a board and where agents move its tickets, kept on top of what the board's source sends.
// The page and the agent rules both read it, so it imports nothing.

export type MoveKey = "create" | "start" | "review" | "done";

export const MOVE_KEYS: readonly MoveKey[] = ["create", "start", "review", "done"];

// A column a move goes to. status is what POST /api/board/move sends for it.
export interface MoveColumn {
  status: string;
  title: string;
}

export interface ColumnSettings {
  hidden?: boolean;
  collapsed?: boolean;
  // A LIST_COLORS name, for a board whose source keeps no column colors.
  color?: string;
}

// Columns are keyed by columnStatus.
export interface BoardSettings {
  columns: Record<string, ColumnSettings>;
  // Statuses in the order the page shows their columns. A column left out comes after them.
  order: string[];
  // null turns a move off. A move left out goes to the first column with one of MOVE_NAMES.
  moves: Partial<Record<MoveKey, MoveColumn | null>>;
}

// The swatches for a column and a new label. A column saves the name.
export const LIST_COLORS = [
  ["green", "#61bd4f"],
  ["yellow", "#f2d600"],
  ["orange", "#ff9f1a"],
  ["red", "#eb5a46"],
  ["purple", "#c377e0"],
  ["blue", "#0079bf"],
  ["lime", "#51e898"],
  ["gray", "#838c91"],
] as const;

// The color the settings keep for a column, as CSS.
export function settingsColor(settings: BoardSettings, status: string): string | undefined {
  const name = settings.columns[status]?.color;
  return LIST_COLORS.find(([color]) => color === name)?.[1];
}

export const NO_SETTINGS: BoardSettings = { columns: {}, order: [], moves: {} };

// The column names a move looks for until the board's settings pick its column, in lower case. A new ticket goes
// where the board's source puts it, so create has none.
const MOVE_NAMES: Record<Exclude<MoveKey, "create">, string[]> = {
  start: ["in progress", "doing", "active"],
  review: ["review", "in review", "code review"],
  done: ["done"],
};

// A column's value as the key its settings are kept under. A column without a status has the empty key, so an
// empty status is kept in quotes.
export function columnStatus(value: unknown): string {
  return value === null || value === undefined ? "" : String(value) || '""';
}

export function resolveMoves(columns: readonly MoveColumn[], settings: BoardSettings): Record<MoveKey, MoveColumn | null> {
  const pick = (key: MoveKey): MoveColumn | null => {
    const chosen = settings.moves[key];
    if (chosen !== undefined) return chosen;
    if (key === "create") return null;
    return columns.find((column) => MOVE_NAMES[key].includes(column.title.trim().toLowerCase())) ?? null;
  };
  return { create: pick("create"), start: pick("start"), review: pick("review"), done: pick("done") };
}

// The columns in the board's order. The rest keep the source's order after them.
export function orderColumns<T>(columns: readonly T[], order: readonly string[], statusOf: (column: T) => string): T[] {
  const rank = (column: T) => {
    const index = order.indexOf(statusOf(column));
    return index < 0 ? order.length : index;
  };
  return columns.map((column, index) => ({ column, index }))
    .sort((a, b) => rank(a.column) - rank(b.column) || a.index - b.index)
    .map((item) => item.column);
}
