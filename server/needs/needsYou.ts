// The chats that wait on the person, on the desk and off it, as the Needs you page lists them.

import type { SessionState } from "../../bridge/reducer.ts";
import { presentWaits, type PresentedDiff, type PresentedPermission, type PresentedPlan, type PresentedQuestion } from "../present.ts";

// One request a chat waits on: exactly one of permission, question and plan is set.
export interface Wait {
  // The session and the request, so a new request of the same chat is a new row.
  key: string;
  sessionId: string;
  cwd: string;
  title: string;
  provider: string;
  // The project's name. Empty for a plain chat.
  folder: string;
  // A plain chat, on the Chat surface.
  chat: boolean;
  since: number;
  permission?: PresentedPermission;
  // The file changes of the tool call that asks.
  diffs?: PresentedDiff[];
  question?: PresentedQuestion;
  plan?: PresentedPlan;
}

export type WaitCard = Pick<Wait, "key" | "permission" | "diffs" | "question" | "plan">;

// hostPrompt is the app's own question for the session, which shows while the agent asks no permission of its own.
export function waitCards(session: SessionState, hostPrompt: { id: string; permission: PresentedPermission } | null): WaitCard[] {
  const { permission, diffs, question, plan } = presentWaits(session);
  return [
    ...(permission ? [{ key: `${session.id}:permission:${permission.id}`, permission, ...(diffs.length ? { diffs } : {}) }] : []),
    ...(!permission && hostPrompt ? [{ key: `${session.id}:prompt:${hostPrompt.id}`, permission: hostPrompt.permission }] : []),
    ...(question ? [{ key: `${session.id}:question:${question.id}`, question }] : []),
    ...(plan ? [{ key: `${session.id}:plan:${plan.toolCallId ?? ""}`, plan }] : []),
  ];
}

// since is when a wait was first listed, and is forgotten once the wait leaves the list.
export function createWaitClock(now: () => number = Date.now) {
  const since = new Map<string, number>();
  return <T extends { key: string }>(waits: readonly T[]): (T & { since: number })[] => {
    const keys = new Set(waits.map((wait) => wait.key));
    for (const key of since.keys()) if (!keys.has(key)) since.delete(key);
    return waits
      .map((wait) => {
        const at = since.get(wait.key) ?? now();
        since.set(wait.key, at);
        return { ...wait, since: at };
      })
      .sort((left, right) => left.since - right.since);
  };
}
