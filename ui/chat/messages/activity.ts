import type { PresentedItem, PresentedSession } from "../../../server/present.ts";
import { toolPhase } from "../../../bridge/tools.ts";

// The line beside the dots. Prefer the phase the bridge recorded. If that
// has not arrived, follow the same transcript row the user is looking at.

const LIVE = new Set(["in_progress", "pending", "running"]);

export interface WorkingLine {
  key: string;
  label: string;
  since: number | null;
}

type ActivitySession = Partial<Pick<PresentedSession, "status" | "activity" | "transcript">>;

export function workingLine(session: ActivitySession | null | undefined, now = Date.now()): WorkingLine {
  const given = session?.activity;
  if (given && typeof given.label === "string" && given.label && typeof given.since === "number") {
    return { key: `phase:${given.since}:${given.label}`, label: given.label, since: given.since };
  }
  const transcript = Array.isArray(session?.transcript) ? session.transcript : [];
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const item = transcript[index];
    if (item?.type === "thought" && item.streaming) {
      return { key: `think:${item.id}`, label: "Thinking...", since: itemStart(item, now) };
    }
    if (item?.type === "assistant" && item.streaming) {
      return { key: `text:${item.id}`, label: "Responding", since: itemStart(item, now) };
    }
    if (item?.type === "tool" && isLive(item.status)) {
      return { key: `tool:${item.toolCallId || item.id}`, label: toolPhase(item), since: itemStart(item, now) };
    }
  }
  return { key: "wait", label: "Waiting for response", since: null };
}

function itemStart(item: PresentedItem, now: number): number | null {
  if ("startedAt" in item && typeof item.startedAt === "number") return item.startedAt;
  if ("durationMs" in item && typeof item.durationMs === "number") return now - Math.max(0, item.durationMs);
  return null;
}

function isLive(status: string): boolean {
  if (!status) return true;
  return LIVE.has(status);
}
