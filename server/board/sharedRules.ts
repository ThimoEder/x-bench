import { MCP_SERVER } from "../mcp/mcp.ts";
import { resolveMoves, type BoardSettings, type MoveColumn, type MoveKey } from "./boardSettings.ts";
import { stripHidden } from "./boardText.ts";
import { ticketId } from "./ticketId.ts";

export const CHAT_ID_TOOL = "chat_id";

// The ticket a card thread opens with. Every field is coerced here, so any value reads.
export interface BoardTicket {
  id?: unknown;
  taskId?: unknown;
  title?: unknown;
  status?: unknown;
  description?: unknown;
  note?: unknown;
}

// Column names come from whoever edits the board, so a rule names a column only when the user picked it in the
// board settings, or its name is one a move looks for.
export function movesFor(columns: readonly MoveColumn[], settings: BoardSettings): Record<MoveKey, MoveColumn | null> {
  const clean = (column: MoveColumn | null) => (column && { status: column.status, title: oneLine(column.title) || column.status });
  const moves = resolveMoves(columns.map((column) => ({ status: column.status, title: oneLine(column.title) })).filter((column) => column.title), settings);
  return { create: clean(moves.create), start: clean(moves.start), review: clean(moves.review), done: clean(moves.done) };
}

function moveJson(id: string, column: MoveColumn): string {
  return `{"taskId":${id},"status":${JSON.stringify(column.status)}}`;
}

export function startRule(column: MoveColumn | null, id: string): string[] {
  if (!column) return [];
  return [`Starting work on a ticket moves it to ${column.title}. Move it with POST /api/board/move and JSON ${moveJson(id, column)}.`];
}

export function reviewRule(column: MoveColumn | null, id: string): string[] {
  if (!column) return [];
  return [`Opening a pull request that is not a draft, or marking a draft pull request ready for review, moves the ticket to ${column.title}. Move it with POST /api/board/move and JSON ${moveJson(id, column)}. A draft pull request leaves the ticket where it is.`];
}

export function doneRule(column: MoveColumn | null, id: string): string {
  if (!column) return "A merge, or a commit on main, asks which column the ticket should move to when the work is clearly finished, and waits for the answer.";
  return `A merge, or a commit on main, moves the ticket to ${column.title} when the work is clearly finished. Move it with POST /api/board/move and JSON ${moveJson(id, column)}. If it is not clear that everything is finished, ask which column it should move to, and wait for the answer.`;
}

export function accessRule(tokenFile: string): string[] {
  if (!tokenFile) return [];
  // The path goes inside single quotes in a shell command, so a quote in it must not end them.
  const quoted = tokenFile.replaceAll("'", "'\\''");
  return [
    `Every request to the board API needs this app's launch token in the X-Bench-Token header. It changes each time the app starts, so read it from ${tokenFile} for each request, for example curl -H "X-Bench-Token: $(cat '${quoted}')". A POST, PUT, PATCH or DELETE also needs -H "Content-Type: application/json".`,
  ];
}

export function createRule(column: string): string {
  return `Create a ticket only when the user mentions a ticket in the thread. An investigation does not get one on its own. Create it with POST /api/board/tasks and JSON {"cwd":"<the session folder>","title":"...","description":"..."}. The description says in a few sentences what the work is, why it matters, and when it is done. The API puts the ticket in ${column} and leaves this chat unlinked.`;
}

export function editRule(): string {
  return `Change a ticket's title or description with PATCH /api/board/tasks/<id> and JSON {"revision":<current revision>,"description":"..."}, adding "title" to rename it. Read the current revision from task.revision in GET /api/board/tasks/<id> right before the edit, and send it back exactly as it reads. When the API refuses the edit with 409, read the ticket again and redo the edit on its new text.`;
}

export function commentRule(id: string): string {
  return `Read a ticket's comments with GET /api/board/tasks/${id}/comments. GET /api/board/tasks/${id} also answers them in its comments field. Add a comment with POST /api/board/tasks/${id}/comments and JSON {"body":"..."}.`;
}

export function fileRule(id: string, shown: string): string {
  return `Attach a screenshot or a screen recording to a ticket with POST /api/board/tasks/${id}/files?name=<file name>, -H "Content-Type: application/octet-stream" and the file as the body, for example --data-binary @shot.png. ${shown} List a ticket's files with GET /api/board/tasks/${id}/files, read one with GET /api/board/tasks/${id}/files/<file id>, and delete one with DELETE /api/board/tasks/${id}/files/<file id>.`;
}

export function attachRule(): string {
  return `Link this chat when you create a ticket and start working on it, or when the user asks you to link the ticket. Link it with POST /api/board/links and JSON {"cwd":"<the session folder>","taskId":"<id>","sessionId":"<this chat's id>"}. The ${CHAT_ID_TOOL} tool of the ${MCP_SERVER} MCP server answers this chat's id. Without a sessionId, the API attaches the one chat working in that folder.`;
}

export function shareRule(): string {
  return "Whenever you mention a ticket in this chat, write it as a Markdown link with the ticket's id as its text: [#<id>](?task=<id>). The app opens it on this folder's board. Write any other #<number> as plain text.";
}

// The rules only name the ticket. Its text comes in the first message, which the user has read and sent.
export function ruleText(lines: string[], ticket?: BoardTicket | null): string {
  const id = ticketRef(ticket);
  return (id ? [...lines, `This thread is for ticket ${id}. The user sends its text as the first message.`] : lines).join("\n");
}

export function ticketRef(ticket?: BoardTicket | null): string {
  const id = ticketId(ticket?.id ?? ticket?.taskId);
  return id === null ? "" : String(id);
}

export function oneLine(value: unknown): string {
  return stripHidden(value || "").trim().replace(/\s+/g, " ");
}

export function apiHome(origin: string): string {
  return String(origin || "").replace(/\/$/, "");
}
