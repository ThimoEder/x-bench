// Questions the host's own tools ask the person, per session: the browser, simulator and routine tools ask
// before acting unless the chat's mode goes ahead. The page shows a waiting question as the session's permission
// card, and an "always" answer holds for one place (a site, a device) for the rest of the session.

import { randomBytes } from "node:crypto";
import type { PermissionOption } from "../../bridge/protocol.ts";

export type PromptKind = "browser" | "simulator" | "routine";

export interface HostPrompt {
  id: string;
  kind: PromptKind;
  title: string;
  detail: string;
  // The place an "always" answer covers, like a site's origin or device:<id>. Empty when none applies.
  origin: string;
  options: PermissionOption[];
}

export interface PromptRequest {
  kind?: PromptKind;
  title: string;
  detail: string;
  origin: string;
  // The place's name in the "Always allow on" option. Defaults to the origin's host.
  place?: string;
}

export type PromptAnswer = "once" | "site" | "deny";

// Modes in which the host's tools act without asking. Codex's Auto review still checks each call.
export const UNASKED_MODES = new Set(["auto", "full"]);

export const PROMPT_OPTIONS = {
  once: "host:once",
  site: "host:site",
  deny: "host:deny",
} as const;

export interface Prompts {
  allowed(sessionId: string, origin: string): boolean;
  ask(sessionId: string, request: PromptRequest, signal?: AbortSignal): Promise<PromptAnswer>;
  prompt(sessionId: string): HostPrompt | null;
  // Sessions with an action waiting for the person.
  waitingSessions(): string[];
  answer(sessionId: string, optionId: string): boolean;
  // Denies whatever waits, when the person stops the turn.
  cancel(sessionId: string): void;
  forget(sessionId: string): void;
}

interface Waiting {
  sessionId: string;
  prompt: HostPrompt;
  resolve(answer: PromptAnswer): void;
}

export function createPrompts(changed: () => void): Prompts {
  const places = new Map<string, Set<string>>();
  const waiting: Waiting[] = [];

  function settle(entry: Waiting, answer: PromptAnswer) {
    const index = waiting.indexOf(entry);
    if (index < 0) return;
    waiting.splice(index, 1);
    if (answer === "site") allow(entry.sessionId, entry.prompt.origin);
    entry.resolve(answer);
    changed();
  }

  function allow(sessionId: string, origin: string) {
    const set = places.get(sessionId) ?? new Set<string>();
    set.add(origin);
    places.set(sessionId, set);
  }

  return {
    allowed: (sessionId, origin) => Boolean(origin) && Boolean(places.get(sessionId)?.has(origin)),
    ask(sessionId, request, signal) {
      if (signal?.aborted) return Promise.resolve("deny");
      return new Promise<PromptAnswer>((resolve) => {
        const place = request.origin ? request.place || hostOf(request.origin) : "";
        // Each prompt's own option ids, so a late or second click never answers the next prompt.
        const id = randomBytes(6).toString("hex");
        const options: PermissionOption[] = [
          { optionId: `${PROMPT_OPTIONS.once}:${id}`, name: "Allow once", kind: "allow_once" },
          ...(place ? [{ optionId: `${PROMPT_OPTIONS.site}:${id}`, name: `Always allow on ${place}`, kind: "allow_always" as const }] : []),
          { optionId: `${PROMPT_OPTIONS.deny}:${id}`, name: "Deny", kind: "reject_once" },
        ];
        const entry: Waiting = {
          sessionId,
          prompt: { id, kind: request.kind ?? "browser", title: request.title, detail: request.detail, origin: request.origin, options },
          resolve,
        };
        waiting.push(entry);
        signal?.addEventListener("abort", () => settle(entry, "deny"), { once: true });
        changed();
      });
    },
    prompt: (sessionId) => waiting.find((entry) => entry.sessionId === sessionId)?.prompt ?? null,
    waitingSessions: () => [...new Set(waiting.map((entry) => entry.sessionId))],
    answer(sessionId, optionId) {
      const entry = waiting.find((item) => item.sessionId === sessionId && item.prompt.options.some((option) => option.optionId === optionId));
      if (!entry) return false;
      const kind = optionId.slice(0, optionId.lastIndexOf(":"));
      settle(entry, kind === PROMPT_OPTIONS.site ? "site" : kind === PROMPT_OPTIONS.once ? "once" : "deny");
      return true;
    },
    cancel(sessionId) {
      for (const entry of waiting.filter((item) => item.sessionId === sessionId)) settle(entry, "deny");
    },
    forget(sessionId) {
      places.delete(sessionId);
      for (const entry of waiting.filter((item) => item.sessionId === sessionId)) settle(entry, "deny");
    },
  };
}

// Whether a tool may act: the chat's mode goes ahead, the person allowed this place in this chat, or they
// allow it now.
export async function approved(prompts: Pick<Prompts, "allowed" | "ask">, mode: string | null, sessionId: string, request: PromptRequest, signal?: AbortSignal): Promise<boolean> {
  if (UNASKED_MODES.has(mode ?? "")) return true;
  if (request.origin && prompts.allowed(sessionId, request.origin)) return true;
  return (await prompts.ask(sessionId, request, signal)) !== "deny";
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin;
  }
}
