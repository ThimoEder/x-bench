import type { AccountUsage, UsageWindow } from "./provider.ts";

// The meter shows the fullest window. The rest are listed when there is more than one.
export function accountUsage(windows: UsageWindow[], tier: string): AccountUsage | null {
  const [fullest] = [...windows].sort((a, b) => b.percent - a.percent);
  if (!fullest) return null;
  return { ...fullest, tier, ...(windows.length > 1 ? { windows } : {}) };
}
