import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { fields, isRecord, maybe } from "../../../bridge/lenient.ts";
import { openSecret, sealSecret } from "../../secrets/secrets.ts";
import { isHexId, ticketId, type TicketId } from "../ticketId.ts";
import { listColorName, type BoardColumn } from "./trelloSource.ts";
import { stripHidden } from "../boardText.ts";
import {
  fileBytes,
  FILE_TIMEOUT_MS,
  neighbors,
  person,
  responseJson,
  type BoardCallOptions,
  type BoardComment,
  type BoardFetchResponse,
  type BoardPerson,
  type ConnectionRequest,
  type FileBytes,
  type MoveExtra,
  type TicketEdit,
} from "../boardAdapter.ts";

const API = "https://api.trello.com/1";
const CARD_FIELDS = "name,desc,idList,idBoard,dateLastActivity,idShort,closed,idLabels,idMembers,due,dueComplete,badges,pos,shortUrl";
const STARTER = ["Open", "Active", "Review", "Done"];

const LABEL_COLORS: Record<string, string> = {
  green: "#61bd4f",
  yellow: "#f2d600",
  orange: "#ff9f1a",
  red: "#eb5a46",
  purple: "#c377e0",
  blue: "#0079bf",
  sky: "#00c2e0",
  lime: "#51e898",
  pink: "#ff78cb",
  black: "#344563",
  gray: "#838c91",
};

// The key and token in ~/.x-bench/trello.json.
export interface TrelloConnection {
  apiKey: string;
  token: string;
  enabled: boolean;
}

// What the page learns about the connection. It never holds the key or token.
// name and username are forwarded as Trello sent them.
export interface TrelloStatus {
  configured: boolean;
  enabled: boolean;
  reachable: boolean;
  name: unknown;
  username: unknown;
}

export interface TrelloLoadOptions extends BoardCallOptions {
  search?: string | null;
  activity?: string | null;
}

export type TrelloError = Error & { status: number; code: string };

// A board the member can pick. url is forwarded as Trello sent it.
export interface TrelloBoardChoice {
  id: string;
  title: string;
  url: unknown;
}

export interface TrelloProvisioned {
  boardId: string;
  title: unknown;
  columns: BoardColumn[];
}

export interface TrelloLabelView {
  id: TicketId;
  title: string;
  color: string | null;
}

export interface TrelloColumnView {
  value: string;
  title: string;
  colorName?: string;
  color?: string | null;
}

// A card as the board shows it. Fields copied from the card keep Trello's values as they came.
export interface TrelloTask {
  id: unknown;
  project_id: unknown;
  title: unknown;
  description: unknown;
  note: null;
  revision: unknown;
  reference: number | null;
  attributes: { status: unknown };
  linkStatus: string | null;
  labels: TrelloLabelView[];
  assignees: BoardPerson[];
  due: string | null;
  dueDone: boolean;
  commentCount: number | null;
  checkCount: { done: number; total: number } | null;
  url: string | null;
  updated: string | null;
}

// A card's checklist as the ticket detail shows it, items in Trello's order.
export interface TrelloChecklist {
  id: string;
  title: string;
  items: { id: string; title: string; done: boolean }[];
}

export interface TrelloBoardView {
  provider: "trello";
  project: { id: unknown; title: unknown };
  url: unknown;
  columns: TrelloColumnView[];
  labels: TrelloLabelView[];
  tasks: TrelloTask[];
  truncated: boolean;
  activity: unknown;
}

export interface TrelloBoardUnchanged {
  unchanged: true;
  provider: "trello";
  activity: string;
}

// A loaded board and its open lists, or a note that nothing changed since the given activity.
export type TrelloBoardLoad =
  | { payload: TrelloBoardView; columns: BoardColumn[] }
  | { payload: TrelloBoardUnchanged; columns: null };

export interface TrelloLabelAdded {
  label: TrelloLabelView | undefined;
  task: TrelloTask | null;
}

// ~/.x-bench/trello.json. cleanSecret checks the values.
const StoredConnection = fields({
  apiKey: z.unknown().optional(),
  token: z.unknown().optional(),
  enabled: z.unknown().optional(),
});

// What the page sends to save the connection.
// Trello's bodies. Values are clipped, coerced or checked where they are used, so they stay unknown.
const Member = fields({
  id: z.unknown().optional(),
  fullName: z.unknown().optional(),
  username: z.unknown().optional(),
});

const Board = fields({
  id: z.unknown().optional(),
  name: z.unknown().optional(),
  shortUrl: z.unknown().optional(),
  url: z.unknown().optional(),
  dateLastActivity: z.unknown().optional(),
  lists: z.unknown().optional(),
  labels: z.unknown().optional(),
  cards: z.unknown().optional(),
  members: z.unknown().optional(),
});

const List = fields({
  id: z.unknown().optional(),
  name: z.unknown().optional(),
  pos: z.unknown().optional(),
  closed: z.unknown().optional(),
  color: z.unknown().optional(),
});

const Card = fields({
  id: z.unknown().optional(),
  name: z.unknown().optional(),
  desc: z.unknown().optional(),
  idList: z.unknown().optional(),
  idBoard: z.unknown().optional(),
  dateLastActivity: z.unknown().optional(),
  idShort: z.unknown().optional(),
  closed: z.unknown().optional(),
  idLabels: z.unknown().optional(),
  labels: maybe(z.array(z.unknown())),
  idMembers: maybe(z.array(z.unknown())),
  members: maybe(z.array(z.unknown())),
  due: z.unknown().optional(),
  dueComplete: z.unknown().optional(),
  badges: fields({ comments: z.unknown().optional(), checkItems: z.unknown().optional(), checkItemsChecked: z.unknown().optional() }),
  pos: z.unknown().optional(),
  shortUrl: z.unknown().optional(),
});

const Checklist = fields({
  id: z.unknown().optional(),
  name: z.unknown().optional(),
  pos: z.unknown().optional(),
  checkItems: maybe(z.array(z.unknown())),
});

const CheckItem = fields({
  id: z.unknown().optional(),
  name: z.unknown().optional(),
  state: z.unknown().optional(),
  pos: z.unknown().optional(),
});

const Label = fields({
  id: z.unknown().optional(),
  name: z.unknown().optional(),
  title: z.unknown().optional(),
  color: z.unknown().optional(),
});

const Action = fields({
  id: z.unknown().optional(),
  date: z.unknown().optional(),
  idMemberCreator: z.unknown().optional(),
  memberCreator: fields({ id: z.unknown().optional(), fullName: z.unknown().optional(), username: z.unknown().optional() }),
  data: fields({ text: z.unknown().optional() }),
});

const Failure = fields({ message: z.unknown().optional() });

const Attachment = fields({
  id: z.unknown().optional(),
  name: z.unknown().optional(),
  fileName: z.unknown().optional(),
  mimeType: z.unknown().optional(),
  bytes: z.unknown().optional(),
  url: z.unknown().optional(),
  date: z.unknown().optional(),
  isUpload: z.unknown().optional(),
});

// A card as readTrelloCard returns it, with its labels.
export type TrelloCard = z.output<typeof Card> & { labels: unknown[] };

// The connected member's id, by token, so a comment can say whether it is yours.
const memberIds = new Map<string, string>();

export function labelColor(value: unknown): string | null {
  const key = String(value || "").toLowerCase().replace(/_(dark|light)$/, "");
  return LABEL_COLORS[key] || null;
}

export function readTrelloConnection(file: string): TrelloConnection {
  const empty = { apiKey: "", token: "", enabled: false };
  if (!file || !existsSync(file)) return empty;
  try {
    const raw = StoredConnection.parse(JSON.parse(readFileSync(file, "utf8")));
    const apiKey = cleanSecret(openSecret(raw.apiKey));
    const token = cleanSecret(openSecret(raw.token));
    const enabled = raw.enabled === false ? false : Boolean(apiKey && token);
    return { apiKey, token, enabled };
  } catch {
    return empty;
  }
}

export function writeTrelloConnection(connection: unknown, file: string): TrelloConnection {
  const input = StoredConnection.parse(connection);
  const apiKey = cleanSecret(input.apiKey);
  const token = cleanSecret(input.token);
  if (!apiKey || !token) throw trelloError(400, "Add a Trello key and token");
  const enabled = input.enabled === false ? false : true;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ apiKey: sealSecret(apiKey), token: sealSecret(token), enabled }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return { apiKey, token, enabled };
}

export function saveTrelloConnection(input: ConnectionRequest, file: string): TrelloConnection {
  const current = readTrelloConnection(file);
  const apiKey = input.apiKey?.trim() || current.apiKey;
  const token = input.token?.trim() || current.token;
  const enabled = input.enabled ?? true;
  return writeTrelloConnection({ apiKey, token, enabled }, file);
}

export async function trelloStatus(connection: TrelloConnection, options?: BoardCallOptions): Promise<TrelloStatus> {
  const configured = Boolean(connection.apiKey && connection.token);
  const enabled = Boolean(configured && connection.enabled);
  if (!configured || !enabled) return { configured, enabled: false, reachable: false, name: null, username: null };
  try {
    const member = Member.parse(await trelloFetch(connection, "GET", "/members/me", {
      query: { fields: "fullName,username" },
      ...callOptions(options),
    }));
    return {
      configured: true,
      enabled: true,
      reachable: true,
      name: member.fullName || member.username || null,
      username: member.username || null,
    };
  } catch {
    return { configured: true, enabled: true, reachable: false, name: null, username: null };
  }
}

export async function listTrelloBoards(connection: TrelloConnection, options?: BoardCallOptions): Promise<TrelloBoardChoice[]> {
  requireConnection(connection);
  const boards = await trelloFetch(connection, "GET", "/members/me/boards", {
    query: { filter: "open", fields: "name,url,shortUrl" },
    ...callOptions(options),
  });
  return itemsOf(boards).flatMap((item) => {
    const board = Board.parse(item);
    const id = ticketId(board.id);
    if (!isHexId(id)) return [];
    return [{ id, title: clip(board.name, 200) || id, url: board.shortUrl || board.url || "" }];
  });
}

export async function provisionTrelloBoard(
  connection: TrelloConnection,
  { boardId, title }: { boardId?: unknown; title?: unknown },
  options?: TrelloLoadOptions,
): Promise<TrelloProvisioned> {
  requireConnection(connection);
  const id = ticketId(boardId);
  if (isHexId(id)) {
    const loaded = await loadTrelloBoard(connection, id, options);
    const loadedTitle = loaded.columns ? loaded.payload.project.title : undefined;
    return { boardId: id, title: loadedTitle || id, columns: loaded.columns || [] };
  }
  const name = clip(title, 200);
  if (!name) throw trelloError(400, "Choose a Trello board or a name");
  const created = Board.parse(await trelloFetch(connection, "POST", "/boards", {
    body: { name, defaultLists: false, defaultLabels: true },
    ...callOptions(options),
  }));
  const createdId = ticketId(created.id);
  if (!isHexId(createdId)) throw trelloError(502, "Trello did not return a board");
  const columns: BoardColumn[] = [];
  for (let index = 0; index < STARTER.length; index += 1) {
    const starter = STARTER[index] ?? "";
    const list = List.parse(await trelloFetch(connection, "POST", `/boards/${createdId}/lists`, {
      body: { name: starter, pos: (index + 1) * 16384 },
      ...callOptions(options),
    }));
    const listId = ticketId(list.id);
    if (isHexId(listId)) columns.push({ id: listId, title: clip(list.name, 80) || starter });
  }
  return { boardId: createdId, title: clip(created.name, 200) || name, columns };
}

export async function loadTrelloBoard(connection: TrelloConnection, boardId: unknown, options: TrelloLoadOptions = {}): Promise<TrelloBoardLoad> {
  requireConnection(connection);
  const id = ticketId(boardId);
  if (!isHexId(id)) throw trelloError(400, "Choose a Trello board");
  if (options.activity) {
    const stamp = Board.parse(await trelloFetch(connection, "GET", `/boards/${id}`, {
      query: { fields: "dateLastActivity" },
      ...callOptions(options),
    }));
    if (stamp.dateLastActivity && stamp.dateLastActivity === options.activity) {
      return { payload: { unchanged: true, provider: "trello", activity: options.activity }, columns: null };
    }
  }
  const board = await trelloFetch(connection, "GET", `/boards/${id}`, {
    query: {
      fields: "name,dateLastActivity,shortUrl,url",
      lists: "open",
      list_fields: "name,pos,closed,color",
      cards: "open",
      card_fields: CARD_FIELDS,
      labels: "all",
      label_fields: "name,color",
      members: "all",
      member_fields: "fullName,username",
    },
    ...callOptions(options),
  });
  return presentTrelloBoard(board, options.search || "");
}

export function presentTrelloBoard(input: unknown, search: unknown = ""): { payload: TrelloBoardView; columns: BoardColumn[] } {
  const board = Board.parse(input);
  const columns = boardColumns(board.lists);
  const labels = itemsOf(board.labels);
  const labelById = new Map(labels.map((label): [unknown, unknown] => [readId(label), label]));
  const memberById = new Map(itemsOf(board.members).map((member): [unknown, unknown] => [Member.parse(member).id, member]));
  const needle = String(search || "").trim().toLowerCase();
  const tasks = [...itemsOf(board.cards)]
    .sort((a, b) => (Number(Card.parse(a).pos) || 0) - (Number(Card.parse(b).pos) || 0))
    .filter((card) => {
      if (!card) return false;
      const parsed = Card.parse(card);
      return !parsed.closed && ticketId(parsed.id) !== null;
    })
    .filter((card) => {
      if (!needle) return true;
      const parsed = Card.parse(card);
      return `${parsed.name || ""}\n${parsed.desc || ""}`.toLowerCase().includes(needle);
    })
    .map((card) => presentCard(card, columns, labelById, memberById));
  return {
    payload: {
      provider: "trello",
      project: { id: board.id || "", title: board.name || "" },
      url: board.shortUrl || board.url || "",
      columns: columns.map((column) => (
        column.color
          ? { value: column.id, title: column.title, colorName: column.color, color: labelColor(column.color) }
          : { value: column.id, title: column.title }
      )),
      labels: presentLabels(labels),
      tasks,
      truncated: false,
      activity: board.dateLastActivity || null,
    },
    columns,
  };
}

export function presentCard(
  input: unknown,
  columns: BoardColumn[] | null = [],
  labelById = new Map<unknown, unknown>(),
  memberById = new Map<unknown, unknown>(),
): TrelloTask {
  const card = Card.parse(input);
  const labels = card.labels && card.labels.some((label) => {
    const parsed = Label.parse(label);
    return parsed.name || parsed.title;
  })
    ? card.labels
    : labelIds(card.idLabels).map((id) => labelById.get(id)).filter(Boolean);
  const column = (columns || []).find((item) => item.id === card.idList);
  const reference = typeof card.idShort === "number" && Number.isInteger(card.idShort) ? card.idShort : null;
  if (input === null || input === undefined) throw new Error("Trello returned no card");
  return {
    id: card.id,
    project_id: card.idBoard || "",
    title: card.name || "",
    description: card.desc || null,
    note: null,
    revision: card.dateLastActivity || null,
    reference,
    attributes: { status: card.idList || null },
    linkStatus: column?.title || null,
    labels: presentLabels(labels),
    assignees: presentMembers(card.members ?? (card.idMembers ?? []).map((id) => memberById.get(id)).filter(Boolean)),
    due: typeof card.due === "string" && card.due ? card.due : null,
    dueDone: card.dueComplete === true,
    commentCount: typeof card.badges.comments === "number" ? card.badges.comments : null,
    checkCount: typeof card.badges.checkItems === "number" && card.badges.checkItems > 0
      ? { done: Number(card.badges.checkItemsChecked) || 0, total: card.badges.checkItems }
      : null,
    url: typeof card.shortUrl === "string" && card.shortUrl ? card.shortUrl : null,
    updated: typeof card.dateLastActivity === "string" ? card.dateLastActivity : null,
  };
}

function presentMembers(members: unknown[]): BoardPerson[] {
  return members.flatMap((item) => {
    const member = Member.parse(item);
    const found = person(member.id, member.fullName || member.username);
    return found ? [found] : [];
  });
}

// Trello lists comments newest first; the detail shows them oldest first.
export function presentComments(actions: unknown, me = ""): BoardComment[] {
  return [...itemsOf(actions)].reverse().flatMap((item) => {
    const comment = presentComment(item, me);
    return comment.id && comment.body ? [comment] : [];
  });
}

function presentComment(item: unknown, me: string, fallback = ""): BoardComment {
  const action = Action.parse(item);
  const author = action.memberCreator.id ?? action.idMemberCreator;
  return {
    id: action.id,
    body: String(action.data.text || fallback).trim(),
    author: person(author, action.memberCreator.fullName || action.memberCreator.username),
    created: typeof action.date === "string" ? action.date : null,
    mine: Boolean(me) && String(author ?? "") === me,
  };
}

export function intakeList(columns: BoardColumn[] | null | undefined): BoardColumn | null {
  return (columns || []).find((column) => column.title.toLowerCase() === "open") || columns?.[0] || null;
}

export function resolveColumn(columns: BoardColumn[] | null | undefined, status: unknown): BoardColumn | null {
  const raw = String(status ?? "").trim();
  if (!raw) return null;
  const byId = (columns || []).find((column) => column.id === raw);
  if (byId) return byId;
  const folded = stripHidden(raw).toLowerCase();
  const matches = (columns || []).filter((column) => stripHidden(column.title).toLowerCase() === folded);
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

export async function readTrelloCard(connection: TrelloConnection, cardId: unknown, options?: BoardCallOptions): Promise<TrelloCard> {
  requireConnection(connection);
  const id = ticketId(cardId);
  if (!isHexId(id)) throw trelloError(400, "Choose a ticket");
  const card = await trelloFetch(connection, "GET", `/cards/${id}`, {
    query: {
      fields: CARD_FIELDS,
      members: "true",
      member_fields: "fullName,username",
    },
    ...callOptions(options),
  });
  const labels = await trelloFetch(connection, "GET", `/cards/${id}/labels`, callOptions(options));
  if (card === null || typeof card !== "object") throw new Error("Trello returned no card");
  return { ...Card.parse(card), labels: itemsOf(labels) };
}

export async function createTrelloCard(
  connection: TrelloConnection,
  columns: BoardColumn[],
  { title, description }: { title?: unknown; description?: unknown },
  options?: BoardCallOptions,
): Promise<TrelloTask> {
  requireConnection(connection);
  const list = intakeList(columns);
  if (!list) throw trelloError(400, "This board has no lists");
  const name = clip(title, 200);
  if (!name) throw trelloError(400, "Name the ticket");
  const desc = description ? String(description).trim().slice(0, 8000) : "";
  const body = desc ? { idList: list.id, name, desc } : { idList: list.id, name };
  const created = await trelloFetch(connection, "POST", "/cards", { body, ...callOptions(options) });
  return presentCard(created, columns);
}

export async function moveTrelloCard(
  connection: TrelloConnection,
  cardId: unknown,
  status: unknown,
  columns: BoardColumn[],
  options?: BoardCallOptions,
  extra?: MoveExtra,
): Promise<TrelloTask> {
  requireConnection(connection);
  const column = resolveColumn(columns, status);
  if (!column) throw trelloError(400, "Choose a column");
  const id = ticketId(cardId);
  const near = id === null ? null : neighbors(extra?.order, id);
  const pos = near ? await cardPos(connection, near.above, near.below, options) : undefined;
  await trelloFetch(connection, "PUT", `/cards/${id}`, {
    body: pos === undefined ? { idList: column.id } : { idList: column.id, pos },
    ...callOptions(options),
  });
  return presentCard(await readTrelloCard(connection, cardId, options), columns);
}

export async function editTrelloCard(
  connection: TrelloConnection,
  cardId: unknown,
  body: TicketEdit,
  columns: BoardColumn[],
  options?: BoardCallOptions,
): Promise<TrelloTask> {
  requireConnection(connection);
  if (body.revision === undefined || body.revision === null || body.revision === "") {
    throw trelloError(400, "Reload this ticket");
  }
  const current = await readTrelloCard(connection, cardId, options);
  if (String(current.dateLastActivity || "") !== String(body.revision)) {
    throw trelloError(409, "Someone else edited this ticket");
  }
  const patch: { name?: string; desc?: string } = {};
  if (body.title !== undefined) {
    const title = clip(body.title, 200);
    if (!title) throw trelloError(400, "Name the ticket");
    if (title !== (current.name || "")) patch.name = title;
  }
  if (body.description !== undefined) {
    const text = (body.description ?? "").trim().slice(0, 8000);
    if (text !== (current.desc || "")) patch.desc = text;
  }
  if (Object.keys(patch).length) {
    await trelloFetch(connection, "PUT", `/cards/${ticketId(cardId)}`, { body: patch, ...callOptions(options) });
  }
  return presentCard(await readTrelloCard(connection, cardId, options), columns);
}

// A card position between the cards above and below. Trello positions stay above zero.
async function cardPos(connection: TrelloConnection, above: TicketId | null, below: TicketId | null, options?: BoardCallOptions): Promise<number | string> {
  const posOf = async (id: TicketId | null) => {
    if (id === null) return null;
    const card = Card.parse(await trelloFetch(connection, "GET", `/cards/${id}`, { query: { fields: "pos" }, ...callOptions(options) }));
    const pos = Number(card.pos);
    return Number.isFinite(pos) ? pos : null;
  };
  const top = await posOf(above);
  const bottom = await posOf(below);
  if (top === null) return bottom === null ? "bottom" : bottom / 2;
  if (bottom === null) return "bottom";
  return (top + bottom) / 2;
}

export async function colorTrelloList(connection: TrelloConnection, listId: unknown, color: unknown, options?: BoardCallOptions): Promise<string | null> {
  requireConnection(connection);
  const id = ticketId(listId);
  if (!isHexId(id)) throw trelloError(400, "Choose a column");
  const name = color == null || color === "" ? null : listColorName(color);
  if (color && !name) throw trelloError(400, "Choose a color");
  try {
    await trelloFetch(connection, "PUT", `/lists/${id}`, { body: { color: name }, ...callOptions(options) });
  } catch (error) {
    if (name) throw error;
  }
  return name;
}

export async function trelloChecklists(connection: TrelloConnection, cardId: unknown, options?: BoardCallOptions): Promise<TrelloChecklist[]> {
  requireConnection(connection);
  const id = ticketId(cardId);
  if (!isHexId(id)) throw trelloError(400, "Choose a ticket");
  const lists = await trelloFetch(connection, "GET", `/cards/${id}/checklists`, {
    query: { fields: "name,pos", checkItems: "all", checkItem_fields: "name,state,pos" },
    ...callOptions(options),
  });
  return byPos(itemsOf(lists).map((item) => Checklist.parse(item))).flatMap((list) => (
    isHexId(list.id)
      ? [{
          id: list.id,
          title: String(list.name ?? "").trim(),
          items: byPos((list.checkItems ?? []).map((item) => CheckItem.parse(item))).flatMap((item) => (
            isHexId(item.id) ? [{ id: item.id, title: String(item.name ?? "").trim(), done: item.state === "complete" }] : []
          )),
        }]
      : []
  ));
}

export async function checkTrelloItem(connection: TrelloConnection, cardId: unknown, itemId: string, done: boolean, options?: BoardCallOptions): Promise<void> {
  requireConnection(connection);
  const card = ticketId(cardId);
  if (!isHexId(card) || !isHexId(itemId)) throw trelloError(400, "Choose a checklist item");
  await trelloFetch(connection, "PUT", `/cards/${card}/checkItem/${itemId}`, {
    body: { state: done ? "complete" : "incomplete" },
    ...callOptions(options),
  });
}

export async function addTrelloCheckItem(connection: TrelloConnection, checklistId: string, title: string, options?: BoardCallOptions): Promise<void> {
  requireConnection(connection);
  if (!isHexId(checklistId)) throw trelloError(400, "Choose a checklist");
  await trelloFetch(connection, "POST", `/checklists/${checklistId}/checkItems`, { body: { name: title }, ...callOptions(options) });
}

function byPos<T extends { pos?: unknown }>(items: T[]): T[] {
  return [...items].sort((a, b) => Number(a.pos ?? 0) - Number(b.pos ?? 0));
}

export async function archiveTrelloCard(connection: TrelloConnection, cardId: unknown, options?: BoardCallOptions): Promise<void> {
  requireConnection(connection);
  await trelloFetch(connection, "PUT", `/cards/${ticketId(cardId)}`, {
    body: { closed: true },
    ...callOptions(options),
  });
}

export async function listTrelloComments(connection: TrelloConnection, cardId: unknown, options?: BoardCallOptions): Promise<BoardComment[]> {
  requireConnection(connection);
  const actions = await trelloFetch(connection, "GET", `/cards/${ticketId(cardId)}/actions`, {
    query: { filter: "commentCard" },
    ...callOptions(options),
  });
  return presentComments(actions, await trelloMemberId(connection, options));
}

export async function addTrelloComment(
  connection: TrelloConnection,
  cardId: unknown,
  text: string,
  options?: BoardCallOptions,
): Promise<BoardComment> {
  requireConnection(connection);
  const created = await trelloFetch(connection, "POST", `/cards/${ticketId(cardId)}/actions/comments`, {
    body: { text },
    ...callOptions(options),
  });
  return presentComment(created, await trelloMemberId(connection, options), text);
}

export async function editTrelloComment(
  connection: TrelloConnection,
  commentId: string,
  text: string,
  options?: BoardCallOptions,
): Promise<BoardComment> {
  requireConnection(connection);
  if (!isHexId(ticketId(commentId))) throw trelloError(400, "Choose a comment");
  const edited = await trelloFetch(connection, "PUT", `/actions/${commentId}`, { body: { text }, ...callOptions(options) });
  return presentComment(edited, await trelloMemberId(connection, options), text);
}

export async function deleteTrelloComment(connection: TrelloConnection, commentId: string, options?: BoardCallOptions): Promise<void> {
  requireConnection(connection);
  if (!isHexId(ticketId(commentId))) throw trelloError(400, "Choose a comment");
  await trelloFetch(connection, "DELETE", `/actions/${commentId}`, callOptions(options));
}

// The connected member's id. Empty when Trello does not say, so no comment reads as yours.
export async function trelloMemberId(connection: TrelloConnection, options?: BoardCallOptions): Promise<string> {
  const known = memberIds.get(connection.token);
  if (known) return known;
  try {
    const me = Member.parse(await trelloFetch(connection, "GET", "/members/me", { query: { fields: "id" }, ...callOptions(options) }));
    const id = typeof me.id === "string" ? me.id : "";
    if (id) memberIds.set(connection.token, id);
    return id;
  } catch {
    return "";
  }
}

export async function addTrelloLabel(
  connection: TrelloConnection,
  boardId: unknown,
  cardId: unknown,
  title: unknown,
  columns: BoardColumn[],
  options?: BoardCallOptions,
): Promise<TrelloLabelAdded> {
  requireConnection(connection);
  const name = clip(title, 40);
  if (!name) throw trelloError(400, "Name the label");
  const existing = await trelloFetch(connection, "GET", `/boards/${boardId}/labels`, callOptions(options));
  let label = itemsOf(existing).find((item) => Label.parse(item).name === name);
  if (!label) {
    label = await trelloFetch(connection, "POST", "/labels", {
      body: { name, color: "blue", idBoard: boardId },
      ...callOptions(options),
    });
  }
  if (cardId) {
    await trelloFetch(connection, "POST", `/cards/${ticketId(cardId)}/idLabels`, {
      body: { value: readId(label) },
      ...callOptions(options),
    });
  }
  const task = cardId ? presentCard(await readTrelloCard(connection, cardId, options), columns) : null;
  const [presented] = presentLabels([label]);
  return { label: presented, task };
}

export async function attachTrelloLabel(
  connection: TrelloConnection,
  cardId: unknown,
  labelId: unknown,
  columns: BoardColumn[],
  options?: BoardCallOptions,
): Promise<TrelloTask> {
  requireConnection(connection);
  const id = ticketId(labelId);
  if (id === null) throw trelloError(400, "Choose a label");
  await trelloFetch(connection, "POST", `/cards/${ticketId(cardId)}/idLabels`, {
    body: { value: id },
    ...callOptions(options),
  });
  return presentCard(await readTrelloCard(connection, cardId, options), columns);
}

export async function removeTrelloLabel(
  connection: TrelloConnection,
  cardId: unknown,
  labelId: unknown,
  columns: BoardColumn[],
  options?: BoardCallOptions,
): Promise<TrelloTask> {
  requireConnection(connection);
  const id = ticketId(labelId);
  if (id === null) throw trelloError(400, "Choose a label");
  await trelloFetch(connection, "DELETE", `/cards/${ticketId(cardId)}/idLabels/${id}`, callOptions(options));
  return presentCard(await readTrelloCard(connection, cardId, options), columns);
}

// Links attached to the card are left out.
export async function listTrelloFiles(connection: TrelloConnection, cardId: unknown, options?: BoardCallOptions): Promise<unknown[]> {
  requireConnection(connection);
  const items = itemsOf(await trelloFetch(connection, "GET", `/cards/${cardIdOf(cardId)}/attachments`, callOptions(options)));
  return items.flatMap((item) => {
    const file = Attachment.parse(item);
    return file.isUpload === true ? [presentFile(file)] : [];
  });
}

export async function addTrelloFile(connection: TrelloConnection, cardId: unknown, name: string, file: Blob, options?: BoardCallOptions): Promise<unknown> {
  requireConnection(connection);
  const form = new FormData();
  form.append("file", file, name);
  const added = await trelloFetch(connection, "POST", `/cards/${cardIdOf(cardId)}/attachments`, { ...callOptions(options), timeoutMs: FILE_TIMEOUT_MS, body: form });
  return presentFile(Attachment.parse(added));
}

// Trello serves an upload's bytes only to its key and token in an OAuth header.
export async function readTrelloFile(connection: TrelloConnection, cardId: unknown, fileId: string, range: string | undefined, options?: BoardCallOptions): Promise<FileBytes> {
  requireConnection(connection);
  const attachment = `/cards/${cardIdOf(cardId)}/attachments/${fileIdOf(fileId)}`;
  const file = Attachment.parse(await trelloFetch(connection, "GET", attachment, callOptions(options)));
  if (file.isUpload !== true) throw trelloError(404, "That attachment is a link");
  const headers: Record<string, string> = {
    Accept: "*/*",
    Authorization: `OAuth oauth_consumer_key="${connection.apiKey}", oauth_token="${connection.token}"`,
  };
  if (range) headers.Range = range;
  const download = `${attachment}/download/${encodeURIComponent(String(file.fileName || file.name || "file"))}`;
  return trelloCall(connection, "GET", download, { ...callOptions(options), timeoutMs: FILE_TIMEOUT_MS, headers }, fileBytes);
}

export async function deleteTrelloFile(connection: TrelloConnection, cardId: unknown, fileId: string, options?: BoardCallOptions): Promise<void> {
  requireConnection(connection);
  await trelloFetch(connection, "DELETE", `/cards/${cardIdOf(cardId)}/attachments/${fileIdOf(fileId)}`, callOptions(options));
}

export function trelloError(status: number, message: string): TrelloError {
  return Object.assign(new Error(message), { status, code: "trello" });
}

interface TrelloRequest extends BoardCallOptions {
  query?: Record<string, unknown>;
  body?: unknown;
  headers?: Record<string, string>;
}

function trelloFetch(connection: TrelloConnection, method: string, trelloPath: string, request: TrelloRequest = {}): Promise<unknown> {
  return trelloCall(connection, method, trelloPath, request, responseJson);
}

async function trelloCall<T>(
  connection: TrelloConnection,
  method: string,
  trelloPath: string,
  { query = {}, body, headers = {}, timeoutMs = 8000, fetchImpl = fetch }: TrelloRequest,
  read: (response: BoardFetchResponse) => Promise<T>,
): Promise<T> {
  if (!connection.apiKey || !connection.token) throw trelloError(400, "Add a Trello key and token");
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
  }
  params.set("key", connection.apiKey);
  params.set("token", connection.token);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const form = body instanceof FormData;
  try {
    const response = await fetchImpl(`${API}${trelloPath}?${params}`, {
      method,
      headers: {
        Accept: "application/json",
        ...(body === undefined || form ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      body: body === undefined || form ? body : JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) throw trelloError(response.status, safeTrelloMessage(response.status, await responseJson(response), connection));
    return await read(response);
  } catch (error) {
    if (isRecord(error) && error.name === "AbortError") throw trelloError(504, "Trello did not answer");
    if (isRecord(error) && error.code === "trello") throw error;
    throw trelloError(502, "Trello is not reachable");
  } finally {
    clearTimeout(timer);
  }
}

function requireConnection(connection: TrelloConnection): void {
  if (!connection.apiKey || !connection.token) throw trelloError(400, "Add a Trello key and token");
  if (!connection.enabled) throw trelloError(400, "Enable Trello in Setup");
}

function callOptions(options: BoardCallOptions | undefined): BoardCallOptions {
  return {
    timeoutMs: options?.timeoutMs,
    fetchImpl: options?.fetchImpl,
  };
}

function presentLabels(labels: unknown): TrelloLabelView[] {
  return itemsOf(labels).flatMap((item) => {
    const label = Label.parse(item);
    const id = ticketId(label.id);
    const title = clip(label.name || label.title, 40);
    if (id === null || !title) return [];
    return [{ id, title, color: labelColor(label.color) }];
  });
}

function boardColumns(lists: unknown): BoardColumn[] {
  return itemsOf(lists)
    .flatMap((item) => {
      if (!item) return [];
      const list = List.parse(item);
      return list.closed ? [] : [list];
    })
    .sort((a, b) => (Number(a.pos) || 0) - (Number(b.pos) || 0))
    .flatMap((list) => {
      const id = ticketId(list.id);
      const title = clip(list.name, 80);
      if (!isHexId(id) || !title) return [];
      const color = listColorName(list.color);
      return [color ? { id, title, color } : { id, title }];
    });
}

function safeTrelloMessage(status: number, parsed: unknown, connection: TrelloConnection): string {
  if (status === 401) return "The Trello token was refused";
  const failure = Failure.parse(parsed);
  const message = typeof failure.message === "string" ? failure.message.trim() : "";
  if (!message || message.length > 180 || message.includes("_")) return "Trello refused the request";
  if (connection.token && message.includes(connection.token)) return "Trello refused the request";
  if (connection.apiKey && message.includes(connection.apiKey)) return "Trello refused the request";
  return message;
}

// A list as Trello sent it. Anything else reads as empty.
function itemsOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function cardIdOf(value: unknown): string {
  const id = ticketId(value);
  if (!isHexId(id)) throw trelloError(400, "Choose a ticket");
  return id;
}

function fileIdOf(value: string): string {
  if (!isHexId(value)) throw trelloError(404, "This ticket has no such file");
  return value;
}

function presentFile(file: z.output<typeof Attachment>): unknown {
  return {
    id: file.id,
    name: file.fileName || file.name || null,
    content_type: file.mimeType || null,
    size: file.bytes ?? null,
    url: file.url || null,
    created_at: file.date || null,
  };
}

function readId(value: unknown): unknown {
  return Label.parse(value).id;
}

// Card label ids. Anything that is not a list reads as no labels.
function labelIds(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function cleanSecret(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || /[\r\n]/.test(text)) return "";
  return text;
}

function clip(value: unknown, max: number): string {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, max);
}
