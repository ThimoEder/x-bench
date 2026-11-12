import { MCP_SERVER } from "../mcp/mcp.ts";
import { resolveMoves, type BoardSettings, type MoveColumn, type MoveKey } from "./boardSettings.ts";
import { stripHidden } from "./boardText.ts";
import { ticketId } from "./ticketId.ts";

export const CHAT_ID_TOOL = "chat_id";

export const BOARD_TOOLS = {
  read: "board_read",
  readTicket: "board_read_ticket",
  create: "board_create_ticket",
  edit: "board_edit_ticket",
  move: "board_move_ticket",
  comment: "board_comment",
  relate: "board_relate",
  attach: "board_attach_file",
  files: "board_files",
  readFile: "board_read_file",
  deleteFile: "board_delete_file",
  link: "board_link_chat",
} as const;

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

// Harnesses hide MCP tools until the agent looks for them, so every rule names its tool.
export function toolsRule(board: string, holds: string, source: string): string {
  return `This folder has ${board}. Work on its tickets with the board_ tools of the ${MCP_SERVER} MCP server, which already holds ${holds}. Do not call ${source} directly.`;
}

function moveWith(column: MoveColumn): string {
  return `Move it with the ${BOARD_TOOLS.move} tool and status ${JSON.stringify(column.status)}.`;
}

export function startRule(column: MoveColumn | null): string[] {
  if (!column) return [];
  return [`Starting work on a ticket moves it to ${column.title}. ${moveWith(column)}`];
}

export function reviewRule(column: MoveColumn | null): string[] {
  if (!column) return [];
  return [`Opening a pull request that is not a draft, or marking a draft pull request ready for review, moves the ticket to ${column.title}. ${moveWith(column)} A draft pull request leaves the ticket where it is.`];
}

export function doneRule(column: MoveColumn | null): string {
  if (!column) return "A merge, or a commit on main, asks which column the ticket should move to when the work is clearly finished, and waits for the answer.";
  return `A merge, or a commit on main, moves the ticket to ${column.title} when the work is clearly finished. ${moveWith(column)} If it is not clear that everything is finished, ask which column it should move to, and wait for the answer.`;
}

export function createRule(column: string): string {
  return `Create a ticket only when the user mentions a ticket in the thread. An investigation does not get one on its own. Create it with the ${BOARD_TOOLS.create} tool. The description says in a few sentences what the work is, why it matters, and when it is done. The tool puts the ticket in ${column} and leaves this chat unlinked.`;
}

export function editRule(): string {
  return `Change a ticket's title or description with the ${BOARD_TOOLS.edit} tool. Read the ticket's revision with ${BOARD_TOOLS.readTicket} right before the edit, and send it back exactly as it reads. When the tool refuses the edit with 409, read the ticket again and redo the edit on its new text.`;
}

export function commentRule(): string {
  return `Read a ticket and its comments with the ${BOARD_TOOLS.readTicket} tool. Add a comment with ${BOARD_TOOLS.comment}.`;
}

export function fileRule(shown: string): string {
  return `Attach a screenshot or a screen recording to a ticket with the ${BOARD_TOOLS.attach} tool and the file's path. ${shown} List a ticket's files with ${BOARD_TOOLS.files}, save one to open it with ${BOARD_TOOLS.readFile}, and delete one with ${BOARD_TOOLS.deleteFile}.`;
}

export function attachRule(): string {
  return `Link this chat when you create a ticket and start working on it, or when the user asks you to link the ticket. Link it with the ${BOARD_TOOLS.link} tool.`;
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
