import assert from "node:assert/strict";
import test from "node:test";
import { PROMPT_OPTIONS, createPrompts } from "./prompts.ts";

test("a simulator prompt offers always for its device and remembers the answer for the session", async () => {
  let changes = 0;
  const prompts = createPrompts(() => {
    changes += 1;
  });
  const asked = prompts.ask("s1", { kind: "simulator", title: "Tap on iPhone 17 Pro", detail: "iPhone 17 Pro (iOS 26.2)", origin: "device:ABC", place: "iPhone 17 Pro" });
  const prompt = prompts.prompt("s1");
  assert.equal(prompt?.kind, "simulator");
  assert.deepEqual(prompt?.options.map((option) => option.name), ["Allow once", "Always allow on iPhone 17 Pro", "Deny"]);
  const always = prompt?.options.find((option) => option.optionId.startsWith(`${PROMPT_OPTIONS.site}:`))?.optionId ?? "";
  assert.equal(prompts.answer("s1", PROMPT_OPTIONS.site), false, "a bare option id answers nothing");
  assert.equal(prompts.answer("s1", always), true);
  assert.equal(await asked, "site");
  assert.equal(prompts.allowed("s1", "device:ABC"), true);
  assert.equal(prompts.allowed("s2", "device:ABC"), false);
  prompts.forget("s1");
  assert.equal(prompts.allowed("s1", "device:ABC"), false);
  assert.equal(changes, 2);
});

test("stopping the turn denies what waits", async () => {
  const prompts = createPrompts(() => {});
  const asked = prompts.ask("s1", { title: "Open example.com", detail: "", origin: "https://example.com" });
  assert.deepEqual(prompts.prompt("s1")?.options.map((option) => option.name), ["Allow once", "Always allow on example.com", "Deny"]);
  prompts.cancel("s1");
  assert.equal(await asked, "deny");
  assert.equal(prompts.prompt("s1"), null);
});
