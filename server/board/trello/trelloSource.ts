import { z } from "zod";
import { fields, maybe } from "../../../bridge/lenient.ts";
import { BOARD_TEXT_RULE, clip } from "../boardText.ts";
import type { BoardSettings } from "../boardSettings.ts";
import { accessRule, apiHome, attachRule, commentRule, createRule, doneRule, editRule, fileRule, movesFor, oneLine, reviewRule, shareRule, startRule, ruleText, type BoardTicket } from "../sharedRules.ts";
import { isHexId, ticketId } from "../ticketId.ts";

// A Trello list the board shows as a column.
export interface BoardColumn {
  id: string;
  title: string;
  color?: string;
}

export interface TrelloBinding {
  provider: "trello";
  boardId: string;
  title: string;
  columns: BoardColumn[];
}

const StoredTrello = fields({
  boardId: z.unknown().optional(),
  title: z.unknown().optional(),
  columns: maybe(z.array(z.unknown())),
});

const StoredColumn = fields({
  id: z.unknown().optional(),
  value: z.unknown().optional(),
  title: z.unknown().optional(),
  name: z.unknown().optional(),
  color: z.unknown().optional(),
});

const LIST_COLORS = ["green", "yellow", "orange", "red", "purple", "blue", "lime", "gray"];

export function listColorName(value: unknown): string {
  const name = String(value || "").trim().toLowerCase();
  return LIST_COLORS.includes(name) ? name : "";
}

function trelloBinding(input: unknown): TrelloBinding | null {
  const stored = StoredTrello.parse(input);
  const boardId = ticketId(stored.boardId);
  if (!isHexId(boardId)) return null;
  return { provider: "trello", boardId, title: clip(stored.title, 200) || boardId, columns: boardColumns(stored.columns) };
}

function boardColumns(value: unknown[] | undefined): BoardColumn[] {
  const columns: BoardColumn[] = [];
  const seen = new Set<string>();
  for (const item of value ?? []) {
    const column = StoredColumn.parse(item);
    const id = ticketId(column.id ?? column.value);
    const title = clip(column.title ?? column.name, 80);
    if (!isHexId(id) || !title || seen.has(id)) continue;
    seen.add(id);
    const color = listColorName(column.color);
    columns.push(color ? { id, title, color } : { id, title });
    if (columns.length >= 50) break;
  }
  return columns;
}

function trelloRules(origin: string, binding: TrelloBinding, ticket: BoardTicket | null | undefined, tokenFile: string, settings: BoardSettings): string {
  // Anyone who can edit the board names its lists, so the rules name a list only when its name is one they look for, such as Open.
  const names = binding.columns.map((column) => oneLine(column.title)).filter(Boolean);
  const open = names.find((name) => name.toLowerCase() === "open");
  const moves = movesFor(names.map((title) => ({ status: title, title })), settings);
  return ruleText([
    `This folder has a Trello board. Move tickets through this app's local board API at ${apiHome(origin)}. It already holds the Trello connection. Do not call Trello directly.`,
    ...accessRule(tokenFile),
    "The columns on this board are its Trello lists. Read their names through the board API.",
    createRule(moves.create?.title ?? (open || "the board's first list")),
    editRule(),
    commentRule("<id>"),
    'Move a ticket with POST /api/board/move and JSON {"taskId":"<id>","status":"<column>"}. status is a column name or a list id.',
    ...startRule(moves.start, '"<id>"'),
    ...reviewRule(moves.review, '"<id>"'),
    fileRule("<id>", "Trello shows it on the card."),
    attachRule(),
    BOARD_TEXT_RULE,
    doneRule(moves.done, '"<id>"'),
    shareRule(),
  ], ticket);
}

export const trelloSource = { binding: trelloBinding, rules: trelloRules };
