import type { Key, ReactNode } from "react";
import type { BoardCapabilities, BoardColumnView, BoardComment, BoardMove, BoardPerson, MoveField } from "../../server/board/boardAdapter.ts";
import type { SessionTicketLink } from "../../server/board/tickets.ts";
import type { TrelloColumnView, TrelloLabelView, TrelloTask } from "../../server/board/trello/trello.ts";
import type { CallOptions } from "../launchToken.ts";
import { statusTone } from "./ticketStatus.ts";

export type { BoardMove, BoardPerson, MoveField };

export type BoardCall = (path: string, body?: unknown, method?: string, options?: CallOptions) => Promise<unknown>;

export type BoardColumn = Partial<Record<keyof BoardColumnView | keyof TrelloColumnView, unknown>>;

export type BoardLabel = Partial<Record<keyof TrelloLabelView, unknown>>;

// A ticket in the shape every source is mapped onto. attributes may be any value; {} keeps it spreadable.
// The card fields (assignees, due, counts) are read with the readers below.
export interface BoardTask extends Partial<Record<Exclude<keyof TrelloTask, "attributes" | "labels">, unknown>> {
  attributes?: {} | null;
  labels?: BoardLabel[] | null;
  type?: unknown;
  typeName?: unknown;
  priority?: unknown;
  subtaskCount?: unknown;
  subtasks?: unknown;
  checklists?: unknown;
  related?: unknown;
  relations?: unknown;
  created?: unknown;
  created_at?: unknown;
  updated?: unknown;
  updated_at?: unknown;
  parentId?: unknown;
}

// /api/board/board: the folder's board.
export interface BoardView {
  provider?: unknown;
  capabilities?: unknown;
  source?: unknown;
  url?: unknown;
  columns: BoardColumn[];
  labels?: BoardLabel[] | null;
  tasks: BoardTask[];
  truncated?: unknown;
  activity?: unknown;
  me?: unknown;
}

// The detail panel reads these as text.
export interface DetailTask extends BoardTask {
  title?: string | null;
  description?: string | null;
  note?: string | null;
}

export type TicketComment = Partial<Record<keyof BoardComment, unknown>>;

type ThreadLink = Pick<SessionTicketLink, "sessionId">;

// /api/board/tasks/:id
export type TaskDetail = OpenDetail | EmptyDetail;

export interface OpenDetail {
  task: DetailTask;
  comments?: TicketComment[] | null;
  links?: ThreadLink[] | null;
}

interface EmptyDetail {
  task?: null;
  comments?: TicketComment[] | null;
  links?: ThreadLink[] | null;
}

// A sub-task or linked ticket as the detail lists it. kind is the link's wording, for linked ones.
export interface Linked {
  id: unknown;
  title: string;
  status: unknown;
  done: boolean;
  kind: string;
}

type Flag = keyof Omit<BoardCapabilities, "moves" | "conditionalFetch" | "assigneeLabel" | "badge">;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isLabelList(value: unknown): value is BoardLabel[] | null | undefined {
  return value === undefined || value === null || (Array.isArray(value) && value.every(isRecord));
}

function isBoardTask(value: unknown): value is BoardTask {
  return isRecord(value) && isLabelList(value.labels);
}

export const UNREADABLE_BOARD = "The board sent a reply this page can't read";

// The board as the page renders it. A reply without column and task lists is not a board.
// A column, task or label that is not an object is skipped, and a label list that is not a
// list reads as none, so one bad item does not hide the whole board.
export function boardView(value: unknown): BoardView | null {
  if (!isRecord(value) || !Array.isArray(value.columns) || !Array.isArray(value.tasks)) return null;
  const tasks = value.tasks.flatMap((task: unknown) => {
    if (!isRecord(task)) return [];
    const kept = { ...task, labels: labelList(task.labels) };
    return isBoardTask(kept) ? [kept] : [];
  });
  return { ...value, columns: value.columns.filter(isRecord), tasks, labels: labelList(value.labels) };
}

function labelList(value: unknown): BoardLabel[] | null {
  return Array.isArray(value) ? value.filter(isRecord) : null;
}

function isText(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === "string";
}

export function isDetailTask(value: unknown): value is DetailTask {
  return isBoardTask(value) && isText(value.title) && isText(value.description) && isText(value.note);
}

function isThreadLink(value: unknown): value is ThreadLink {
  return isRecord(value) && typeof value.sessionId === "string";
}

// A ticket's detail as the panel renders it. A comment or link that is not usable is skipped, and a
// title, description or note that is not text reads as missing, so one bad item does not close the panel.
export function taskDetail(value: unknown): TaskDetail | null {
  if (!isRecord(value)) return null;
  const comments = Array.isArray(value.comments) ? value.comments.filter(isRecord) : null;
  const links = Array.isArray(value.links) ? value.links.filter(isThreadLink) : null;
  if (!isRecord(value.task)) return { task: null, comments, links };
  const task = {
    ...value.task,
    labels: labelList(value.task.labels),
    title: textField(value.task.title),
    description: textField(value.task.description),
    note: textField(value.task.note),
  };
  return { task: isDetailTask(task) ? task : null, comments, links };
}

function textField(value: unknown): string | null | undefined {
  return isText(value) ? value : undefined;
}

export function isSavedTask(value: unknown): value is { task: DetailTask; label?: unknown } {
  return isRecord(value) && isDetailTask(value.task);
}

// A host answer the board reads. Anything else fails like a failed request.
export function checked<T>(value: unknown, guard: (value: unknown) => value is T): T {
  if (guard(value)) return value;
  throw new Error("Request failed");
}

export function labelIn(value: unknown): BoardLabel | undefined {
  return isRecord(value) ? value : undefined;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "";
}

// The host's reply to a failed request, which call() puts on the error.
function replyOf(error: unknown): Record<string, unknown> {
  return isRecord(error) && isRecord(error.reply) ? error.reply : {};
}

export function statusOf(error: unknown): number {
  return isRecord(error) && typeof error.status === "number" ? error.status : 0;
}

export function neededFields(error: unknown): MoveField[] {
  return fieldList(replyOf(error).fields);
}

// Move fields as the host sent them. Anything else reads as none.
function fieldList(value: unknown): MoveField[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((field: unknown) => (
    isRecord(field) && typeof field.id === "string" && typeof field.name === "string" ? [{ id: field.id, name: field.name }] : []
  ));
}

// GET tasks/<id>/moves. A move that is not usable is skipped.
export function moveList(value: unknown): BoardMove[] {
  if (!isRecord(value) || !Array.isArray(value.moves)) return [];
  return value.moves.flatMap((move: unknown) => (isRecord(move) ? [{ status: move.status ?? null, title: textOf(move.title), needs: fieldList(move.needs) }] : []));
}

export function keyOf(value: unknown): Key | null | undefined {
  if (value === undefined || value === null || typeof value === "string" || typeof value === "number" || typeof value === "bigint") return value;
  return String(value);
}

// A loose value as React renders it. An object, which React cannot render, renders nothing.
export function nodeOf(value: unknown): ReactNode {
  if (value === undefined || value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return value;
  if (Array.isArray(value)) return value.map(nodeOf);
  return null;
}

export function cssValue(value: unknown): string | number | undefined {
  if (typeof value === "string" || typeof value === "number") return value;
  if (value === undefined || value === null || typeof value === "boolean") return undefined;
  return String(value);
}

export function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// The swatches for a column and a new label. A column saves the name, so the names match LIST_COLORS in server/board/trello/trelloSource.ts.
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

// Whether the board's source does this here. A flag the host left out reads as off.
export function canDo(board: BoardView | null, flag: Flag): boolean {
  return isRecord(board?.capabilities) && board.capabilities[flag] === true;
}

export function transitions(board: BoardView | null): boolean {
  return isRecord(board?.capabilities) && board.capabilities.moves === "transitions";
}

export function sourceName(board: BoardView | null): string {
  return typeof board?.source === "string" && board.source ? board.source : "the board";
}

export function cardBadge(board: BoardView, task: Pick<BoardTask, "id" | "reference">): string {
  if (isRecord(board.capabilities) && board.capabilities.badge === "key") return String(task.id ?? "");
  return `#${String(task.reference || task.id)}`;
}

export function assigneeLabel(board: BoardView | null): string {
  const label = isRecord(board?.capabilities) ? board.capabilities.assigneeLabel : undefined;
  return typeof label === "string" && label ? label : "Assignee";
}

export function ticketName(board: BoardView, task: BoardTask): string {
  return `${cardBadge(board, task)} ${textOf(task.title)}`;
}

// The task's status as the board sent it; none reads as null.
export function taskStatus(task: BoardTask): unknown {
  return (isRecord(task.attributes) ? task.attributes.status : undefined) ?? null;
}

export function parentOf(task: BoardTask): string | null {
  const id = task.parentId;
  return id === null || id === undefined || id === "" ? null : String(id);
}

export function sameId(a: unknown, b: unknown): boolean {
  return a !== null && a !== undefined && b !== null && b !== undefined && String(a) === String(b);
}

export function people(value: unknown): BoardPerson[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown) => (
    isRecord(item) && typeof item.name === "string" && item.name ? [{ id: String(item.id ?? item.name), name: item.name }] : []
  ));
}

export function counted(value: unknown): { done: number; total: number } | null {
  if (!isRecord(value) || typeof value.done !== "number" || typeof value.total !== "number" || value.total <= 0) return null;
  return { done: value.done, total: value.total };
}

export function linkedList(value: unknown): Linked[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown) => {
    if (!isRecord(item) || item.id === undefined || item.id === null) return [];
    return [{ id: item.id, title: textOf(item.title), status: item.status ?? null, done: item.done === true, kind: textOf(item.kind) }];
  });
}

export interface Checklist {
  id: string;
  title: string;
  items: { id: string; title: string; done: boolean }[];
}

export function checklistsOf(value: unknown): Checklist[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((list: unknown) => {
    if (!isRecord(list) || typeof list.id !== "string" || !Array.isArray(list.items)) return [];
    const items = list.items.flatMap((item: unknown) => (
      isRecord(item) && typeof item.id === "string" ? [{ id: item.id, title: textOf(item.title), done: item.done === true }] : []
    ));
    return [{ id: list.id, title: textOf(list.title), items }];
  });
}

export function columnFor(columns: BoardColumn[], status: unknown): BoardColumn | undefined {
  return columns.find((column) => column.value === status) ?? columns.find((column) => String(column.title) === String(status));
}

export function columnColor(column: BoardColumn | undefined): string | number | null {
  if (!column) return null;
  return cssValue(column.color || statusTone(column.value) || statusTone(column.title)) ?? null;
}

export function columnTone(column: BoardColumn | undefined): string | number | undefined {
  return columnColor(column) ?? "var(--faint)";
}
