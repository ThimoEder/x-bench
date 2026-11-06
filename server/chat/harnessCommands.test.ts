import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHarnessCommands } from "./harnessCommands.ts";

test("a new chat gets the folder's last list, or else the provider's newest", () => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "harness-commands-")), "harness-commands.json");
  const store = createHarnessCommands(file);
  assert.deepEqual(store.read("claude", "/a"), []);

  store.save("claude", "/a", [{ name: "why", description: "Find the reason" }]);
  store.save("claude", "/b", [{ name: "how", description: "Trace it" }]);
  store.save("chatgpt", "/a", [{ name: "$why", description: "Find the reason" }]);

  assert.deepEqual(store.read("claude", "/a").map((command) => command.name), ["why"]);
  assert.deepEqual(store.read("claude", "/c").map((command) => command.name), ["how"]);
  assert.deepEqual(store.read("chatgpt", "/b").map((command) => command.name), ["$why"]);
  assert.deepEqual(store.read("grok", "/a"), []);

  store.save("claude", "/a", [{ name: "why", description: "Changed" }]);
  assert.deepEqual(store.read("claude", "/c")[0], { name: "why", description: "Changed" });
});

test("a folder that reports the same list again becomes the newest", () => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "harness-commands-")), "harness-commands.json");
  const store = createHarnessCommands(file);
  store.save("grok", "/a", [{ name: "why", description: "" }]);
  store.save("grok", "/b", [{ name: "how", description: "" }]);
  store.save("grok", "/a", [{ name: "why", description: "" }]);
  assert.deepEqual(store.read("grok", "/c").map((command) => command.name), ["why"]);
});

test("each provider keeps its twenty newest folders", () => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "harness-commands-")), "harness-commands.json");
  const store = createHarnessCommands(file);
  for (let index = 0; index < 25; index += 1) {
    store.save("grok", `/f${index}`, [{ name: `s${index}`, description: "" }]);
  }
  const folders = Object.keys(JSON.parse(readFileSync(file, "utf8")).grok);
  assert.equal(folders.length, 20);
  assert.equal(folders[0], "/f5");
  assert.deepEqual(store.read("grok", "/f0").map((command) => command.name), ["s24"]);
});
