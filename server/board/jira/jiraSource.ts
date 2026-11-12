import { z } from "zod";
import { fields, maybe } from "../../../bridge/lenient.ts";
import { BOARD_TEXT_RULE, clip } from "../boardText.ts";
import type { BoardSettings } from "../boardSettings.ts";
import { attachRule, BOARD_TOOLS, commentRule, createRule, doneRule, editRule, fileRule, movesFor, reviewRule, shareRule, startRule, ruleText, toolsRule, type BoardTicket } from "../sharedRules.ts";

export interface JiraBinding {
  provider: "jira";
  boardId: number;
  title: string;
  // The project new tickets go to. Empty when the board is not located in one project.
  projectKey: string;
  // The board's column names, for the agent's rules.
  columns: string[];
}

const StoredJira = fields({
  boardId: z.unknown().optional(),
  title: z.unknown().optional(),
  projectKey: z.unknown().optional(),
  columns: maybe(z.array(z.unknown())),
});

function jiraBinding(input: unknown): JiraBinding | null {
  const stored = StoredJira.parse(input);
  const boardId = Number(stored.boardId);
  if (!Number.isSafeInteger(boardId) || boardId <= 0) return null;
  const projectKey = String(stored.projectKey || "").trim().toUpperCase();
  const columns: string[] = [];
  for (const item of stored.columns ?? []) {
    const title = typeof item === "string" ? clip(item, 80) : "";
    if (title && !columns.includes(title)) columns.push(title);
    if (columns.length >= 50) break;
  }
  return {
    provider: "jira",
    boardId,
    title: clip(stored.title, 200) || String(boardId),
    projectKey: /^[A-Z][A-Z0-9_]*$/.test(projectKey) ? projectKey : "",
    columns,
  };
}

function jiraRules(binding: JiraBinding, ticket: BoardTicket | null | undefined, settings: BoardSettings): string {
  const moves = movesFor(binding.columns.map((title) => ({ status: title, title })), settings);
  return ruleText([
    toolsRule("a Jira board", "the Jira connection", "Jira"),
    `The columns on this board are its Jira board columns. Read their names with the ${BOARD_TOOLS.read} tool. A ticket id is its Jira key, such as APP-12.`,
    createRule(moves.create?.title ?? "the first status of the project's workflow"),
    editRule(),
    commentRule(),
    `Move a ticket with the ${BOARD_TOOLS.move} tool. status is a column name. A move follows the Jira workflow, which can refuse it. When it does, tell the user what the tool answered and leave the ticket where it is.`,
    ...startRule(moves.start),
    ...reviewRule(moves.review),
    fileRule("Show it in the description or a comment with !<file name>!."),
    attachRule(),
    BOARD_TEXT_RULE,
    doneRule(moves.done),
    shareRule(),
  ], ticket);
}

export const jiraSource = { binding: jiraBinding, rules: jiraRules };
