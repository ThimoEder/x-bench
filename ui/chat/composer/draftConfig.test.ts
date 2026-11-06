import assert from "node:assert/strict";
import test from "node:test";
import { catalogFor, composerOptions, draftChoice, effortStamp, noteEffort, rememberEffort, withMemory, withPick } from "./draftConfig.ts";

const catalog = {
  defaultModel: "grok:grok-4.7",
  defaultEffort: "medium",
  models: [
    {
      value: "grok:grok-4.7",
      name: "Grok 4.7",
      provider: "grok",
      model: "grok-4.7",
      group: "Grok",
      defaultEffort: "high",
      efforts: [
        { value: "xhigh", name: "Extra High" },
        { value: "high", name: "High" },
        { value: "medium", name: "Medium" },
      ],
    },
    {
      value: "grok:grok-4.5",
      name: "Grok 4.5",
      provider: "grok",
      model: "grok-4.5",
      group: "Grok",
      defaultEffort: "high",
      efforts: [
        { value: "high", name: "High" },
        { value: "low", name: "Low" },
      ],
    },
    { value: "grok:plain", name: "Plain", provider: "grok", model: "plain", group: "Grok", defaultEffort: "", efforts: [] },
    {
      value: "claude:opus",
      name: "Opus 5.5",
      provider: "claude",
      model: "opus",
      group: "Claude",
      defaultEffort: "default",
      efforts: [
        { value: "default", name: "Default" },
        { value: "high", name: "High" },
      ],
    },
  ],
};

test("a new session starts on the recommended effort, not the config file", () => {
  const options = composerOptions(catalog, {});
  assert.equal(options[0]?.currentValue, "grok:grok-4.7");
  assert.deepEqual(options[0]?.options.map((item) => item.name), ["Grok 4.7", "Grok 4.5", "Plain", "Opus 5.5"]);
  assert.equal(options[1]?.id, "effort");
  assert.equal(options[1]?.currentValue, "high");
  assert.equal(composerOptions(catalog, { effort: "xhigh" })[1]?.currentValue, "xhigh");
});

test("an open chat's effort is kept until a later selection", () => {
  const open = [{ id: "s", configOptions: [{ id: "effort", name: "Effort", currentValue: "xhigh", options: [] }] }];
  const seeded = rememberEffort({ seeded: false, seen: {}, last: "" }, open, null);
  assert.equal(seeded.last, "xhigh");
  const same = rememberEffort(seeded, open, null);
  assert.equal(same.last, "xhigh");
  const opened = rememberEffort(same, [...open, { id: "old", reasoningEffort: "low" }], null);
  assert.equal(opened.last, "xhigh");
  const changed = rememberEffort(opened, [{ id: "s", reasoningEffort: "medium" }], null);
  assert.equal(changed.last, "medium");
  assert.equal(noteEffort(changed, "low").last, "low");
});

test("a new chat starts on the model and effort last picked, and its own picks win", () => {
  assert.deepEqual(draftChoice(catalog, withMemory({}, "", "claude:opus")), { provider: "claude", model: "opus", effort: "default" });
  assert.deepEqual(draftChoice(catalog, withMemory({}, "low", "grok:grok-4.5")), { provider: "grok", model: "grok-4.5", effort: "low" });
  assert.deepEqual(withMemory({ model: "grok:plain", effort: "high" }, "low", "claude:opus"), { model: "grok:plain", effort: "high" });
  assert.equal(draftChoice(catalog, withMemory({}, "", "chatgpt:gone"))?.model, "grok-4.7");
});

test("the effort stamp only changes with the open sessions or their efforts", () => {
  const open = [{ id: "s", title: "A", revision: 1, configOptions: [{ id: "effort", currentValue: "xhigh" }] }];
  const copy = [{ id: "s", title: "B", revision: 2, configOptions: [{ id: "effort", currentValue: "xhigh" }] }];
  assert.equal(effortStamp(copy), effortStamp(open));
  assert.notEqual(effortStamp([{ id: "s", reasoningEffort: "low" }]), effortStamp(open));
  assert.notEqual(effortStamp([...open, { id: "t" }]), effortStamp(open));
  assert.equal(effortStamp(undefined), "");
});

test("switching models keeps a supported effort and drops the rest", () => {
  const kept = composerOptions(catalog, { model: "grok:grok-4.5", effort: "high" });
  assert.equal(kept[0]?.currentValue, "grok:grok-4.5");
  assert.deepEqual(kept[1]?.options.map((item) => item.value), ["high", "low"]);
  assert.equal(kept[1]?.currentValue, "high");

  const dropped = composerOptions(catalog, { model: "grok:grok-4.5", effort: "xhigh" });
  assert.equal(dropped[1]?.currentValue, "high");

  const plain = composerOptions(catalog, { model: "grok:plain" });
  assert.equal(plain.length, 1);
});

test("a published catalog wins over the installed fallback", () => {
  const published = {
    defaultModel: "grok:grok-4.6",
    defaultEffort: "low",
    models: [{ value: "grok:grok-4.6", name: "Grok 4.6", provider: "grok", model: "grok-4.6", group: "Grok", defaultEffort: "low", efforts: [] }],
  };
  assert.equal(catalogFor({ composer: published }), published);
  assert.equal(catalogFor({}).defaultModel, "grok:grok-4.7");
  assert.equal(catalogFor({}).defaultEffort, "high");
});

test("with Grok off and nothing published, a new chat has no models instead of Grok's list", () => {
  const view = (id: string, enabled: boolean) => ({
    id,
    label: id,
    enabled,
    status: "idle" as const,
    error: null,
    capabilities: { loadSession: true, steer: true, deliverNext: false, steerAttachments: false, btw: false },
    modes: [],
    defaultMode: "full" as const,
  });
  const empty = { defaultModel: "", defaultEffort: "", models: [] };
  assert.deepEqual(catalogFor({ composer: empty, providers: [view("grok", false), view("claude", false)] }).models, []);
  assert.equal(catalogFor({ composer: empty, providers: [view("grok", true), view("claude", false)] }).defaultModel, "grok:grok-4.7");
  assert.equal(draftChoice(catalogFor({ composer: empty, providers: [view("grok", false)] }), {}), null);
});

test("an empty catalog leaves the menus off", () => {
  assert.deepEqual(composerOptions(null, {}), []);
  assert.deepEqual(composerOptions({ models: [] }, { model: "grok-4.7" }), []);
});

test("the model menu groups models by provider, and a Claude pick opens a Claude session", () => {
  const options = composerOptions(catalog, { model: "claude:opus" });
  assert.deepEqual(
    options[0]?.options.map((item) => item.group),
    ["Grok", "Grok", "Grok", "Claude"],
  );
  assert.deepEqual(draftChoice(catalog, { model: "claude:opus", effort: "high" }), { provider: "claude", model: "opus", effort: "high" });
  assert.deepEqual(draftChoice(catalog, {}), { provider: "grok", model: "grok-4.7", effort: "high" });
  // An effort the Claude model does not offer falls back to its default.
  assert.equal(draftChoice(catalog, { model: "claude:opus", effort: "xhigh" })?.effort, "default");
});

test("a new model drops a picked effort it does not offer", () => {
  const catalog = {
    defaultModel: "claude:opus",
    models: [
      { value: "claude:opus", provider: "claude", model: "opus", name: "Opus", group: "Claude", defaultEffort: "high", efforts: [{ value: "high", name: "High" }, { value: "max", name: "Max" }] },
      { value: "grok:fast", provider: "grok", model: "fast", name: "Fast", group: "Grok", defaultEffort: "low", efforts: [{ value: "low", name: "Low" }] },
    ],
  };
  assert.deepEqual(withPick(catalog, { model: "claude:opus", effort: "max" }, "model", "grok:fast"), { model: "grok:fast" });
  assert.deepEqual(withPick(catalog, { model: "grok:fast" }, "model", "claude:opus"), { model: "claude:opus" });
  assert.deepEqual(withPick(catalog, { model: "claude:opus" }, "effort", "max"), { model: "claude:opus", effort: "max" });
});
