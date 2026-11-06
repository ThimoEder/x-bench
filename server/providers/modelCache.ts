// The last model list a provider's harness reported (~/.x-bench/claude-models.json,
// ~/.x-bench/chatgpt-models.json), so the model menu has real names before a session of that
// provider exists. The provider writes it whenever the harness sends its config options.

import { z } from "zod";
import { fileStamp, loadDurable, saveDurable } from "../jsonFile.ts";

const NamedChoice = z.object({ value: z.string(), name: z.string() });

const ModelListSchema = z.object({
  models: z.array(NamedChoice),
  efforts: z.array(NamedChoice),
  byModel: z.record(z.string(), z.array(NamedChoice)).optional(),
  // The model and effort the harness opens a new session on, where its own config picks them.
  defaultModel: z.string().optional(),
  defaultEffort: z.string().optional(),
});

export type ModelList = z.output<typeof ModelListSchema>;

function parseModels(value: unknown): ModelList | null {
  const parsed = ModelListSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export interface ModelListStore {
  read(): ModelList | null;
  save(models: ModelList): void;
}

// Read on every snapshot the host publishes, so the file is parsed again only when it changed.
export function createModelList(file: string): ModelListStore {
  let cached: { key: string; value: ModelList | null } | null = null;
  function read(): ModelList | null {
    const key = fileStamp(file);
    if (cached?.key === key) return cached.value;
    const value = loadDurable<ModelList | null>(file, parseModels, null);
    cached = { key, value };
    return value;
  }
  return {
    read,
    save(models) {
      if (JSON.stringify(read()) === JSON.stringify(models)) return;
      saveDurable(file, `${JSON.stringify(models, null, 2)}\n`, parseModels);
    },
  };
}
