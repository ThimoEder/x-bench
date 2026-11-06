import { useCallback, useSyncExternalStore } from "react";
import type { Capabilities } from "../../bridge/provider.ts";

// How a message sent during a running turn goes: it waits for the turn to end (queue), the agent reads
// it at its next step (next), or it joins the turn at once (steer). Each provider keeps its own choice,
// from the composer's menu or from Settings.
export type FollowUp = "queue" | "next" | "steer";

export const FOLLOW_UP_NAMES: Record<FollowUp, string> = {
  queue: "Queue",
  next: "Next step",
  steer: "Steer",
};

const FOLLOW_UP_KEY = "x-bench-follow-ups";
// The choices made on this page, which hold when storage cannot keep them.
const chosen = new Map<string, FollowUp>();
// Every useFollowUp on the page, so open panes and Settings agree.
const listeners = new Set<() => void>();

// The choices a provider offers, in menu order. Without its capabilities (a page whose snapshot does not
// list providers yet) the provider is Grok, which steers.
export function followUpChoices(capabilities?: Pick<Capabilities, "steer" | "deliverNext">): FollowUp[] {
  if (!capabilities) return ["queue", "steer"];
  const choices: FollowUp[] = ["queue"];
  if (capabilities.deliverNext) choices.push("next");
  if (capabilities.steer) choices.push("steer");
  return choices;
}

function readStored(): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(FOLLOW_UP_KEY) || "{}");
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// The stored choice while the provider still offers it, else Next step where offered, else Queue.
function readFollowUp(providerId: string, choices: readonly FollowUp[]): FollowUp {
  const stored = chosen.get(providerId) ?? readStored()[providerId];
  return choices.find((choice) => choice === stored) ?? (choices.includes("next") ? "next" : "queue");
}

function chooseFollowUp(providerId: string, next: FollowUp) {
  chosen.set(providerId, next);
  try {
    localStorage.setItem(FOLLOW_UP_KEY, JSON.stringify({ ...readStored(), [providerId]: next }));
  } catch {
    // Kept for this page only.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useFollowUp(providerId: string, choices: readonly FollowUp[]): [FollowUp, (next: FollowUp) => void] {
  const followUp = useSyncExternalStore(subscribe, () => readFollowUp(providerId, choices));
  const choose = useCallback((next: FollowUp) => chooseFollowUp(providerId, next), [providerId]);
  return [followUp, choose];
}
