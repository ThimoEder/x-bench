// What a switched chat keeps besides the session it runs on now: the sessions it ran on before, each stretch as
// it was on screen when the chat left it, how each later stretch began, and the handoff its next message still
// has to carry. One file per chat in ~/.x-bench/chats, written only for chats that switched.

import { readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { isRecord } from "../../bridge/lenient.ts";
import { fileStamp, loadDurable, saveDurable } from "../jsonFile.ts";
import type { PresentedItem } from "../present.ts";

// How a stretch began.
export interface StretchStart {
  // The provider and model the chat came from.
  fromProvider: string;
  fromModel: string;
  // Tokens of the handoff the stretch read, 0 for a resumed session that missed nothing.
  tokens: number;
  // The provider picked up its own earlier session.
  resumed: boolean;
  // A summary stood in for the conversation.
  summarized: boolean;
  // Entries were left out to stay under the cap.
  cut: boolean;
  // The old model was asked for a summary and gave none, so the conversation went as text.
  summaryFailed?: boolean;
}

export interface FrozenStretch {
  provider: string;
  // The harness's id of the session, which its harness keeps on disk.
  harnessId: string;
  // The model's name as the menu showed it, and its id.
  model: string;
  modelId: string;
  items: PresentedItem[];
  start: StretchStart | null;
  // The session never got the handoff it was given, so picking it up hands over everything before it too.
  unsent?: boolean;
}

export interface ChatRecord {
  stretches: FrozenStretch[];
  // How the stretch running now began.
  start: StretchStart | null;
  // Transcript items of the live session that came before this stretch: a resumed session replays its history.
  skip: number;
  // The handoff the next message carries, until one is sent.
  pending: string | null;
  // Every handoff sent, by the stretch it began (1 for the second stretch), for "What it read".
  handoffs: Record<string, string>;
}

const Start = z.object({
  fromProvider: z.string(),
  fromModel: z.string(),
  tokens: z.number(),
  resumed: z.boolean(),
  summarized: z.boolean(),
  cut: z.boolean(),
  summaryFailed: z.boolean().optional(),
});

const RecordFile = z.object({
  stretches: z.array(
    z.object({
      provider: z.string(),
      harnessId: z.string(),
      model: z.string(),
      modelId: z.string().catch(""),
      items: z.array(z.unknown().refine(isRecord)),
      start: Start.nullable(),
      unsent: z.boolean().optional(),
    }),
  ),
  start: Start.nullable(),
  skip: z.number().int().min(0),
  pending: z.string().nullable(),
  handoffs: z.record(z.string(), z.string()),
});

function parse(value: unknown): ChatRecord | null {
  const parsed = RecordFile.safeParse(value);
  return parsed.success ? (parsed.data as unknown as ChatRecord) : null;
}

export interface ChatRecords {
  get(chatId: string): ChatRecord | null;
  // The chat that ran on a harness session before, or null.
  chatOf(harnessId: string): string | null;
  // False when the file could not be written. The record is then not kept either.
  save(chatId: string, record: ChatRecord): boolean;
  drop(chatId: string): void;
}

function harnessesOf(chatId: string, record: ChatRecord | null): [string, string][] {
  return (record?.stretches ?? []).map((stretch) => [stretch.harnessId, chatId]);
}

// Every record is read once, on the first lookup, since the host maps ids on every session event. Every write
// renames a file into the folder, so a change of the folder's stamp means a host, this one included, wrote one.
export function createChatRecords(dir: string): ChatRecords {
  const cache = new Map<string, ChatRecord | null>();
  let harnesses: Map<string, string> | null = null;
  let stamp = fileStamp(dir);
  const fileOf = (chatId: string) => path.join(dir, `${path.basename(chatId)}.json`);
  const fresh = () => {
    const now = fileStamp(dir);
    if (now === stamp) return;
    stamp = now;
    cache.clear();
    harnesses = null;
  };
  const read = (chatId: string) => {
    fresh();
    if (!cache.has(chatId)) cache.set(chatId, loadDurable<ChatRecord | null>(fileOf(chatId), parse, null));
    return cache.get(chatId) ?? null;
  };
  function lookup() {
    fresh();
    if (harnesses) return harnesses;
    harnesses = new Map();
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((name) => name.endsWith(".json"));
    } catch {
      // No chat has switched yet.
    }
    for (const name of names) {
      const chatId = name.slice(0, -".json".length);
      for (const [harnessId, chat] of harnessesOf(chatId, read(chatId))) harnesses.set(harnessId, chat);
    }
    return harnesses;
  }
  return {
    get: read,
    chatOf: (harnessId) => lookup().get(harnessId) ?? null,
    save(chatId, record) {
      if (!saveDurable(fileOf(chatId), JSON.stringify(record), parse)) return false;
      fresh();
      cache.set(chatId, record);
      for (const [harnessId, chat] of harnessesOf(chatId, record)) lookup().set(harnessId, chat);
      return true;
    },
    drop(chatId) {
      for (const [harnessId] of harnessesOf(chatId, read(chatId))) lookup().delete(harnessId);
      cache.set(chatId, null);
      rmSync(fileOf(chatId), { force: true });
      rmSync(`${fileOf(chatId)}.bak`, { force: true });
    },
  };
}

export function memoryChatRecords(): ChatRecords {
  const records = new Map<string, ChatRecord>();
  return {
    get: (chatId) => records.get(chatId) ?? null,
    chatOf: (harnessId) => [...records].find(([, record]) => record.stretches.some((stretch) => stretch.harnessId === harnessId))?.[0] ?? null,
    save: (chatId, record) => Boolean(records.set(chatId, record)),
    drop: (chatId) => void records.delete(chatId),
  };
}
