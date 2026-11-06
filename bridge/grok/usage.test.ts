import assert from "node:assert/strict";
import test from "node:test";
import { presentUsage } from "./usage.ts";

test("weekly credit usage becomes a sidebar figure", () => {
  const usage = presentUsage({
    config: {
      creditUsagePercent: 17.2,
      currentPeriod: {
        type: "USAGE_PERIOD_TYPE_WEEKLY",
        end: "2026-09-25T20:49:12.509108+00:00",
      },
    },
    subscription_tier: "SuperGrok Heavy",
  });
  assert.deepEqual(usage, {
    percent: 17,
    period: "weekly",
    resetsAt: "2026-09-25T20:49:12.509108+00:00",
    tier: "SuperGrok Heavy",
  });
});

test("a monthly period and a nested result still read", () => {
  const usage = presentUsage({
    result: {
      config: {
        creditUsagePercent: 80,
        currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY" },
        billingPeriodEnd: "2026-10-01T00:00:00Z",
      },
      subscriptionTier: "SuperGrok",
    },
  });
  assert.equal(usage?.period, "monthly");
  assert.equal(usage?.percent, 80);
  assert.equal(usage?.resetsAt, "2026-10-01T00:00:00Z");
  assert.equal(usage?.tier, "SuperGrok");
});

test("a fresh week with no percent reads as zero", () => {
  const usage = presentUsage({
    config: {
      currentPeriod: {
        type: "USAGE_PERIOD_TYPE_WEEKLY",
        start: "2026-09-25T20:49:12.509108+00:00",
        end: "2026-10-02T20:49:12.509108+00:00",
      },
      billingPeriodStart: "2026-09-25T20:49:12.509108+00:00",
      billingPeriodEnd: "2026-10-02T20:49:12.509108+00:00",
    },
    subscriptionTier: "SuperGrok Heavy",
  });
  assert.equal(usage?.percent, 0);
  assert.equal(usage?.period, "weekly");
  assert.equal(usage?.resetsAt, "2026-10-02T20:49:12.509108+00:00");
  assert.equal(usage?.tier, "SuperGrok Heavy");
});

test("missing billing data stays hidden", () => {
  assert.equal(presentUsage(null), null);
  assert.equal(presentUsage({ config: {} }), null);
  assert.equal(presentUsage({ config: { creditUsagePercent: "nope" } }), null);
});
