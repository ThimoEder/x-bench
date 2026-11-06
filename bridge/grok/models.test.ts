import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildComposerCatalog, readComposerCatalog } from "./models.ts";

const cache = {
  models: {
    "grok-4.7": {
      info: {
        id: "grok-4.7",
        name: "Grok 4.7",
        hidden: false,
        supports_reasoning_effort: true,
        reasoning_effort: "high",
        reasoning_efforts: [
          { value: "xhigh", label: "Extra High", default: false },
          { value: "high", label: "High", default: true },
          { value: "medium", label: "Medium", default: false },
        ],
      },
    },
    "grok-4.5": {
      info: {
        id: "grok-4.5",
        name: "Grok 4.5",
        hidden: false,
        supports_reasoning_effort: true,
        reasoning_effort: "high",
        reasoning_efforts: [
          { value: "high", label: "High", default: true },
          { value: "low", label: "Low", default: false },
        ],
      },
    },
    hidden: { info: { id: "hidden", name: "Hidden", hidden: true, reasoning_efforts: [] } },
    plain: { info: { id: "plain", name: "Plain", supports_reasoning_effort: false, reasoning_efforts: [{ value: "high", label: "High" }] } },
  },
};

const config = `
[ui]
permission_mode = "always-approve"

[models]
default = "grok-4.7"
default_reasoning_effort = "medium"
`;

test("the composer catalog keeps visible models and the configured defaults", () => {
  const catalog = buildComposerCatalog(cache, config);
  assert.equal(catalog.defaultModel, "grok-4.7");
  assert.equal(catalog.defaultEffort, "medium");
  assert.deepEqual(catalog.models.map((model) => model.value), ["grok-4.7", "grok-4.5", "plain"]);
  assert.deepEqual(catalog.models[0]?.efforts.map((item) => item.name), ["Extra High", "High", "Medium"]);
  assert.equal(catalog.models[0]?.defaultEffort, "high");
  assert.deepEqual(catalog.models[2]?.efforts, []);
});

test("a missing default model falls back to the first visible model", () => {
  const catalog = buildComposerCatalog(cache, '[models]\ndefault = "gone"\n');
  assert.equal(catalog.defaultModel, "grok-4.7");
  assert.equal(catalog.defaultEffort, "");
});

test("reading the catalog caches by file stamp", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "x-bench-composer-"));
  const modelsFile = path.join(dir, "models_cache.json");
  const configFile = path.join(dir, "config.toml");
  writeFileSync(modelsFile, JSON.stringify(cache));
  writeFileSync(configFile, config);
  const first = readComposerCatalog(modelsFile, configFile);
  assert.equal(readComposerCatalog(modelsFile, configFile), first);
  assert.equal(first.defaultModel, "grok-4.7");
  rmSync(dir, { recursive: true, force: true });
});
