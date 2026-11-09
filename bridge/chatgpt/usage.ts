// Codex's ACP usage_update exposes only context usage. Plan limits require a separate app-server
// request using Codex's own login.

import { spawn } from "node:child_process";
import os from "node:os";
import { createInterface } from "node:readline";
import { z } from "zod";
import { fields, isRecord, maybe } from "../lenient.ts";
import { accountUsage } from "../usage.ts";
import { adapterEnvironment } from "../adapter.ts";
import type { AccountUsage, UsagePeriod, UsageWindow } from "../provider.ts";

const READ_TIMEOUT_MS = 20000;

const RateWindow = fields({ usedPercent: maybe(z.number()), windowDurationMins: maybe(z.number()), resetsAt: maybe(z.number()) });
const RateSnapshot = fields({ primary: maybe(RateWindow), secondary: maybe(RateWindow), planType: maybe(z.string()) });
const RateLimits = fields({ rateLimits: maybe(RateSnapshot) });

const PLAN_NAMES: Record<string, string> = {
  free: "Free",
  go: "Go",
  plus: "Plus",
  pro: "Pro",
  team: "Team",
  business: "Business",
  enterprise: "Enterprise",
  edu: "Edu",
};

export interface AppServerCommand {
  command: string;
  args: string[];
}

// What codex app-server said to account/rateLimits/read. Codex refuses when it cannot read the plan
// (signed out, an API key account, an older codex). It is unreachable when it did not start, stopped,
// timed out, or could not reach ChatGPT itself.
export type RateLimitsRead = { kind: "answer"; result: unknown } | { kind: "refused" } | { kind: "unreachable" };

// Codex's code for a request it failed to carry out, such as a rate limit fetch that did not reach ChatGPT.
const INTERNAL_ERROR = -32603;

export function readRateLimits(server: AppServerCommand, timeoutMs = READ_TIMEOUT_MS): Promise<RateLimitsRead> {
  return new Promise((resolve) => {
    let done = false;
    const child = spawn(server.command, server.args, { cwd: os.homedir(), env: adapterEnvironment(), stdio: ["pipe", "pipe", "ignore"] });
    const finish = (result: RateLimitsRead) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
      child.stdin.end();
      child.kill();
    };
    const unreachable = () => finish({ kind: "unreachable" });
    const timer = setTimeout(unreachable, timeoutMs);
    const send = (message: object) => {
      if (!child.stdin.writable) return;
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    child.on("error", unreachable);
    child.on("exit", unreachable);
    child.stdin.on("error", unreachable);
    createInterface({ input: child.stdout }).on("line", (line) => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      // Codex's own notifications and requests carry a method. Only the two answers matter here.
      if (!isRecord(message) || "method" in message) return;
      if (message.id === 1) {
        if (message.error) return finish({ kind: "refused" });
        send({ method: "initialized" });
        send({ id: 2, method: "account/rateLimits/read", params: { excludeResetCreditDetails: true } });
      } else if (message.id === 2) {
        if (!message.error) return finish({ kind: "answer", result: message.result ?? null });
        finish(isRecord(message.error) && message.error.code === INTERNAL_ERROR ? { kind: "unreachable" } : { kind: "refused" });
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "x_bench", title: "X Bench", version: "1" }, capabilities: null } });
  });
}

export function usageFromRateLimits(result: unknown, accountLabel: string): AccountUsage | null {
  const snapshot = RateLimits.parse(result).rateLimits;
  if (!snapshot) return null;
  const windows: UsageWindow[] = [];
  for (const window of [snapshot.primary, snapshot.secondary]) {
    if (typeof window?.usedPercent !== "number") continue;
    windows.push({
      period: periodOf(window.windowDurationMins),
      percent: Math.max(0, Math.round(window.usedPercent)),
      resetsAt: typeof window.resetsAt === "number" ? new Date(window.resetsAt * 1000).toISOString() : null,
    });
  }
  const plan = planName(snapshot.planType);
  return accountUsage(windows, plan ? `ChatGPT ${plan}` : accountLabel);
}

// Codex says "unknown" for a plan it cannot name.
function planName(planType: string | undefined) {
  if (!planType || planType === "unknown") return "";
  return PLAN_NAMES[planType] ?? `${planType[0]?.toUpperCase() ?? ""}${planType.slice(1)}`;
}

// Codex names a window by its length in minutes: 300 for five hours, 10080 for a week.
function periodOf(minutes: number | undefined): UsagePeriod {
  if (minutes === 300) return "five-hour";
  if (minutes === 7 * 24 * 60) return "weekly";
  if (typeof minutes === "number" && minutes >= 28 * 24 * 60 && minutes <= 31 * 24 * 60) return "monthly";
  return "";
}
