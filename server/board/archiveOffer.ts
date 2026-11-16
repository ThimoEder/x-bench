// archive-offers.json: { "sessions": ["<session id>"] }

import { z } from "zod";
import { listOf } from "../../bridge/lenient.ts";
import { watchedJson } from "../jsonFile.ts";
import { MCP_SERVER, toolText, type McpGroup } from "../mcp/mcp.ts";

export const OFFER_ARCHIVE_TOOL = "offer_archive";

const OffersFile = z.object({ sessions: listOf(z.string()).catch([]).default([]) });

function parse(value: unknown): string[] | null {
  const parsed = OffersFile.safeParse(value);
  return parsed.success ? parsed.data.sessions : null;
}

export interface ArchiveOffers {
  has(sessionId: string): boolean;
  offer(sessionId: string): void;
  clear(sessionId: string): void;
  // True when another host changed the file since the last call.
  changedOnDisk(): boolean;
  onChange(listener: () => void): () => void;
}

export function createArchiveOffers(file: string): ArchiveOffers {
  const json = watchedJson<string[]>(file, parse, [], "keep archive offers");
  const listeners = new Set<() => void>();

  function write(sessions: string[]) {
    json.write({ sessions });
    for (const listener of listeners) listener();
  }

  return {
    has: (sessionId) => json.read().includes(sessionId),
    offer(sessionId) {
      if (!json.read().includes(sessionId)) write([...json.read(), sessionId]);
    },
    clear(sessionId) {
      if (json.read().includes(sessionId)) write(json.read().filter((id) => id !== sessionId));
    },
    changedOnDisk: json.changedOnDisk,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const OFFER_ARCHIVE_HINT = `Call the ${OFFER_ARCHIVE_TOOL} tool of the ${MCP_SERVER} MCP server once, at the end, when the work the person asked for is finished and committed or merged.`;

const OFFER_ARCHIVE_SPEC = {
  name: OFFER_ARCHIVE_TOOL,
  title: "Offer to archive this chat",
  description: [
    "Offer to archive this chat once its work is finished.",
    'The person sees an "Archive this chat?" row above the composer when the turn ends, and archives the chat or keeps it. Nothing is archived by itself.',
    "Call it once, at the end, when the work the person asked for is finished and committed or merged.",
  ].join(" "),
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

export function offerArchiveTools(store: Pick<ArchiveOffers, "offer">): McpGroup {
  return {
    instructions: OFFER_ARCHIVE_HINT,
    // The Chat surface draws no archive row.
    builderOnly: true,
    tools: [{ spec: OFFER_ARCHIVE_SPEC, trusted: true, call: (_args, { sessionId }) => offerArchive(sessionId, store) }],
  };
}

function offerArchive(sessionId: string | null, store: Pick<ArchiveOffers, "offer">) {
  if (!sessionId) return toolText("This chat is still opening. Try again in a moment.", true);
  try {
    store.offer(sessionId);
    return toolText("The person sees the offer to archive this chat once this turn ends. Nothing is archived by itself.", false);
  } catch (error) {
    return toolText(error instanceof Error ? error.message : String(error), true);
  }
}
