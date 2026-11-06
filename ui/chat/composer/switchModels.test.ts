import assert from "node:assert/strict";
import test from "node:test";
import type { ComposerCatalog } from "../../../server/snapshot.ts";
import { switchChoice, withOtherProviders } from "./switchModels.ts";

const catalog: ComposerCatalog = {
  defaultModel: "claude:opus",
  defaultEffort: "",
  models: [
    { value: "claude:opus", name: "Opus 5.5", defaultEffort: "", efforts: [], provider: "claude", model: "opus", group: "Claude" },
    { value: "grok:grok-4", name: "Grok 4.2", defaultEffort: "", efforts: [], provider: "grok", model: "grok-4", group: "Grok" },
    { value: "chatgpt:gpt", name: "GPT-5.5", defaultEffort: "", efforts: [], provider: "chatgpt", model: "gpt", group: "ChatGPT", older: true },
  ],
};

test("a Claude chat's menu lists its own models first, then every other provider's under its name", () => {
  const own = { id: "model", name: "Model", currentValue: "opus", options: [{ value: "opus", name: "Opus 5.5" }, { value: "sonnet", name: "Sonnet 5.5" }] };
  const menu = withOtherProviders(own, "claude", "Claude", catalog);
  assert.deepEqual(
    menu.options.map((choice) => [choice.group, choice.value]),
    [
      ["Claude", "opus"],
      ["Claude", "sonnet"],
      ["Grok", "switch:grok:grok-4"],
      ["ChatGPT", "switch:chatgpt:gpt"],
    ],
  );
  assert.equal(menu.options.at(-1)?.older, true);
  assert.equal(menu.currentValue, "opus");
});

test("only another provider's model asks to switch", () => {
  assert.deepEqual(switchChoice("switch:grok:grok-4", catalog), { provider: "grok", model: "grok-4", name: "Grok 4.2", label: "Grok" });
  assert.equal(switchChoice("sonnet", catalog), null);
});

test("with one provider on, the menu stays as it was", () => {
  const own = { id: "model", name: "Model", currentValue: "opus", options: [{ value: "opus", name: "Opus 5.5" }] };
  assert.equal(withOtherProviders(own, "claude", "Claude", { models: catalog.models.slice(0, 1) }), own);
});
