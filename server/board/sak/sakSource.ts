import { z } from "zod";
import { fields } from "../../../bridge/lenient.ts";
import { BOARD_TEXT_RULE, clip } from "../boardText.ts";
import type { BoardSettings } from "../boardSettings.ts";
import { accessRule, apiHome, attachRule, commentRule, createRule, doneRule, editRule, fileRule, movesFor, reviewRule, shareRule, startRule, ruleText, type BoardTicket } from "../sharedRules.ts";

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

function sakRules(origin: string, _binding: SakBinding, ticket: BoardTicket | null | undefined, tokenFile: string, settings: BoardSettings): string {
  const moves = movesFor(SAK_COLUMNS, settings);
  return ruleText([
    `This folder has a board. Move tickets through this app's local board API at ${apiHome(origin)}. It already holds the SAK token. Do not call SAK directly.`,
    ...accessRule(tokenFile),
    createRule(moves.create?.title ?? "open"),
    editRule(),
    commentRule("<id>"),
    ...startRule(moves.start, "<id>"),
    ...reviewRule(moves.review, "<id>"),
    doneRule(moves.done, "<id>"),
    'File a ticket as a sub-task of another with PUT /api/board/tasks/<id>/relations and JSON {"otherTaskId":<parent id>,"kind":"parent"}. Mark what blocks a ticket with the same route and JSON {"otherTaskId":<blocker id>,"kind":"blocked_by"}. The other kinds are subtask, blocks, follows, precedes, relates and duplicates. Remove a relation with DELETE /api/board/tasks/<id>/relations/<other id>/<kind>.',
    fileRule("<id>", "SAK takes PNG, JPEG, GIF and WebP pictures and MP4, QuickTime and WebM clips. Show one in the description or a comment with ![<what it shows>](<url>), using the url the upload answers."),
    attachRule(),
    `${shareRule()} Do not link to the SAK dashboard.`,
    BOARD_TEXT_RULE,
  ], ticket);
}

export const sakSource = { binding: sakBinding, rules: sakRules };
