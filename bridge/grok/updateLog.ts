// Grok's update log of one session, updates.jsonl: every session/update Grok sent, one JSON message per line.

import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { setImmediate as nextTurn } from "node:timers/promises";
import path from "node:path";
import type { Image, Translated } from "../protocol.ts";
import { grokEventFromNotification as eventFromNotification } from "./protocol.ts";

const logFiles = new Map<string, string>();
const PARSE_SLICE_MS = 8;

export interface LoggedImages {
  byTool: Map<string, Image[]>;
  byPrompt: Map<number, Image[]>;
}

// The screenshots on tool results and the pictures the person sent, in one pass over the log.
export function imagesFromUpdates(messages: readonly unknown[] | null | undefined): LoggedImages {
  const found: LoggedImages = { byTool: new Map(), byPrompt: new Map() };
  for (const message of messages ?? []) {
    let translated: Translated | null;
    try {
      translated = eventFromNotification(message);
    } catch {
      continue;
    }
    const event = translated?.event;
    if (event?.type === "tool" && event.toolCallId && event.images?.length) found.byTool.set(event.toolCallId, event.images);
    if (event?.type !== "chunk" || event.role !== "user" || !event.images?.length) continue;
    const promptIndex = event.promptIndex;
    if (typeof promptIndex !== "number" || !Number.isInteger(promptIndex) || promptIndex < 0) continue;
    const images = found.byPrompt.get(promptIndex) || [];
    for (const image of event.images) {
      if (!image.data || images.some((item) => item.data === image.data)) continue;
      images.push(image);
    }
    found.byPrompt.set(promptIndex, images);
  }
  return found;
}

// Parsing yields to the event loop every few milliseconds, so a long log does not stall a reply streaming meanwhile.
export async function readSessionUpdateLog(root: string, sessionId: string): Promise<unknown[]> {
  const file = sessionUpdateLog(root, sessionId);
  if (!file) return [];
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return [];
  }
  const messages: unknown[] = [];
  let slice = performance.now();
  for (const line of text.split("\n")) {
    if (performance.now() - slice > PARSE_SLICE_MS) {
      await nextTurn();
      slice = performance.now();
    }
    if (!line.trim()) continue;
    try {
      messages.push(JSON.parse(line));
    } catch {
      // Skip a torn final line. The next load reads the whole file again.
    }
  }
  return messages;
}

function sessionUpdateLog(root: string, sessionId: string): string | null {
  const cached = logFiles.get(sessionId);
  if (cached && existsSync(cached)) return cached;
  if (!root || !sessionId || !existsSync(root)) return null;
  let groups;
  try {
    groups = readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const group of groups) {
    if (!group.isDirectory()) continue;
    const file = path.join(root, group.name, sessionId, "updates.jsonl");
    if (!existsSync(file)) continue;
    logFiles.set(sessionId, file);
    return file;
  }
  return null;
}

