import { z } from "zod";
import { fields, isRecord } from "../../bridge/lenient.ts";
import type { TicketsState } from "./tickets.ts";
import type { TicketId } from "./ticketId.ts";
import type { BoardBinding, BoardProvider } from "./sources.ts";

// What a board source can do, so the router and the page do not ask which source it is.
export interface BoardCapabilities {
  // A ticket has a note next to its description. SAK has one, a Trello card does not.
  notes: boolean;
  // "free": a card can be dropped into any column. "transitions": a move follows a workflow
  // that can refuse it, for example Jira.
  moves: "free" | "transitions";
  // The board load can answer { unchanged: true } for the activity stamp of the last load.
  conditionalFetch: boolean;
  // The source runs on this machine, so the page can poll it often.
  local: boolean;
  // Columns can be painted (POST /api/board/lists).
  columnColors: boolean;
  // Labels can be created, attached and removed here.
  labels: boolean;
  labelColors: boolean;
  // A label can exist with no ticket on it. Without this, a new label is made on a ticket.
  standaloneLabels: boolean;
  // A label can be deleted from the board, which takes it off every ticket (DELETE /api/board/labels/:id).
  labelDeletes: boolean;
  // A ticket can be deleted here.
  deletes: boolean;
  types: boolean;
  // A ticket has people on it: Jira's assignee, Trello's members.
  assignees: boolean;
  dueDates: boolean;
  priority: boolean;
  subtasks: boolean;
  // A ticket has checklists whose items can be ticked and added here.
  checklists: boolean;
  // Tickets can be related here: a parent, a blocker, an order, a duplicate (PUT /api/board/tasks/:id/relations).
  relations: boolean;
  commentEdits: boolean;
  // A ticket's text shows a file by its name, as !shot.png! or !shot.png|width=300!.
  embedsByName: boolean;
  // The board's own site opens in the desktop app, already signed in.
  signedInPages: boolean;
  // Deleting a ticket archives it, and the source keeps it.
  archives: boolean;
  // What the page calls the people on a ticket.
  assigneeLabel: string;
  // A card's badge: "key" shows the id as it is, "number" shows # and the card's number, or its id without one.
  badge: "key" | "number";
}

// A page of the board's own site, and the local storage its origin needs to be signed in. The items are
// written from `from`, a light page of the same origin, before `url` loads.
export interface SignedInPage {
  url: string;
  storage: { from: string; items: Record<string, string> };
}

export interface BoardPerson {
  id: string;
  name: string;
}

// A comment as the ticket detail shows it. mine is true for a comment the connected account wrote.
export interface BoardComment {
  id: unknown;
  body: string;
  author: BoardPerson | null;
  created: string | null;
  mine: boolean;
}

// A column a ticket can move to from its status. needs names the fields the move asks for,
// which the page collects before it moves the ticket with them.
export interface BoardMove {
  status: unknown;
  title: string;
  needs: MoveField[];
}

export interface MoveField {
  id: string;
  name: string;
}

// What a move carries besides the column. order is the column's ticket ids after the drop, the
// moved one among them, so the ticket keeps its place. fields answers a move's needs.
export interface MoveExtra {
  order?: TicketId[];
  fields?: Record<string, string>;
}

// The files the board routes read and write. Tests point them at a temp folder.
export interface BoardFiles {
  tickets: string;
  connections: Record<BoardProvider, string>;
}

// What an adapter gets from the router for one request.
export interface BoardServices {
  files: BoardFiles;
  fetchOptions?: BoardCallOptions;
  // The canonical folder for a cwd the page or an agent sent. Throws a 400 when it is not a board folder.
  folderOf: (cwd: unknown) => string;
  // The checkout a worktree was added from. A worktree without its own board binding uses that checkout's.
  projectHome?: (folder: string) => string;
  // Starts or stops the SAK this host runs after its connection is saved.
  syncSak?: () => Promise<void>;
  // Makes a SAK board of this host's own and saves its connection, unless a SAK already answers at baseUrl.
  setUpSak?: (baseUrl: string) => Promise<void>;
}

// A board column. value is what a move sends as the status, forwarded as the source sent it.
export interface BoardColumnView {
  value: unknown;
  title: unknown;
}

// The board payload the page renders. Each source fills it in its own field order.
export interface BoardView {
  provider: BoardProvider;
  capabilities?: BoardCapabilities;
  source?: string;
  project: unknown;
  url: unknown;
  columns: unknown[];
  labels: unknown[];
  tasks: unknown[];
  truncated: boolean;
  // The connected account's person id on this board, for the "Mine" filter. Left out by a source without people.
  me?: string | null;
}

// Nothing changed since the activity stamp the page sent (capabilities.conditionalFetch).
export interface BoardUnchanged {
  unchanged: true;
  provider: BoardProvider;
  activity: string;
}

// A loaded board, and how the folder's binding changes with it (a new title, new columns).
// rebind is null when the binding stays as it is. The router refreshes the link text from view.tasks.
export interface LoadedBoard {
  view: BoardView | BoardUnchanged;
  rebind: ((state: TicketsState) => TicketsState) | null;
}

export interface BoardQuery {
  search: string;
  activity: string;
}

// A new ticket. The adapter checks the title, so its error is the source's own.
export interface TicketDraft {
  title: string | undefined;
  description: string | undefined;
}

// An edit from the ticket detail. revision is the one the page last read. A source without
// notes ignores note.
export interface TicketEdit {
  revision?: number | string | null;
  title?: string;
  // null clears the field.
  description?: string | null;
  note?: string | null;
}

// What POST /api/board/boards sends to bind a folder: an existing board, or a name for a new one.
export interface BindRequest {
  projectId?: TicketId;
  boardId?: TicketId;
  title?: string;
}

// What PUT /api/<provider>/connection sends. Secrets stay in ~/.x-bench and never go back to the page.
export interface ConnectionRequest {
  baseUrl?: string;
  email?: string;
  token?: string;
  apiKey?: string;
  enabled?: boolean;
}

// The ticket a card thread opens with.
export interface ThreadTicket {
  id: unknown;
  title: unknown;
  status: unknown;
  description: string;
  note: string;
}

export interface LabelAdded {
  label: unknown;
  task: unknown;
}

// How a relation is stored, from the ticket that names it. parent: the other ticket is this one's
// parent. blocks: this ticket blocks the other. follows: this ticket comes after the other.
export const relationKinds = ["blocks", "parent", "follows", "relates", "duplicates"] as const;
export type RelationKind = (typeof relationKinds)[number];

// The spellings that name a stored kind from the other ticket's end.
export const flippedKinds = new Map<string, RelationKind>([
  ["blocked_by", "blocks"],
  ["subtask", "parent"],
  ["precedes", "follows"],
]);

// A ticket's files, each with at least id, name, content_type, size, url and created_at.
export interface TicketFiles {
  list(taskId: TicketId): Promise<unknown[]>;
  add(taskId: TicketId, name: string, file: Blob): Promise<unknown>;
  read(taskId: TicketId, fileId: string, range: string | undefined): Promise<FileBytes>;
  // Refuses a file of another ticket.
  remove(taskId: TicketId, fileId: string): Promise<void>;
}

export interface FileBytes {
  status: number;
  headers: Record<string, string>;
  bytes: Uint8Array;
}

export const FILE_TIMEOUT_MS = 60_000;

const FILE_HEADERS = ["content-type", "content-range", "accept-ranges", "cache-control"];

export async function fileBytes(response: BoardFetchResponse): Promise<FileBytes> {
  const headers = Object.fromEntries(FILE_HEADERS.flatMap((name) => {
    const value = response.headers.get(name);
    return value ? [[name, value]] : [];
  }));
  return { status: response.status, headers, bytes: new Uint8Array(await response.arrayBuffer()) };
}

export interface ColumnPainted {
  column: { value: string; title: string; colorName?: string; color?: string | null };
}

// A folder's board: the actions that need the binding.
export interface BoundBoard {
  folder: string;
  load(query: BoardQuery): Promise<LoadedBoard>;
  createTicket(draft: TicketDraft): Promise<unknown>;
  // Finds or creates the label by title, and attaches it when taskId is set. color goes only to a label this creates.
  addLabel(title: string, taskId: TicketId | undefined, color: string | null): Promise<LabelAdded>;
  // A 404 for a label on another board. null unless capabilities.labelDeletes.
  deleteLabel: ((labelId: TicketId) => Promise<void>) | null;
  // The ticket as it would be linked, or a 404 when it is on another board.
  ticketOnBoard(taskId: TicketId): Promise<unknown>;
  // null unless capabilities.columnColors.
  paintColumn: ((listId: string | undefined, color: string | null | undefined) => Promise<ColumnPainted>) | null;
  // The ticket's page, or the board's for null. null unless capabilities.signedInPages.
  signedInPage: ((taskId: TicketId | null) => SignedInPage) | null;
}

// One board source. A method that returns a promise rejects, never throws, with an error that
// carries a status for the router to send.
// Tickets are returned as the page reads them: SAK's task shape, which the other sources' tickets are mapped onto.
export interface BoardAdapter {
  provider: BoardProvider;
  label: string;
  capabilities: BoardCapabilities;
  // The folder's board, or null when the binding belongs to another source.
  open(folder: string, binding: BoardBinding): BoundBoard | null;
  // A task route without a folder: whether this source owns the id. The router asks the
  // folder's binding first and this only when the request names no bound folder.
  claims(taskId: TicketId): boolean;

  status(): Promise<unknown>;
  saveConnection(request: ConnectionRequest): Promise<unknown>;
  // GET /api/<provider>/<boardsRoute> lists the boards a folder can be bound to.
  boardsRoute: string;
  listBoards(): Promise<unknown>;
  // POST /api/<provider>/<boardsRoute> makes a board without binding a folder. null when the source does not.
  createBoard: ((title: unknown, description: string | undefined) => Promise<unknown>) | null;
  // Binds the folder to an existing board or a new one, writes tickets.json, and returns what the page shows.
  bind(folder: string, request: BindRequest): Promise<unknown>;

  // cwd is the folder the request named, if any.
  // status null moves the ticket to the unset column.
  moveTicket(taskId: TicketId, status: string | null | undefined, cwd: string | undefined, extra?: MoveExtra): Promise<unknown>;
  // The columns the ticket can move to now. With free moves that is every other column.
  moves(taskId: TicketId): Promise<BoardMove[]>;
  editTicket(taskId: TicketId, edit: TicketEdit): Promise<unknown>;
  changeLabel(taskId: TicketId, labelId: TicketId, attach: boolean): Promise<unknown>;
  readTicket(taskId: TicketId): Promise<unknown>;
  comments(taskId: TicketId): Promise<BoardComment[]>;
  addComment(taskId: TicketId, text: string): Promise<BoardComment>;
  // Only when capabilities.commentEdits; otherwise they refuse with a 400.
  editComment(taskId: TicketId, commentId: string, text: string): Promise<BoardComment>;
  deleteComment(taskId: TicketId, commentId: string): Promise<void>;
  // Only when capabilities.checklists; otherwise they refuse with a 400. Both answer the ticket as readTicket does.
  checkItem(taskId: TicketId, itemId: string, done: boolean): Promise<unknown>;
  addCheckItem(taskId: TicketId, checklistId: string, title: string): Promise<unknown>;
  deleteTicket(taskId: TicketId): Promise<void>;
  // Creates (attach) or removes the relation taskId names to otherId. null unless capabilities.relations.
  changeRelation: ((taskId: TicketId, otherId: TicketId, kind: RelationKind, attach: boolean) => Promise<void>) | null;
  files: TicketFiles;
  // The brief a thread opens with, from a ticket ticketOnBoard returned.
  threadTicket(task: unknown): ThreadTicket;
}

// A ticket's description or note as the thread brief shows it. A missing one is empty.
export function threadText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

// A Trello card or Jira issue as its client mapped it onto SAK's task shape.
const MappedTicket = fields({
  id: z.unknown().optional(),
  title: z.unknown().optional(),
  description: z.unknown().optional(),
  linkStatus: z.unknown().optional(),
  attributes: fields({ status: z.unknown().optional() }),
});

// The thread brief of a ticket without a note, named by its column.
export function mappedThreadTicket(task: unknown): ThreadTicket {
  const ticket = MappedTicket.parse(task);
  return {
    id: ticket.id,
    title: ticket.title,
    status: ticket.linkStatus || ticket.attributes.status,
    description: threadText(ticket.description),
    note: "",
  };
}

export async function noChecklists(): Promise<never> {
  throw boardError(400, "This board has no checklists");
}

export type BoardError = Error & { status: number; code: unknown; fields?: MoveField[] };

// An error the router sends as { error, code } with this status. The page shows its message as it is, so the
// message holds no secret and no raw upstream code.
export function boardError(status: number, message: string, code: unknown = null): BoardError {
  return Object.assign(new Error(message), { status, code });
}

// A move the source refused until these fields are filled in. The router sends them with the error.
export function needsFields(message: string, code: unknown, fields: MoveField[]): BoardError {
  return Object.assign(boardError(409, message, code), { fields });
}

export function boardFailure(error: unknown): { status: number; body: { error: unknown; code: unknown; fields?: unknown[] } } {
  const failure = isRecord(error) ? error : {};
  const status = Number(failure.status) || 502;
  const body = { error: failure.message, code: failure.code || null };
  return { status, body: Array.isArray(failure.fields) ? { ...body, fields: failure.fields } : body };
}

// A person from a source's id and display name, or null without a name.
export function person(id: unknown, name: unknown): BoardPerson | null {
  const text = typeof name === "string" ? name.trim().replace(/\s+/g, " ").slice(0, 80) : "";
  if (!text) return null;
  return { id: id === undefined || id === null ? "" : String(id), name: text };
}

// The ids next to the moved ticket in the column's new order: the one above and the one below.
export function neighbors(order: TicketId[] | undefined, taskId: TicketId): { above: TicketId | null; below: TicketId | null } | null {
  if (!order?.length) return null;
  const at = order.findIndex((item) => String(item) === String(taskId));
  if (at < 0) return null;
  return { above: at > 0 ? (order[at - 1] ?? null) : null, below: order[at + 1] ?? null };
}

// The part of fetch the board calls use, so tests can pass a fake.
export interface BoardFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Blob | FormData;
  signal?: AbortSignal;
}

export interface BoardFetchResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type BoardFetch = (url: string, init?: BoardFetchInit) => Promise<BoardFetchResponse>;

export interface BoardCallOptions {
  timeoutMs?: number;
  fetchImpl?: BoardFetch;
}

// A source's response body as JSON, or null when it is empty or not JSON.
export async function responseJson(response: BoardFetchResponse): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
