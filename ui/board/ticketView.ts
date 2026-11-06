// How the board and the ticket detail show people, times and due dates, and where a dropped card lands.

const TONES = ["var(--status-active)", "var(--edit)", "var(--ok)", "var(--task)", "var(--attention)", "var(--status-open)"];

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  const first = [...(words[0] ?? "")];
  if (words.length === 1) return first.slice(0, 2).join("").toUpperCase();
  const last = [...(words.at(-1) ?? "")];
  return `${first[0] ?? ""}${last[0] ?? ""}`.toUpperCase();
}

// The same person gets the same color everywhere.
export function avatarTone(key: string): string {
  let hash = 0;
  for (const char of key) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return TONES[hash % TONES.length] ?? "var(--soft)";
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  // A bare day such as Jira's due date is that day in this time zone.
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const date = day ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

const DAY = 24 * 60 * 60 * 1000;

function dayLabel(date: Date, now: Date): string {
  const options: Intl.DateTimeFormatOptions = date.getFullYear() === now.getFullYear()
    ? { month: "short", day: "numeric" }
    : { month: "short", day: "numeric", year: "numeric" };
  return date.toLocaleDateString("en-US", options);
}

function clock(date: Date): string {
  return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

export function relativeTime(value: string | null | undefined, now: Date): string {
  const date = parseDate(value);
  if (!date) return "";
  const minutes = Math.floor((now.getTime() - date.getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const days = Math.round((startOfDay(now) - startOfDay(date)) / DAY);
  if (days === 0) return `${Math.floor(minutes / 60)} h ago`;
  if (days === 1) return `Yesterday ${clock(date)}`;
  return dayLabel(date, now);
}

export function exactTime(value: string | null | undefined): string {
  const date = parseDate(value);
  return date ? date.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "";
}

interface DueState {
  label: string;
  late: boolean;
  // How late, for a due date that has passed: "3 days late", or "Overdue" on its own day.
  lateLabel: string;
}

// A due date as a card shows it. A done ticket is never late.
export function dueState(due: string | null | undefined, done: boolean, now: Date): DueState | null {
  const date = parseDate(due);
  if (!date) return null;
  const bareDay = /^\d{4}-\d{2}-\d{2}$/.test(String(due));
  const late = !done && (bareDay ? startOfDay(date) < startOfDay(now) : date.getTime() < now.getTime());
  const days = Math.round((startOfDay(now) - startOfDay(date)) / DAY);
  let lateLabel = "";
  if (late) lateLabel = days >= 2 ? `${days} days late` : days === 1 ? "1 day late" : "Overdue";
  return { label: dayLabel(date, now), late, lateLabel };
}

// Where a card dropped at y lands among cards whose vertical midpoints are given, top to bottom.
export function dropIndex(midpoints: number[], y: number): number {
  const index = midpoints.findIndex((middle) => y < middle);
  return index < 0 ? midpoints.length : index;
}

// The column's ids after the moved one is dropped at index, which counts the column without it.
export function placeInOrder(ids: string[], moved: string, index: number): string[] {
  const rest = ids.filter((id) => id !== moved);
  const at = Math.max(0, Math.min(index, rest.length));
  return [...rest.slice(0, at), moved, ...rest.slice(at)];
}

// The board's tasks with the moved one placed next to its new neighbors in order. A task the
// order doesn't name keeps its place.
export function reorderTasks<T>(tasks: T[], idOf: (task: T) => string, moved: string, order: string[]): T[] {
  const task = tasks.find((item) => idOf(item) === moved);
  if (!task) return tasks;
  const rest = tasks.filter((item) => idOf(item) !== moved);
  const at = order.indexOf(moved);
  const below = order.slice(at + 1).find((id) => rest.some((item) => idOf(item) === id));
  if (below !== undefined) {
    const index = rest.findIndex((item) => idOf(item) === below);
    return [...rest.slice(0, index), task, ...rest.slice(index)];
  }
  const above = order.slice(0, Math.max(at, 0)).reverse().find((id) => rest.some((item) => idOf(item) === id));
  if (above !== undefined) {
    const index = rest.findIndex((item) => idOf(item) === above);
    return [...rest.slice(0, index + 1), task, ...rest.slice(index + 1)];
  }
  return [...rest, task];
}

// Whether a ticket with these people passes the person filter: null for everyone, "me", "none" for
// tickets without anyone, or a person id. me is the connected account's id.
export function personMatch(people: string[], person: string | null, me: string | null): boolean {
  if (person === "me") return Boolean(me && people.includes(me));
  if (person === "none") return !people.length;
  return !person || people.includes(person);
}

// "none" counts the tickets without anyone.
export function personCounts(tickets: string[][]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const ids of tickets) for (const id of ids.length ? ids : ["none"]) counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts;
}

// The card an arrow key moves to. Up and down stay in the column; left and right go to the
// nearest card at the same height in the next column that has cards. Without a current card,
// any arrow picks the first card.
export function nextCard(columns: string[][], current: string | null, key: string): string | null {
  const filled = columns.filter((cards) => cards.length);
  if (!filled.length) return null;
  const column = filled.findIndex((cards) => current !== null && cards.includes(current));
  if (column < 0) return filled[0]?.[0] ?? null;
  const cards = filled[column] ?? [];
  const row = cards.indexOf(current ?? "");
  if (key === "ArrowUp") return cards[Math.max(0, row - 1)] ?? null;
  if (key === "ArrowDown") return cards[Math.min(cards.length - 1, row + 1)] ?? null;
  const step = key === "ArrowLeft" ? -1 : key === "ArrowRight" ? 1 : 0;
  if (!step) return current;
  const next = filled[column + step];
  if (!next) return current;
  return next[Math.min(row, next.length - 1)] ?? current;
}

// A card in a column, with how deep it sits under its parent and how many children sit under it.
// parentAway marks a child whose parent is in another column, so it stays where it is.
interface NestedCard {
  id: string;
  depth: number;
  children: number;
  parentAway: boolean;
}

// A column's cards in their order, each child moved right under its parent when the parent is in the same column.
export function nestCards(cards: { id: string; parent: string | null }[]): NestedCard[] {
  const here = new Set(cards.map((card) => card.id));
  const parentOf = new Map(cards.map((card) => [card.id, card.parent]));
  const children = new Map<string, string[]>();
  for (const card of cards) {
    if (!card.parent || card.parent === card.id || !here.has(card.parent)) continue;
    children.set(card.parent, [...(children.get(card.parent) ?? []), card.id]);
  }
  const nested: NestedCard[] = [];
  const placed = new Set<string>();
  const place = (id: string, depth: number) => {
    if (placed.has(id)) return;
    placed.add(id);
    const parent = parentOf.get(id);
    nested.push({ id, depth, children: children.get(id)?.length ?? 0, parentAway: depth === 0 && Boolean(parent) && !here.has(parent ?? "") });
    for (const child of children.get(id) ?? []) place(child, depth + 1);
  };
  for (const card of cards) {
    if (!card.parent || !here.has(card.parent) || card.parent === card.id) place(card.id, 0);
  }
  // A parent loop has no top; its cards keep their place.
  for (const card of cards) place(card.id, 0);
  return nested;
}

// The cards that show: those under a parent stay hidden until that parent is open.
export function hideCollapsed<T extends NestedCard>(cards: T[], open: ReadonlySet<string>): T[] {
  const shown: T[] = [];
  let hidingBelow: number | null = null;
  for (const card of cards) {
    if (hidingBelow !== null && card.depth > hidingBelow) continue;
    hidingBelow = card.children && !open.has(card.id) ? card.depth : null;
    shown.push(card);
  }
  return shown;
}

// The whole column's order after a drop, from where the card landed among the cards that show:
// right after the shown card above it, or else right before the shown card below it.
export function placeAmong(column: string[], shown: string[], moved: string, index: number): string[] {
  const landed = placeInOrder(shown, moved, index);
  const at = landed.indexOf(moved);
  const above = landed[at - 1];
  const below = landed[at + 1];
  const rest = column.filter((id) => id !== moved);
  if (above !== undefined && rest.includes(above)) rest.splice(rest.indexOf(above) + 1, 0, moved);
  else if (below !== undefined && rest.includes(below)) rest.splice(rest.indexOf(below), 0, moved);
  else rest.push(moved);
  return rest;
}
