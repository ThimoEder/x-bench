import { z } from "zod";
import { fields } from "../../bridge/lenient.ts";
import { boardError, type LoadedBoard } from "./boardAdapter.ts";
import { boardHref } from "./boardLink.ts";
import {
  dropTaskLinks,
  linkTicket,
  readTickets,
  refreshLinkText,
  sameTicket,
  unlinkTicket,
  writeTickets,
  type ColorOf,
  type SessionTicketLink,
} from "./tickets.ts";
import { workingChatId, type ChatActivity } from "../chat/workingChat.ts";
import { toolText, type McpGroup } from "../mcp/mcp.ts";
import { CHAT_ID_TOOL } from "./sharedRules.ts";

// The id of a ticket as its board source returns it.
const TaskRef = fields({ id: z.unknown().optional() });

// What the link bookkeeping needs from the host.
export interface LinkServices {
  // tickets.json
  tickets: string;
  origin?: string;
  publish?: () => void;
  sessions?: () => Iterable<ChatActivity>;
  nameChat?: (sessionId: string, title: string) => void;
}

export interface StoredLink {
  link: SessionTicketLink | null;
  boardUrl?: string;
}

// Links the chat to the ticket when sessionId is set, and names the board link for the ticket.
export function storeLink(services: LinkServices, folder: string, sessionId: string, task: unknown, colorOf?: ColorOf): StoredLink {
  const taskRef = TaskRef.parse(task).id;
  let link = null;
  if (sessionId) {
    const next = linkTicket(readTickets(services.tickets), { sessionId, task }, colorOf);
    writeTickets(next, services.tickets);
    link = next.links.find((item) => item.sessionId === sessionId && sameTicket(item.taskId, taskRef)) || null;
    if (link?.title) services.nameChat?.(sessionId, link.title);
  }
  const response: StoredLink = { link };
  if (services.origin) response.boardUrl = boardHref(services.origin, folder, taskRef);
  return response;
}

// The chat a link attaches to: the one named, or else the one chat working in the folder.
export function sessionForLink(services: LinkServices, sessionId: unknown, folder: string): string {
  const explicit = String(sessionId || "").trim();
  if (explicit) return explicit;
  const found = workingChatId(services.sessions?.() || [], folder);
  if (found.count === 1) return found.id;
  if (found.count > 1) throw boardError(400, "More than one chat is working in this folder");
  throw boardError(400, "No chat is working in this folder");
}

// The board rules have an agent send its chat's id with a link, since several chats can work in one folder.
export function chatIdTools(): McpGroup {
  return {
    instructions: "",
    tools: [
      {
        spec: {
          name: CHAT_ID_TOOL,
          title: "This chat's id",
          description: "Answers the id of this chat in X Bench, for the sessionId of a board link.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        },
        trusted: true,
        call: (_args, { sessionId }) => (sessionId ? toolText(sessionId) : toolText("This chat is still opening. Try again in a moment.", true)),
      },
    ],
  };
}

// Links a thread opened from a card to that card.
export function linkThread(services: LinkServices, sessionId: string, task: unknown, taskId: unknown, colorOf?: ColorOf): SessionTicketLink | null {
  const next = linkTicket(readTickets(services.tickets), { sessionId, task }, colorOf);
  writeTickets(next, services.tickets);
  return next.links.find((item) => item.sessionId === sessionId && sameTicket(item.taskId, taskId)) || null;
}

// Refreshes the linked text of a ticket that was just changed.
export function rememberTask(services: LinkServices, task: unknown, colorOf?: ColorOf): void {
  const stored = readTickets(services.tickets);
  const refreshed = refreshLinkText(stored, [task], colorOf);
  if (refreshed !== stored) {
    writeTickets(refreshed, services.tickets);
    services.publish?.();
  }
}

// After a board load: keep the binding's title and columns, and the linked tickets' text and column color, current.
export function refreshBoardLinks(services: LinkServices, loaded: LoadedBoard, colorOf?: ColorOf): void {
  if (!("tasks" in loaded.view)) return;
  const stored = readTickets(services.tickets);
  const refreshed = refreshLinkText(loaded.rebind ? loaded.rebind(stored) : stored, loaded.view.tasks, colorOf);
  if (JSON.stringify(refreshed) !== JSON.stringify(stored)) {
    writeTickets(refreshed, services.tickets);
    services.publish?.();
  }
}

// A deleted ticket leaves every chat it was linked to.
export function forgetTask(services: LinkServices, taskId: unknown): void {
  writeTickets(dropTaskLinks(readTickets(services.tickets), taskId), services.tickets);
}

export function unlinkSession(services: LinkServices, sessionId: string, taskId: unknown): void {
  writeTickets(unlinkTicket(readTickets(services.tickets), sessionId, taskId), services.tickets);
}
