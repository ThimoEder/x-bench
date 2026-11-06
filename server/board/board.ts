import { z } from "zod";
import { fields, isRecord, maybe } from "../../bridge/lenient.ts";
import {
  boardError,
  boardFailure,
  flippedKinds,
  relationKinds,
  type BoardAdapter,
  type BoardCallOptions,
  type BoardFiles,
  type BoardServices,
  type BoundBoard,
  type FileBytes,
  type MoveExtra,
  type RelationKind,
  type SignedInPage,
  type ThreadTicket,
} from "./boardAdapter.ts";
import { sakAdapter } from "./sak/sakAdapter.ts";
import { jiraAdapter } from "./jira/jiraAdapter.ts";
import { canonicalCwd } from "../chat/sessions.ts";
import { trelloAdapter } from "./trello/trelloAdapter.ts";
import {
  forgetTask,
  linkThread,
  refreshBoardLinks,
  rememberTask,
  sessionForLink,
  storeLink,
  unlinkSession,
  type LinkServices,
  type StoredLink,
} from "./ticketLinks.ts";
import { answerCleanup, bindingFor, boundFolder, linksForTask, readTickets, ticketId, unbindProject, writeTickets } from "./tickets.ts";
import { hiddenInTicket, threadBrief, ticketTitle } from "./boardRules.ts";
import { stripHiddenDeep } from "./boardText.ts";
import { providerOf, type BoardProvider } from "./sources.ts";
import type { ChatActivity } from "../chat/workingChat.ts";
import type { TicketId } from "./ticketId.ts";

export interface BoardThreadRequest {
  cwd: string;
  ticket: ThreadTicket;
  // What the start sheet picked in the model menus. Empty values mean the default.
  picks: SessionPicks;
  prompt: string;
}

export interface SessionPicks {
  provider: string;
  model: string;
  effort: string;
}

// The thread the host opened, and how to send its prompt once the thread is linked to its ticket.
export interface BoardThread {
  sessionId: string;
  send: () => void;
}

// The host services the board routes use.
export interface BoardRouteServices {
  files: BoardFiles;
  fetchOptions?: BoardCallOptions;
  publish?: () => void;
  changed?: () => void;
  isDirectory?: (folder: string) => boolean;
  isChatHome?: (folder: string) => boolean;
  sessions?: () => Iterable<ChatActivity>;
  origin?: string;
  openThread?: (request: BoardThreadRequest) => BoardThread | Promise<BoardThread>;
  nameChat?: (sessionId: string, title: string) => void;
  // Starts or stops the bundled SAK after its connection is saved.
  syncSak?: () => Promise<void>;
  // Makes a SAK board of this host's own when Setup turns SAK on with no token.
  setUpSak?: (baseUrl: string) => Promise<void>;
  // The checkout a worktree was added from. A worktree without its own board binding uses that checkout's.
  projectHome?: (folder: string) => string;
  openBoardPage?: (page: SignedInPage) => Promise<unknown>;
}

export interface BoardContext<Res = unknown> extends BoardRouteServices {
  sendJson: (res: Res, status: number, body: unknown) => void;
  sendFile?: (res: Res, file: FileBytes) => void;
}

export interface BoardRequestLike {
  method?: string;
  headers?: { range?: string };
}

const BoardItemId = z.union([z.number(), z.string()]);

export const PageBody = z.object({
  baseUrl: z.string().optional(),
  email: z.string().optional(),
  token: z.string().optional(),
  apiKey: z.string().optional(),
  enabled: z.boolean().optional(),
  provider: z.string().optional(),
  cwd: z.string().optional(),
  projectId: BoardItemId.optional(),
  boardId: BoardItemId.optional(),
  taskId: BoardItemId.optional(),
  otherTaskId: BoardItemId.optional(),
  kind: z.string().optional(),
  sessionId: z.string().optional(),
  listId: z.string().optional(),
  column: z.string().optional(),
  color: z.string().nullish(),
  status: z.string().nullish(),
  revision: z.union([z.number(), z.string()]).nullish(),
  title: z.string().optional(),
  description: z.string().nullish(),
  note: z.string().nullish(),
  body: z.string().optional(),
  prompt: z.string().optional(),
  order: z.array(BoardItemId).optional(),
  fields: z.record(z.string(), z.string()).optional(),
  done: z.boolean().optional(),
  labels: z.array(BoardItemId).optional(),
  // Set by the host from an upload's body. JSON never carries one.
  file: z.instanceof(Blob).optional(),
  // The new session's picks for a thread. provider above is the board's.
  session: maybe(fields({ provider: maybe(z.string()), model: maybe(z.string()), effort: maybe(z.string()) })),
});

export type PageBody = z.output<typeof PageBody>;

// Whether a request belongs to the board router. /api/<provider>/* holds each source's setup routes.
export function isBoardPath(pathname: string): boolean {
  const area = /^\/api\/([a-z]+)(\/|$)/.exec(pathname)?.[1];
  return area === "board" || (area !== undefined && providerOf(area) === area);
}

// /api/sak/<route> is served as /api/board/<route>, apart from SAK's own connection routes.
// Sessions whose board rules named /api/sak keep calling it, since the rules reach the system prompt only at session/new.
export function boardRoute(pathname: string): string {
  return /^\/api\/sak(\/|$)/.test(pathname) && !/^\/api\/sak\/(status|connection|projects)$/.test(pathname)
    ? `/api/board${pathname.slice("/api/sak".length)}`
    : pathname;
}

// Parses a board request, picks the adapter from the folder's binding (or, for a task route
// without a folder, the adapter that owns the id), and sends the reply.
export async function handleBoard<Res>(
  req: BoardRequestLike,
  res: Res,
  url: URL,
  body: PageBody,
  context: BoardContext<Res>,
): Promise<void> {
  const ctx: BoardContext<Res> = { ...context, sendJson: (sent, status, reply) => context.sendJson(sent, status, stripHiddenDeep(reply)) };
  try {
    await routeBoard(req, res, url, body, ctx);
    if (req.method !== "GET" && req.method !== "HEAD") ctx.changed?.();
  } catch (error) {
    const failure = isRecord(error) ? error : {};
    if (!failure.status) {
      ctx.sendJson(res, 500, { error: failure.message || "Request failed" });
      return;
    }
    const sent = boardFailure(error);
    ctx.sendJson(res, sent.status, sent.body);
  }
}

async function routeBoard<Res>(
  req: BoardRequestLike,
  res: Res,
  url: URL,
  input: PageBody,
  ctx: BoardContext<Res>,
): Promise<void> {
  const { files } = ctx;
  const method = req.method;
  const pathname = boardRoute(url.pathname);
  const services: BoardServices = {
    files,
    fetchOptions: ctx.fetchOptions,
    folderOf: (cwd) => folderOf(cwd, ctx),
    projectHome: ctx.projectHome,
    syncSak: ctx.syncSak,
    setUpSak: ctx.setUpSak,
  };
  const byProvider: Record<BoardProvider, BoardAdapter> = { sak: sakAdapter(services), trello: trelloAdapter(services), jira: jiraAdapter(services) };
  const adapters = Object.values(byProvider);
  const links: LinkServices = {
    tickets: files.tickets,
    origin: ctx.origin,
    publish: () => ctx.publish?.(),
    sessions: () => ctx.sessions?.() || [],
    nameChat: (sessionId, title) => ctx.nameChat?.(sessionId, title),
  };
  const setup = /^\/api\/([a-z]+)\/([a-z]+)$/.exec(pathname);
  const named = adapters.find((adapter) => adapter.provider === setup?.[1]);
  if (named && method === "GET" && setup?.[2] === "status") {
    ctx.sendJson(res, 200, await named.status());
    return;
  }
  if (named && method === "PUT" && setup?.[2] === "connection") {
    ctx.sendJson(res, 200, await named.saveConnection(input));
    return;
  }
  if (named && method === "GET" && setup?.[2] === named.boardsRoute) {
    ctx.sendJson(res, 200, await named.listBoards());
    return;
  }
  if (named?.createBoard && method === "POST" && setup?.[2] === named.boardsRoute) {
    ctx.sendJson(res, 201, await named.createBoard(input.title, optionalText(input.description)));
    return;
  }
  if (method === "POST" && pathname === "/api/board/boards") {
    const folder = folderOf(input.cwd, ctx);
    const created = await byProvider[providerOf(input.provider)].bind(folder, input);
    ctx.publish?.();
    ctx.sendJson(res, 201, created);
    return;
  }
  if (method === "DELETE" && pathname === "/api/board/boards") {
    const folder = canonicalCwd(input.cwd ?? "");
    if (!folder) throw boardError(400, "Choose a folder");
    writeTickets(unbindProject(readTickets(files.tickets), folder), files.tickets);
    ctx.publish?.();
    ctx.sendJson(res, 200, { ok: true });
    return;
  }
  if (method === "GET" && pathname === "/api/board/board") {
    const { adapter, board } = boardFor(adapters, folderOf(url.searchParams.get("cwd"), ctx), files, ctx);
    const loaded = await board.load({
      search: url.searchParams.get("search") || "",
      activity: adapter.capabilities.conditionalFetch ? url.searchParams.get("activity") || "" : "",
    });
    refreshBoardLinks(links, loaded);
    ctx.sendJson(res, 200, "tasks" in loaded.view ? { ...loaded.view, capabilities: adapter.capabilities, source: adapter.label } : loaded.view);
    return;
  }
  if (method === "POST" && pathname === "/api/board/tasks") {
    const folder = folderOf(input.cwd, ctx);
    const { adapter, board } = boardFor(adapters, folder, files, ctx);
    const labels = newLabels(input.labels);
    let task = await board.createTicket({
      title: input.title,
      description: optionalText(input.description),
    });
    // A ticket added from a column gets its labels and goes there next. A source that refuses a label or
    // the move keeps the ticket as far as it got, and the page shows why on its card.
    let refused: unknown = null;
    const wanted = input.status;
    const createdId = ticketId(isRecord(task) ? task.id : null);
    const createdStatus = isRecord(task) && isRecord(task.attributes) ? task.attributes.status : undefined;
    for (const labelId of labels) {
      if (createdId === null) break;
      try {
        task = await adapter.changeLabel(createdId, labelId, true);
      } catch (error) {
        refused = boardFailure(error).body.error;
      }
    }
    if (wanted !== undefined && createdId !== null && wanted !== createdStatus) {
      try {
        task = await adapter.moveTicket(createdId, wanted, folder);
      } catch (error) {
        refused = boardFailure(error).body.error;
      }
    }
    const created = { task, ...storeLink(links, folder, input.sessionId ?? "", task), ...(refused ? { refused } : {}) };
    ctx.publish?.();
    ctx.sendJson(res, 201, created);
    return;
  }
  if (method === "POST" && pathname === "/api/board/open") {
    const { board } = boardFor(adapters, folderOf(input.cwd, ctx), files, ctx);
    if (!board.signedInPage) throw boardError(404, "This board opens in the browser");
    if (!ctx.openBoardPage) throw boardError(503, "Open the board here from X Bench's desktop app");
    ctx.sendJson(res, 200, await ctx.openBoardPage(board.signedInPage(ticketId(input.taskId))));
    return;
  }
  if (method === "POST" && pathname === "/api/board/lists") {
    const found = openBoard(adapters, folderOf(input.cwd, ctx), files, ctx);
    if (!found?.board.paintColumn) throw boardError(400, "This board has no list colors");
    const painted = await found.board.paintColumn(input.listId ?? input.column, input.color);
    ctx.publish?.();
    ctx.sendJson(res, 200, painted);
    return;
  }
  if (method === "POST" && pathname === "/api/board/move") {
    const taskId = ticketId(input.taskId);
    if (taskId === null) throw boardError(400, "Choose a ticket");
    const task = await adapterForTicket(adapters, taskId, input.cwd, files, ctx).moveTicket(taskId, input.status, input.cwd, moveExtra(input));
    rememberTask(links, task);
    ctx.sendJson(res, 200, { task });
    return;
  }
  if (method === "POST" && pathname === "/api/board/labels") {
    const { board } = boardFor(adapters, folderOf(input.cwd, ctx), files, ctx);
    const title = clean(input.title, 40);
    if (!title) throw boardError(400, "Name the label");
    ctx.sendJson(res, 201, await board.addLabel(title, input.taskId, labelColorOf(input.color)));
    return;
  }
  const boardLabel = /^\/api\/board\/labels\/([^/]+)$/.exec(pathname);
  if (boardLabel && method === "DELETE") {
    const { board } = boardFor(adapters, folderOf(input.cwd, ctx), files, ctx);
    const labelId = labelIdOf(boardLabel[1]);
    if (labelId === null) throw boardError(400, "Choose a label");
    if (!board.deleteLabel) throw boardError(400, "This board keeps its labels");
    await board.deleteLabel(labelId);
    ctx.sendJson(res, 200, { ok: true });
    return;
  }
  const taskLabel = /^\/api\/board\/tasks\/([A-Za-z0-9_-]+)\/labels\/([^/]+)$/.exec(pathname);
  if (taskLabel && (method === "PUT" || method === "DELETE")) {
    const taskId = ticketId(taskLabel[1]);
    const labelId = labelIdOf(taskLabel[2]);
    if (taskId === null || labelId === null) throw boardError(400, "Choose a ticket");
    const task = await adapterForTicket(adapters, taskId, null, files, ctx).changeLabel(taskId, labelId, method === "PUT");
    rememberTask(links, task);
    ctx.sendJson(res, 200, { task });
    return;
  }
  const checkItem = /^\/api\/board\/tasks\/([A-Za-z0-9_-]+)\/check-items\/([A-Za-z0-9_-]+)$/.exec(pathname);
  if (checkItem && method === "PUT") {
    const taskId = ticketId(checkItem[1]);
    if (taskId === null || input.done === undefined) throw boardError(400, "Choose a checklist item");
    const task = await adapterForTicket(adapters, taskId, null, files, ctx).checkItem(taskId, checkItem[2] ?? "", input.done);
    ctx.sendJson(res, 200, { task });
    return;
  }
  const checklistItems = /^\/api\/board\/tasks\/([A-Za-z0-9_-]+)\/checklists\/([A-Za-z0-9_-]+)\/items$/.exec(pathname);
  if (checklistItems && method === "POST") {
    const taskId = ticketId(checklistItems[1]);
    if (taskId === null) throw boardError(400, "Choose a checklist");
    const title = clean(input.title, 400);
    if (!title) throw boardError(400, "Name the item");
    const task = await adapterForTicket(adapters, taskId, null, files, ctx).addCheckItem(taskId, checklistItems[2] ?? "", title);
    ctx.sendJson(res, 201, { task });
    return;
  }
  const relation = /^\/api\/board\/tasks\/([A-Za-z0-9_-]+)\/relations(?:\/([A-Za-z0-9_-]+)\/([a-z_]+))?$/.exec(pathname);
  if (relation && ((method === "PUT" && !relation[2]) || (method === "DELETE" && relation[2]))) {
    const taskId = ticketId(relation[1]);
    if (taskId === null) throw boardError(400, "Choose a ticket");
    const adapter = adapterForTicket(adapters, taskId, input.cwd, files, ctx);
    if (!adapter.changeRelation) throw boardError(400, "This board has no ticket relations", adapter.provider);
    const otherId = ticketId(method === "PUT" ? input.otherTaskId : relation[2]);
    if (otherId === null || !adapter.claims(otherId)) throw boardError(400, "Choose the other ticket");
    if (String(otherId) === String(taskId)) throw boardError(400, "A ticket can't relate to itself");
    const stored = storedRelation(taskId, otherId, method === "PUT" ? input.kind : relation[3]);
    if (!stored) throw boardError(400, "Choose a relation kind, such as parent, subtask or blocks");
    await adapter.changeRelation(stored.taskId, stored.otherId, stored.kind, method === "PUT");
    ctx.sendJson(res, 200, { task: await adapter.readTicket(taskId) });
    return;
  }
  const brief = /^\/api\/board\/tasks\/([A-Za-z0-9_-]+)\/brief$/.exec(pathname);
  if (brief && method === "GET") {
    ctx.sendJson(res, 200, await ticketBrief(adapters, url.searchParams.get("cwd"), brief[1] ?? "", files, ctx));
    return;
  }
  const moves = /^\/api\/board\/tasks\/([A-Za-z0-9_-]+)\/moves$/.exec(pathname);
  if (moves && method === "GET") {
    const taskId = ticketId(moves[1]);
    if (taskId === null) throw boardError(400, "Choose a ticket");
    ctx.sendJson(res, 200, { moves: await adapterForTicket(adapters, taskId, url.searchParams.get("cwd"), files, ctx).moves(taskId) });
    return;
  }
  if (await routeTaskFile(req, res, url, input, adapters, ctx)) return;
  const comment = /^\/api\/board\/tasks\/([A-Za-z0-9_-]+)\/comments\/([A-Za-z0-9_-]+)$/.exec(pathname);
  if (comment && (method === "PATCH" || method === "DELETE")) {
    const taskId = ticketId(comment[1]);
    const commentId = comment[2] ?? "";
    if (taskId === null || !commentId) throw boardError(400, "Choose a comment");
    const adapter = adapterForTicket(adapters, taskId, null, files, ctx);
    if (method === "DELETE") {
      await adapter.deleteComment(taskId, commentId);
      ctx.sendJson(res, 200, { ok: true });
      return;
    }
    const text = optionalText(input.body);
    if (!text) throw boardError(400, "Write a comment first");
    ctx.sendJson(res, 200, await adapter.editComment(taskId, commentId, text));
    return;
  }
  const comments = /^\/api\/board\/tasks\/([A-Za-z0-9_-]+)\/comments$/.exec(pathname);
  if (comments && method === "POST") {
    const taskId = ticketId(comments[1]);
    if (taskId === null) throw boardError(400, "Choose a ticket");
    // A comment keeps its line breaks, the same as a description.
    const text = optionalText(input.body);
    if (!text) throw boardError(400, "Write a comment first");
    ctx.sendJson(res, 201, await adapterForTicket(adapters, taskId, null, files, ctx).addComment(taskId, text));
    return;
  }
  const taskPath = /^\/api\/board\/tasks\/([A-Za-z0-9_-]+)$/.exec(pathname);
  if (taskPath && method === "DELETE") {
    const taskId = ticketId(taskPath[1]);
    if (taskId === null) throw boardError(400, "Choose a ticket");
    await adapterForTicket(adapters, taskId, null, files, ctx).deleteTicket(taskId);
    forgetTask(links, taskId);
    ctx.publish?.();
    ctx.sendJson(res, 200, { ok: true });
    return;
  }
  if (taskPath && method === "GET") {
    const taskId = ticketId(taskPath[1]);
    if (taskId === null) throw boardError(400, "Choose a ticket");
    const adapter = adapterForTicket(adapters, taskId, null, files, ctx);
    const task = await adapter.readTicket(taskId);
    rememberTask(links, task);
    const comments = await adapter.comments(taskId);
    ctx.sendJson(res, 200, { task, comments, links: linksForTask(readTickets(files.tickets), taskId) });
    return;
  }
  if (taskPath && method === "PATCH") {
    const taskId = ticketId(taskPath[1]);
    if (taskId === null) throw boardError(400, "Choose a ticket");
    const task = await adapterForTicket(adapters, taskId, null, files, ctx).editTicket(taskId, input);
    rememberTask(links, task);
    ctx.sendJson(res, 200, { task });
    return;
  }
  if (method === "POST" && pathname === "/api/board/threads") {
    const opened = await openThread(adapters, input, files, links, ctx);
    ctx.sendJson(res, 201, opened);
    return;
  }
  if (method === "POST" && pathname === "/api/board/links") {
    const linked = await linkExisting(adapters, input, files, links, ctx);
    ctx.publish?.();
    ctx.sendJson(res, 200, linked);
    return;
  }
  if (method === "DELETE" && pathname === "/api/board/links") {
    const sessionId = input.sessionId ?? "";
    const taskId = ticketId(input.taskId);
    if (!sessionId || taskId === null) throw boardError(400, "Choose a ticket thread");
    unlinkSession(links, sessionId, taskId);
    ctx.publish?.();
    ctx.sendJson(res, 200, { ok: true });
    return;
  }
  if (method === "DELETE" && pathname === "/api/board/links/cleanup") {
    const sessionId = String(input.sessionId || "");
    if (!sessionId) throw boardError(400, "Choose a chat");
    writeTickets(answerCleanup(readTickets(files.tickets), sessionId), files.tickets);
    ctx.publish?.();
    ctx.sendJson(res, 200, { ok: true });
    return;
  }
  ctx.sendJson(res, 404, { error: "Not found" });
}

async function routeTaskFile<Res>(req: BoardRequestLike, res: Res, url: URL, input: PageBody, adapters: BoardAdapter[], ctx: BoardContext<Res>): Promise<boolean> {
  // A read may end the file's id in an extension, which the page uses to tell a clip from a picture.
  const taskFile = /^\/api\/board\/tasks\/([A-Za-z0-9_-]+)\/files(?:\/([A-Za-z0-9_-]+)(?:\.[a-z0-9]{1,5})?)?$/.exec(boardRoute(url.pathname));
  if (!taskFile) return false;
  const taskId = ticketId(taskFile[1]);
  if (taskId === null) throw boardError(400, "Choose a ticket");
  const store = adapterForTicket(adapters, taskId, url.searchParams.get("cwd"), ctx.files, ctx).files;
  const fileId = taskFile[2];
  if (!fileId && req.method === "GET") {
    ctx.sendJson(res, 200, { files: await store.list(taskId) });
    return true;
  }
  if (!fileId && req.method === "POST") {
    const name = (url.searchParams.get("name") ?? "").trim();
    if (!/^[^\p{Cc}]{1,255}$/u.test(name)) throw boardError(400, "Name the file, for example ?name=shot.png");
    if (!input.file?.size) throw boardError(400, "Send the file as the body");
    ctx.sendJson(res, 201, await store.add(taskId, name, input.file));
    return true;
  }
  if (fileId && req.method === "GET" && ctx.sendFile) {
    ctx.sendFile(res, await store.read(taskId, fileId, req.headers?.range));
    return true;
  }
  if (fileId && req.method === "DELETE") {
    await store.remove(taskId, fileId);
    ctx.sendJson(res, 200, { ok: true });
    return true;
  }
  return false;
}

interface FolderBoard {
  adapter: BoardAdapter;
  board: BoundBoard;
}

// The folder's board, from its binding in tickets.json or its checkout's. null when neither has one.
function openBoard(adapters: BoardAdapter[], folder: string, files: BoardFiles, ctx: BoardRouteServices): FolderBoard | null {
  const state = readTickets(files.tickets);
  const bound = boundFolder(state, folder, ctx.projectHome);
  const binding = bindingFor(state, bound);
  if (!binding) return null;
  for (const adapter of adapters) {
    const board = adapter.open(bound, binding);
    if (board) return { adapter, board };
  }
  return null;
}

function boardFor(adapters: BoardAdapter[], folder: string, files: BoardFiles, ctx: BoardRouteServices): FolderBoard {
  const found = openBoard(adapters, folder, files, ctx);
  if (!found) throw boardError(404, "This folder has no board");
  return found;
}

// The source a task route talks to. A request that names a bound folder uses that folder's
// binding. Without one, the source that owns the id's form answers.
function adapterForTicket(adapters: BoardAdapter[], taskId: TicketId, cwd: unknown, files: BoardFiles, ctx: BoardRouteServices): BoardAdapter {
  const folder = cwd ? canonicalCwd(String(cwd)) : "";
  const bound = folder ? openBoard(adapters, folder, files, ctx) : null;
  if (bound) {
    if (!bound.adapter.claims(taskId)) throw boardError(404, "That ticket is on another board");
    return bound.adapter;
  }
  const owner = adapters.find((adapter) => adapter.claims(taskId));
  if (!owner) throw boardError(400, "Choose a ticket");
  return owner;
}

async function linkExisting(
  adapters: BoardAdapter[],
  body: PageBody,
  files: BoardFiles,
  links: LinkServices,
  ctx: BoardRouteServices,
): Promise<StoredLink> {
  const folder = folderOf(body.cwd, ctx);
  const { adapter, board } = boardFor(adapters, folder, files, ctx);
  const taskId = ticketId(body.taskId);
  if (taskId === null) throw boardError(400, "Choose a ticket");
  const sessionId = sessionForLink(links, body.sessionId, folder);
  if (!adapter.claims(taskId)) throw boardError(404, "That ticket is on another board");
  return storeLink(links, folder, sessionId, await board.ticketOnBoard(taskId));
}

// The text a thread from this card starts with, cleaned, for the page's draft. Nothing is opened or sent.
async function ticketBrief(adapters: BoardAdapter[], cwd: unknown, id: string, files: BoardFiles, ctx: BoardRouteServices) {
  const { adapter, board } = boardFor(adapters, folderOf(cwd, ctx), files, ctx);
  const taskId = ticketId(id);
  if (taskId === null) throw boardError(400, "Choose a ticket");
  const ticket = adapter.threadTicket(await board.ticketOnBoard(taskId));
  return { draft: threadBrief(ticket), hidden: hiddenInTicket(ticket), title: ticketTitle(ticket) };
}

async function openThread(adapters: BoardAdapter[], body: PageBody, files: BoardFiles, links: LinkServices, ctx: BoardRouteServices) {
  const folder = folderOf(body.cwd, ctx);
  const { adapter, board } = boardFor(adapters, folder, files, ctx);
  const taskId = ticketId(body.taskId);
  if (taskId === null) throw boardError(400, "Choose a ticket");
  const prompt = body.prompt?.trim() ?? "";
  if (!prompt) throw boardError(400, "Write the prompt first");
  const task = await board.ticketOnBoard(taskId);
  if (!ctx.openThread) throw boardError(500, "Couldn't start the chat");
  const picks = body.session ?? {};
  const opened = await ctx.openThread({
    cwd: folder,
    ticket: adapter.threadTicket(task),
    picks: { provider: picks.provider ?? "", model: picks.model ?? "", effort: picks.effort ?? "" },
    prompt,
  });
  const link = linkThread(links, opened.sessionId, task, taskId);
  opened.send();
  ctx.publish?.();
  return { sessionId: opened.sessionId, link };
}

function folderOf(cwd: unknown, ctx: BoardRouteServices): string {
  const folder = canonicalCwd(String(cwd || ""));
  if (!folder) throw boardError(400, "Choose a folder");
  if (ctx.isChatHome?.(folder)) throw boardError(400, "Chat has no board");
  if (ctx.isDirectory && !ctx.isDirectory(folder)) throw boardError(400, "Folder does not exist");
  return folder;
}

function clean(value: string | undefined, max: number): string {
  return (value ?? "").trim().replace(/\s+/g, " ").slice(0, max);
}

// What a move carries besides its column. Anything malformed is left out.
function moveExtra(input: PageBody): MoveExtra {
  const extra: MoveExtra = {};
  if (input.order) {
    extra.order = input.order.slice(0, 1000).flatMap((item) => {
      const id = ticketId(item);
      return id === null ? [] : [id];
    });
  }
  if (input.fields) {
    extra.fields = Object.fromEntries(Object.entries(input.fields)
      .slice(0, 20)
      .filter(([key]) => /^[A-Za-z0-9_.-]{1,80}$/.test(key)));
  }
  return extra;
}

// The relation as it is stored. A flipped spelling, such as subtask, is stored from the other ticket.
function storedRelation(taskId: TicketId, otherId: TicketId, kind: string | undefined): { taskId: TicketId; otherId: TicketId; kind: RelationKind } | null {
  const named = relationKinds.find((item) => item === kind);
  if (named) return { taskId, otherId, kind: named };
  const flipped = kind === undefined ? undefined : flippedKinds.get(kind);
  return flipped ? { taskId: otherId, otherId: taskId, kind: flipped } : null;
}

// A label id from the route: SAK's number, or Trello's id or a Jira label, which is a word with a letter or
// digit in it. A Jira label is case-sensitive, so the text stays as sent.
export function labelIdOf(raw: string | undefined): TicketId | null {
  try {
    return labelIdText(decodeURIComponent(raw ?? ""));
  } catch {
    return null;
  }
}

function labelIdText(value: string): TicketId | null {
  const text = value.trim();
  const id = ticketId(text);
  if (typeof id === "number") return id;
  return /^[^\s/\\?#]{1,255}$/.test(text) && /[\p{L}\p{N}]/u.test(text) ? text : null;
}

function newLabels(value: TicketId[] | undefined): TicketId[] {
  if (!value) return [];
  if (value.length > 20) throw boardError(400, "A new ticket takes at most 20 labels");
  return value.map((item) => {
    const id = labelIdText(String(item));
    if (id === null) throw boardError(400, "Choose the labels");
    return id;
  });
}

function labelColorOf(value: string | null | undefined): string | null {
  if (!value) return null;
  if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
  throw boardError(400, "Choose a color");
}

function optionalText(value: string | null | undefined): string | undefined {
  const text = value?.trim();
  return text ? text.slice(0, 8000) : undefined;
}
