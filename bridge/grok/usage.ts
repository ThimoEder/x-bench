import { z } from "zod";
import { fields } from "../lenient.ts";
import type { AccountUsage } from "../provider.ts";

// The billing RPC body. It may sit under result, and the figures under config.
// Values stay unknown where they are coerced below.
const BillingEnvelope = fields({ result: z.unknown().optional() });

const BillingBody = fields({
  config: z.unknown().optional(),
  subscription_tier: z.unknown().optional(),
  subscriptionTier: z.unknown().optional(),
});

const BillingConfig = fields({
  creditUsagePercent: z.unknown().optional(),
  currentPeriod: z.unknown().optional(),
  billingPeriodStart: z.unknown().optional(),
  billingPeriodEnd: z.unknown().optional(),
});

const BillingPeriod = fields({ type: z.unknown().optional(), end: z.unknown().optional() });

type BillingConfig = z.output<typeof BillingConfig>;

export function presentUsage(payload: unknown): AccountUsage | null {
  const result = BillingEnvelope.parse(payload).result;
  const rawBody = result && typeof result === "object" ? result : payload;
  const body = BillingBody.parse(rawBody);
  const rawConfig = body.config && typeof body.config === "object" ? body.config : rawBody;
  const config = BillingConfig.parse(rawConfig);
  const percent = usagePercent(config);
  if (percent == null) return null;
  const currentPeriod = BillingPeriod.parse(config.currentPeriod);
  const rawPeriod = String(currentPeriod.type || "");
  const period = rawPeriod.includes("MONTH") ? "monthly" : rawPeriod.includes("WEEK") ? "weekly" : "";
  const resetsAt = currentPeriod.end || config.billingPeriodEnd || null;
  const tier = typeof body.subscription_tier === "string"
    ? body.subscription_tier
    : typeof body.subscriptionTier === "string"
      ? body.subscriptionTier
      : "";
  return {
    percent: Math.max(0, Math.round(percent)),
    period,
    resetsAt: resetsAt ? String(resetsAt) : null,
    tier,
  };
}

// Grok leaves creditUsagePercent out of a fresh period. That reading is 0, not "no data".
function usagePercent(config: BillingConfig): number | null {
  const raw = config.creditUsagePercent;
  if (raw == null) return hasBillingPeriod(config) ? 0 : null;
  const percent = Number(raw);
  return Number.isFinite(percent) ? percent : null;
}

function hasBillingPeriod(config: BillingConfig): boolean {
  const period = config.currentPeriod;
  if (period && typeof period === "object") return true;
  return Boolean(config.billingPeriodEnd || config.billingPeriodStart);
}
