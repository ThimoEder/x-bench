// The usage meters as the host last published them (~/.x-bench/usage.json), so a page that opens shows
// every meter at once while the fresh reads run.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { accountUsage } from "../../bridge/usage.ts";
import type { ProviderUsage } from "../snapshot.ts";

const UsageWindowSchema = z.object({
  period: z.enum(["monthly", "weekly", "five-hour", ""]),
  percent: z.number(),
  resetsAt: z.string().nullable(),
});

const SavedUsageSchema = z.array(
  UsageWindowSchema.extend({
    provider: z.string(),
    label: z.string(),
    tier: z.string(),
    windows: z.array(UsageWindowSchema).optional(),
  }),
);

export interface UsageStore {
  // A file that does not read is left to the next save, and the meters wait for their reads.
  read(): ProviderUsage[];
  save(usage: ProviderUsage[]): void;
}

export function createUsageStore(file: string): UsageStore {
  let savedText = "";
  return {
    read() {
      try {
        return SavedUsageSchema.parse(JSON.parse(readFileSync(file, "utf8")));
      } catch {
        return [];
      }
    },
    save(usage) {
      const text = `${JSON.stringify(usage, null, 2)}\n`;
      if (savedText === text) return;
      mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, text);
      renameSync(tmp, file);
      savedText = text;
    },
  };
}

// A window whose reset has passed starts again from 0%. The fresh read says when it resets next.
export function afterResets(usage: ProviderUsage, now = Date.now()): ProviderUsage {
  const passed = (resetsAt: string | null) => resetsAt !== null && Date.parse(resetsAt) <= now;
  if (!usage.windows) return passed(usage.resetsAt) ? { ...usage, percent: 0, resetsAt: null } : usage;
  const windows = usage.windows.map((window) => (passed(window.resetsAt) ? { ...window, percent: 0, resetsAt: null } : window));
  const fullest = accountUsage(windows, usage.tier);
  return fullest ? { ...fullest, provider: usage.provider, label: usage.label } : usage;
}
