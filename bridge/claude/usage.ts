// Claude's plan usage. During a turn Claude sends it with usage_update (_claude/rateLimit). Outside a turn
// the Agent SDK's get_usage asks Claude Code, which reads the plan with its own login. That session sends
// no prompt, so no model request is made. It loads no settings files and turns hooks off, so only hooks
// that managed (organization) settings enforce can still run.

import os from "node:os";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { fields, maybe } from "../lenient.ts";
import type { AccountUsage, UsageWindow } from "../provider.ts";
import { accountUsage } from "../usage.ts";

const READ_TIMEOUT_MS = 20000;

// get_usage: utilization in percent, resets_at as an ISO time.
const AnsweredWindow = fields({ utilization: maybe(z.number()), resets_at: maybe(z.string()) });
const UsageAnswer = fields({
  subscription_type: maybe(z.string()),
  rate_limits_available: maybe(z.boolean()),
  rate_limits: maybe(fields({ five_hour: maybe(AnsweredWindow), seven_day: maybe(AnsweredWindow) })),
});

// usage_update: utilization as a fraction, resetsAt in epoch seconds.
const SentWindow = fields({ utilization: maybe(z.number()), resetsAt: maybe(z.number()) });
const SentLimits = fields({ unifiedWindows: maybe(fields({ five_hour: maybe(SentWindow), seven_day: maybe(SentWindow) })) });

// Claude Code refuses when the plan has no limits to read (an API key, Bedrock or Vertex). It is
// unreachable when it did not start, failed, or did not answer in time.
export type ClaudeUsageRead = { kind: "answer"; result: unknown } | { kind: "refused" } | { kind: "unreachable" };

export interface ClaudeCode {
  // The claude binary.
  executable?: string;
  env: NodeJS.ProcessEnv;
}

export async function readClaudeUsage(claude: ClaudeCode, timeoutMs = READ_TIMEOUT_MS): Promise<ClaudeUsageRead> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let session: Query | undefined;
  try {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const noPrompt: AsyncIterable<never> = { [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }) };
    session = query({
      prompt: noPrompt,
      options: {
        ...(claude.executable ? { pathToClaudeCodeExecutable: claude.executable } : {}),
        env: claude.env,
        cwd: os.tmpdir(),
        persistSession: false,
        settingSources: [],
        settings: { disableAllHooks: true },
      },
    });
    const timeout = new Promise<ClaudeUsageRead>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "unreachable" }), timeoutMs);
    });
    const answer = session
      .usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })
      .then((result): ClaudeUsageRead => (UsageAnswer.parse(result).rate_limits_available === false ? { kind: "refused" } : { kind: "answer", result }))
      .catch((): ClaudeUsageRead => ({ kind: "unreachable" }));
    return await Promise.race([answer, timeout]);
  } catch {
    return { kind: "unreachable" };
  } finally {
    clearTimeout(timer);
    session?.close();
  }
}

export function usageFromAnswer(result: unknown, accountLabel: string): AccountUsage | null {
  const answer = UsageAnswer.parse(result);
  const windows: UsageWindow[] = [];
  for (const [key, period] of WINDOWS) {
    const window = answer.rate_limits?.[key];
    if (typeof window?.utilization !== "number") continue;
    windows.push({ period, percent: Math.max(0, Math.round(window.utilization)), resetsAt: isoTime(window.resets_at) });
  }
  const plan = answer.subscription_type ? planLabel(answer.subscription_type) : "";
  return accountUsage(windows, plan || accountLabel);
}

export function usageFromRateLimit(rateLimit: unknown, accountLabel: string): AccountUsage | null {
  const sent = SentLimits.parse(rateLimit).unifiedWindows;
  const windows: UsageWindow[] = [];
  for (const [key, period] of WINDOWS) {
    const window = sent?.[key];
    if (typeof window?.utilization !== "number") continue;
    const resetsAt = typeof window.resetsAt === "number" ? new Date(window.resetsAt * 1000).toISOString() : null;
    windows.push({ period, percent: Math.max(0, Math.round(window.utilization * 100)), resetsAt });
  }
  return accountUsage(windows, accountLabel);
}

// The plan's own windows. Model-scoped ones (seven_day_opus and the like) stay out of the meter.
const WINDOWS = [
  ["five_hour", "five-hour"],
  ["seven_day", "weekly"],
] as const;

function isoTime(value: string | undefined) {
  const time = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function planLabel(plan: string) {
  const titled = plan.replace(/\S+/g, (word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`);
  return /^claude(\s|$)/i.test(plan) ? titled : `Claude ${titled}`;
}
