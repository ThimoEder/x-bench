import assert from "node:assert/strict";
import test from "node:test";
import { usageFromRateLimits } from "./usage.ts";

const window = (usedPercent: number, windowDurationMins: number, resetsAt = 1790820111) => ({ usedPercent, windowDurationMins, resetsAt });

test("the fuller of the 5-hour and weekly windows becomes the meter", () => {
  const result = { rateLimits: { primary: window(90, 300), secondary: window(17, 10080, 1791234524), planType: "plus" } };
  const fiveHour = { period: "five-hour", percent: 90, resetsAt: new Date(1790820111 * 1000).toISOString() };
  const week = { period: "weekly", percent: 17, resetsAt: new Date(1791234524 * 1000).toISOString() };
  assert.deepEqual(usageFromRateLimits(result, "ChatGPT Plus"), { ...fiveHour, tier: "ChatGPT Plus", windows: [fiveHour, week] });
  const weekly = usageFromRateLimits({ rateLimits: { primary: window(12.4, 300), secondary: window(63.6, 10080, 1791234524) } }, "");
  assert.equal(weekly?.percent, 64);
  assert.equal(weekly?.period, "weekly");
  assert.equal(weekly?.resetsAt, new Date(1791234524 * 1000).toISOString());
});

test("the plan from the read names the tier, and the adapter's label stands in when Codex cannot name it", () => {
  const tier = (planType: string | undefined, label: string) => usageFromRateLimits({ rateLimits: { primary: window(5, 300), planType } }, label)?.tier;
  assert.equal(tier("pro", "ChatGPT Plus"), "ChatGPT Pro");
  assert.equal(tier("prolite", ""), "ChatGPT Prolite");
  assert.equal(tier("unknown", "Custom model gateway"), "Custom model gateway");
  assert.equal(tier(undefined, ""), "");
});

test("a window of another length has no period, and a monthly one reads as monthly", () => {
  assert.equal(usageFromRateLimits({ rateLimits: { primary: window(5, 60) } }, "")?.period, "");
  assert.equal(usageFromRateLimits({ rateLimits: { primary: window(5, 30 * 24 * 60) } }, "")?.period, "monthly");
  assert.equal(usageFromRateLimits({ rateLimits: { primary: { usedPercent: 5, windowDurationMins: null, resetsAt: null } } }, "")?.resetsAt, null);
});

test("no windows, or no answer, is no meter", () => {
  assert.equal(usageFromRateLimits(null, "ChatGPT Plus"), null);
  assert.equal(usageFromRateLimits({ rateLimits: { primary: null, secondary: null } }, ""), null);
  assert.equal(usageFromRateLimits({ rateLimits: { primary: { usedPercent: "90" } } }, ""), null);
});
