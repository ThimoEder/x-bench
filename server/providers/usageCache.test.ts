import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ProviderUsage } from "../snapshot.ts";
import { afterResets, createUsageStore } from "./usageCache.ts";

const folder = fs.mkdtempSync(path.join(os.tmpdir(), "x-bench-usage-cache-"));
test.after(() => fs.rmSync(folder, { recursive: true, force: true }));

const now = Date.parse("2026-10-05T12:00:00Z");
const claude: ProviderUsage = {
  provider: "claude",
  label: "Claude",
  tier: "Claude Max",
  period: "five-hour",
  percent: 92,
  resetsAt: "2026-10-05T11:00:00.000Z",
  windows: [
    { period: "five-hour", percent: 92, resetsAt: "2026-10-05T11:00:00.000Z" },
    { period: "weekly", percent: 49, resetsAt: "2026-10-10T11:00:00.000Z" },
  ],
};

test("saved meters read back as written, and a missing or broken file reads as none", () => {
  const usage = createUsageStore(path.join(folder, "usage.json"));
  assert.deepEqual(usage.read(), []);
  usage.save([claude]);
  assert.deepEqual(usage.read(), [claude]);
  const broken = path.join(folder, "broken.json");
  fs.writeFileSync(broken, JSON.stringify([{ provider: "claude" }]));
  assert.deepEqual(createUsageStore(broken).read(), []);
});

test("a window whose reset passed while the app was closed starts again from 0%, and the fuller one leads", () => {
  const usage = afterResets(claude, now);
  assert.deepEqual(usage.windows, [
    { period: "five-hour", percent: 0, resetsAt: null },
    { period: "weekly", percent: 49, resetsAt: "2026-10-10T11:00:00.000Z" },
  ]);
  assert.equal(usage.percent, 49);
  assert.equal(usage.period, "weekly");
  assert.equal(usage.provider, "claude");
  const grok: ProviderUsage = { provider: "grok", label: "Grok", tier: "SuperGrok", period: "weekly", percent: 30, resetsAt: "2026-10-01T00:00:00Z" };
  assert.deepEqual(afterResets(grok, now), { ...grok, percent: 0, resetsAt: null });
  assert.equal(afterResets({ ...grok, resetsAt: null }, now).percent, 30);
});
