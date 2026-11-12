import { z } from "zod";
import { fields } from "../../../bridge/lenient.ts";
import { BOARD_TEXT_RULE, clip } from "../boardText.ts";
import type { BoardSettings } from "../boardSettings.ts";
import { attachRule, BOARD_TOOLS, commentRule, createRule, doneRule, editRule, fileRule, movesFor, reviewRule, shareRule, startRule, ruleText, toolsRule, type BoardTicket } from "../sharedRules.ts";

export interface SakBinding {
  provider: "sak";
  projectId: number;
  title: string;
}

const StoredSak = fields({
  projectId: z.unknown().optional(),
  title: z.unknown().optional(),
});

function sakBinding(input: unknown): SakBinding | null {
  const stored = StoredSak.parse(input);
  const projectId = Number(stored.projectId);
  if (!Number.isInteger(projectId) || projectId <= 0) return null;
  return { provider: "sak", projectId, title: clip(stored.title, 200) || String(projectId) };
}

// SAK's own statuses, which the moves find by name. A board with others reaches them through its settings.
const SAK_COLUMNS = [
  { status: "open", title: "Open" },
  { status: "active", title: "Active" },
  { status: "review", title: "Review" },
  { status: "done", title: "Done" },
];

function sakRules(_binding: SakBinding, ticket: BoardTicket | null | undefined, settings: BoardSettings): string {
  const moves = movesFor(SAK_COLUMNS, settings);
  return ruleText([
    toolsRule("a board", "the SAK token", "SAK"),
    createRule(moves.create?.title ?? "open"),
    editRule(),
    commentRule(),
    ...startRule(moves.start),
    ...reviewRule(moves.review),
    doneRule(moves.done),
    `File a ticket as a sub-task of another with the ${BOARD_TOOLS.relate} tool, kind parent and the parent as otherId. Mark what blocks a ticket with kind blocked_by and the blocker as otherId. The other kinds are subtask, blocks, follows, precedes, relates and duplicates. Remove a relation with remove true.`,
    fileRule("SAK takes PNG, JPEG, GIF and WebP pictures and MP4, QuickTime and WebM clips. Show one in the description or a comment with ![<what it shows>](<url>), using the url the tool answers."),
    attachRule(),
    `${shareRule()} Do not link to the SAK dashboard.`,
    BOARD_TEXT_RULE,
  ], ticket);
}

export const sakSource = { binding: sakBinding, rules: sakRules };
