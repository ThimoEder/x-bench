import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { fields } from "../lenient.ts";
import type { ModelCatalog as ComposerCatalog, ModelChoice as ComposerModel } from "../provider.ts";

// models_cache.json. Values stay unknown where the catalog coerces them with String().
const ModelsCache = fields({ models: z.unknown().optional() });

const ModelEntry = fields({ info: z.unknown().optional() });

const ModelInfo = fields({
  id: z.unknown().optional(),
  model: z.unknown().optional(),
  name: z.unknown().optional(),
  hidden: z.unknown().optional(),
  supports_reasoning_effort: z.unknown().optional(),
  reasoning_effort: z.unknown().optional(),
  reasoning_efforts: z.unknown().optional(),
});

const EffortInput = fields({
  value: z.unknown().optional(),
  id: z.unknown().optional(),
  label: z.unknown().optional(),
  name: z.unknown().optional(),
  default: z.unknown().optional(),
});

const cache: { key: string; catalog: ComposerCatalog } = { key: "", catalog: emptyCatalog() };

function emptyCatalog(): ComposerCatalog {
  return { defaultModel: "", defaultEffort: "", models: [] };
}

export function readComposerCatalog(
  modelsFile = path.join(os.homedir(), ".grok", "models_cache.json"),
  configFile = path.join(os.homedir(), ".grok", "config.toml"),
): ComposerCatalog {
  const key = `${stamp(modelsFile)}:${stamp(configFile)}`;
  if (cache.key === key) return cache.catalog;
  const catalog = buildComposerCatalog(readJson(modelsFile), readText(configFile));
  cache.key = key;
  cache.catalog = catalog;
  return catalog;
}

export function buildComposerCatalog(data: unknown, configText: string | null | undefined): ComposerCatalog {
  const defaults = modelDefaults(configText || "");
  const models: ComposerModel[] = [];
  const raw = ModelsCache.parse(data).models;
  const entries: [string, unknown][] = Object.entries(raw && typeof raw === "object" ? raw : {});
  for (const [id, entry] of entries) {
    const rawInfo = ModelEntry.parse(entry).info;
    if (!rawInfo) continue;
    const info = ModelInfo.parse(rawInfo);
    if (info.hidden === true) continue;
    const listed = Array.isArray(info.reasoning_efforts)
      ? info.reasoning_efforts.map((item: unknown) => EffortInput.parse(item))
      : [];
    const efforts = info.supports_reasoning_effort === false
      ? []
      : listed.filter((item) => item.value || item.id).map((item) => ({
        value: String(item.value || item.id),
        name: String(item.label || item.name || item.value || item.id),
      }));
    const marked = listed.find((item) => item.default);
    models.push({
      value: String(info.id || info.model || id),
      name: String(info.name || info.id || id),
      defaultEffort: String(marked?.value || marked?.id || info.reasoning_effort || efforts[0]?.value || ""),
      efforts,
    });
  }
  const defaultModel = models.some((model) => model.value === defaults.model) ? defaults.model : (models[0]?.value || "");
  return { defaultModel, defaultEffort: defaults.effort, models };
}

function modelDefaults(text: string): { model: string; effort: string } {
  let section = "";
  let model = "";
  let effort = "";
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const table = trimmed.match(/^\[([^\]]+)]$/);
    if (table) {
      section = (table[1] ?? "").trim();
      continue;
    }
    if (section !== "models") continue;
    const match = trimmed.match(/^(default|default_reasoning_effort)\s*=\s*["']([^"']+)["']/);
    if (!match) continue;
    if (match[1] === "default") model = match[2] ?? "";
    else effort = match[2] ?? "";
  }
  return { model, effort };
}

function stamp(file: string): string {
  try {
    return `${file}:${statSync(file).mtimeMs}`;
  } catch {
    return `${file}:missing`;
  }
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readText(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}
