import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { fields } from "../../bridge/lenient.ts";
import type { ContextWindows } from "../present.ts";

// models_cache.json. The numbers are checked below, so they stay unknown here.
const ModelsCache = fields({ models: z.unknown().optional() });
const ModelEntry = fields({ info: z.unknown().optional() });
const ModelInfo = fields({
  context_window: z.unknown().optional(),
  auto_compact_threshold_percent: z.unknown().optional(),
});

type ModelInfo = z.output<typeof ModelInfo>;

const cache: { file: string; mtime: number | null; windows: ContextWindows } = { file: "", mtime: null, windows: {} };

export function contextWindows(file = path.join(os.homedir(), ".grok", "models_cache.json")): ContextWindows {
  let mtime: number;
  try {
    mtime = statSync(file).mtimeMs;
  } catch {
    return {};
  }
  if (cache.file === file && cache.mtime === mtime) return cache.windows;
  const windows = readWindows(file);
  cache.file = file;
  cache.mtime = mtime;
  cache.windows = windows;
  return windows;
}

function readWindows(file: string): ContextWindows {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
  const raw = ModelsCache.parse(data).models;
  const models: [string, unknown][] = Object.entries(raw && typeof raw === "object" ? raw : {});
  const windows: ContextWindows = {};
  for (const [id, entry] of models) {
    const info = ModelInfo.parse(ModelEntry.parse(entry).info);
    const size = info.context_window;
    if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) continue;
    windows[id] = { size, compactAt: compactAt(info) };
  }
  return windows;
}

function compactAt(info: ModelInfo): number {
  const value = info.auto_compact_threshold_percent;
  if (typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 100) return value;
  return 80;
}
