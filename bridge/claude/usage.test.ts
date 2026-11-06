import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { ClaudeProvider } from "./provider.ts";
import { readClaudeUsage, usageFromAnswer, usageFromRateLimit } from "./usage.ts";

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "testing", "fakeClaudeCode.ts");
const folder = mkdtempSync(path.join(os.tmpdir(), "x-bench-fake-claude-code-"));
const starts = path.join(folder, "starts");
after(() => rmSync(folder, { recursive: true, force: true }));

// The SDK runs Claude Code as a binary, so the fake gets a script in front of it.
function claudeCode(mode: string) {
  const file = path.join(folder, `claude-${mode}`);
  writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "${starts}" "${mode}"\n`);
  chmodSync(file, 0o755);
  return file;
}

const startCount = () => (existsSync(starts) ? readFileSync(starts, "utf8").trim().split("\n").length : 0);

const fiveHour = { period: "five-hour", percent: 29, resetsAt: "2026-10-05T03:40:00.077Z" } as const;
const weekly = { period: "weekly", percent: 49, resetsAt: "2026-10-10T11:00:00.077Z" } as const;

test("get_usage's plan windows become the meter, the fuller one in front, and the plan names the tier", () => {
  const answer = {
    subscription_type: "max",
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 29, resets_at: "2026-10-05T03:40:00.077835+00:00" },
      seven_day: { utilization: 49, resets_at: "2026-10-10T11:00:00.077856+00:00" },
      seven_day_opus: { utilization: 95, resets_at: "2026-10-10T11:00:00+00:00" },
    },
  };
  assert.deepEqual(usageFromAnswer(answer, ""), { ...weekly, tier: "Claude Max", windows: [fiveHour, weekly] });
  assert.equal(usageFromAnswer({ ...answer, subscription_type: null }, "Claude Pro")?.tier, "Claude Pro");
  assert.equal(usageFromAnswer({ rate_limits_available: true, rate_limits: null }, ""), null);
});

test("the windows Claude sends during a turn read the same way", () => {
  const sent = { unifiedWindows: { five_hour: { utilization: 0.29, resetsAt: 1790919600 }, seven_day: { utilization: 0.49, resetsAt: 1791370800 }, seven_day_opus: { utilization: 0.95 } } };
  const usage = usageFromRateLimit(sent, "Claude Max");
  assert.equal(usage?.percent, 49);
  assert.equal(usage?.period, "weekly");
  assert.deepEqual(usage?.windows?.map((window) => [window.period, window.percent]), [["five-hour", 29], ["weekly", 49]]);
  assert.deepEqual(usageFromRateLimit({ unifiedWindows: { five_hour: { utilization: 0.1 } } }, ""), { period: "five-hour", percent: 10, resetsAt: null, tier: "" });
  assert.equal(usageFromRateLimit(undefined, ""), null);
});

test("Claude Code answers a usage read without a prompt; an account without plan limits refuses, and a failed, silent or missing one is unreachable", async () => {
  const answered = await readClaudeUsage({ executable: claudeCode("29"), env: process.env });
  assert.equal(answered.kind, "answer");
  assert.equal(answered.kind === "answer" ? usageFromAnswer(answered.result, "")?.percent : null, 49);
  assert.deepEqual(await readClaudeUsage({ executable: claudeCode("apikey"), env: process.env }), { kind: "refused" });
  assert.deepEqual(await readClaudeUsage({ executable: claudeCode("fail"), env: process.env }), { kind: "unreachable" });
  assert.deepEqual(await readClaudeUsage({ executable: claudeCode("silent"), env: process.env }, 500), { kind: "unreachable" });
  assert.deepEqual(await readClaudeUsage({ executable: path.join(folder, "missing"), env: process.env }), { kind: "unreachable" });
});

// Figures as Claude sends them with usage_update during a turn.
function sendRateLimit(provider: ClaudeProvider, utilization: number) {
  Reflect.apply(Reflect.get(provider, "noteRateLimit"), provider, [{ _meta: { "_claude/rateLimit": { unifiedWindows: { five_hour: { utilization } } } } }]);
}

test("the Claude provider asks Claude Code, and figures from a turn stand for a minute without starting it", async () => {
  const provider = new ClaudeProvider({ command: "unused", claudeCode: claudeCode("29") });
  try {
    assert.deepEqual(await provider.accountUsage(), { ...weekly, tier: "Claude Max", windows: [fiveHour, weekly] });
    const before = startCount();
    sendRateLimit(provider, 0.6);
    assert.equal((await provider.accountUsage())?.percent, 60);
    assert.equal(startCount(), before);
  } finally {
    await provider.stop();
  }
});

test("a Claude Code that cannot answer leaves the meter as it is, and one that refuses drops it", async () => {
  const provider = new ClaudeProvider({ command: "unused", claudeCode: claudeCode("fail") });
  try {
    assert.equal(await provider.accountUsage(), undefined);
    provider.options.claudeCode = claudeCode("apikey");
    assert.equal(await provider.accountUsage(), null);
  } finally {
    await provider.stop();
  }
});

test("a read under way gives way to figures Claude sends meanwhile, to another account, and to stop, and a stopped provider reads again", async () => {
  const provider = new ClaudeProvider({ command: "unused", claudeCode: claudeCode("slow") });
  try {
    const overtaken = provider.accountUsage();
    sendRateLimit(provider, 0.8);
    assert.equal((await overtaken)?.percent, 80);

    Reflect.set(provider, "usageAt", 0);
    const otherAccount = provider.accountUsage();
    provider.options.claudeCode = claudeCode("29");
    assert.equal(await otherAccount, null);

    provider.options.claudeCode = claudeCode("slow");
    const stopped = provider.accountUsage();
    await provider.stop();
    assert.equal(await stopped, null);
    assert.equal((await provider.accountUsage())?.percent, 49);
  } finally {
    await provider.stop();
  }
});
