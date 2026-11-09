import { bindingFor } from "./tickets.ts";
import { NO_SETTINGS, type BoardSettings } from "./boardSettings.ts";
import { cleanBoardText, stripHidden } from "./boardText.ts";
import { oneLine, ticketRef, type BoardTicket } from "./sharedRules.ts";
import { sourceOf } from "./sources.ts";

// tokenFile is where the host keeps its launch token. The rules tell the agent to send it with every request.
export function rulesForBoard(state: unknown, cwd: unknown, origin: string, ticket?: BoardTicket | null, tokenFile = "", settings: BoardSettings = NO_SETTINGS): string {
  const binding = bindingFor(state, cwd);
  return binding ? sourceOf(binding.provider).rules(origin, binding, ticket, tokenFile, settings) : "";
}

// The ticket's title as the brief shows it.
export function ticketTitle(ticket?: BoardTicket | null): string {
  return oneLine(ticket?.title);
}

// The text a thread opened from a card starts with. The page puts it in the composer, and the user edits and
// sends it. Column rules already explain how to move the ticket, so this only carries the work itself.
export function threadBrief(ticket?: BoardTicket | null): string {
  const id = ticketRef(ticket);
  if (!id) return "";
  const title = oneLine(ticket?.title);
  const lines = ["Implement this ticket."];
  if (title) lines.push("", `## ${title}`);
  lines.push("", `Ticket ${id}, currently in ${columnOf(ticket?.status)}.`);
  const description = paragraphs(ticket?.description);
  const note = paragraphs(ticket?.note);
  if (description) lines.push("", description);
  if (note) lines.push("", "## Note", "", note);
  return lines.join("\n");
}

// How many hidden characters the brief left out of the ticket.
export function hiddenInTicket(ticket?: BoardTicket | null): number {
  return [ticket?.title, ticket?.status, ticket?.description, ticket?.note].reduce<number>((sum, value) => sum + cleanBoardText(value).hidden, 0);
}

function columnOf(status: unknown): string {
  if (status === null || status === undefined || status === "") return "unset";
  return oneLine(status).slice(0, 100) || "unset";
}

function block(value: unknown): string {
  return stripHidden(value).trim().slice(0, 8000);
}

function paragraphs(value: unknown): string {
  const text = block(value);
  if (!text) return "";
  return text.split(/\n+/).map((line) => line.trim()).filter(Boolean).join("\n\n");
}
