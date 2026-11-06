import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LIMITS, MAX_PER_SESSION, SUGGEST_TOOL, createTaskSuggestions, suggestTools, type TaskSuggestions } from "./taskSuggestions.ts";
import { answerMcp, type JsonRpcReply } from "../mcp/mcp.ts";

function scratchFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x-bench-suggestions-"));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "suggestions.json");
}

const input = { title: "Fix the stale badge", summary: "The README badge points at the old CI.", prompt: "Point the badge in README.md at the new workflow." };

function call(args: unknown, id = 1) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name: SUGGEST_TOOL, arguments: args } };
}

async function suggest(store: TaskSuggestions, args: unknown, sessionId: string | null = "s1") {
  return toolResult(await answerMcp(call(args), suggestTools(store).tools, { sessionId, signal: new AbortController().signal }));
}

function toolResult(reply: JsonRpcReply | null) {
  assert.ok(reply && "result" in reply, "no result");
  return reply.result as { content: { type: string; text: string }[]; isError: boolean };
}

test("suggestions are kept per session in the file, and removing the last one drops the session", () => {
  const file = scratchFile();
  const store = createTaskSuggestions(file);
  let changes = 0;
  store.onChange(() => (changes += 1));

  const first = store.add("s1", input);
  store.add("s2", { ...input, title: "Other" });
  assert.deepEqual(store.list("s1"), [first]);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, "utf8")).sessions), ["s1", "s2"]);
  // A second store on the same file, like another host on the same home, reads the same.
  assert.deepEqual(createTaskSuggestions(file).list("s1"), [first]);

  assert.equal(store.remove("s1", "nope"), false);
  assert.equal(store.remove("s1", first.id), true);
  assert.deepEqual(store.list("s1"), []);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, "utf8")).sessions), ["s2"]);
  store.dropSession("s2");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { sessions: {} });
  assert.equal(changes, 4);
});

test("a change another host wrote is noticed once", () => {
  const file = scratchFile();
  const store = createTaskSuggestions(file);
  assert.equal(store.changedOnDisk(), false);
  store.add("s1", input);
  assert.equal(store.changedOnDisk(), false, "its own write is not news");
  createTaskSuggestions(file).add("s1", { ...input, title: "From the other host" });
  assert.equal(store.changedOnDisk(), true);
  assert.equal(store.changedOnDisk(), false);
  assert.equal(store.list("s1").length, 2);
});

test("a file that does not read is left alone, and adding says so", () => {
  const file = scratchFile();
  fs.writeFileSync(file, "{ not json");
  const store = createTaskSuggestions(file);
  assert.deepEqual(store.list("s1"), []);
  assert.throws(() => store.add("s1", input), /does not read/);
  assert.equal(fs.readFileSync(file, "utf8"), "{ not json");
});

test("suggest_task stores a cleaned suggestion, and tells the agent what was wrong otherwise", async () => {
  const store = createTaskSuggestions(scratchFile());
  const ok = await suggest(store, { title: "  Fix\nthe\u200b badge ", summary: " Why. ", prompt: "Do it.\u{E0041}" });
  assert.equal(ok.isError, false);
  assert.match(ok.content[0]?.text ?? "", /Suggested "Fix the badge"/);
  const [saved] = store.list("s1");
  assert.equal(saved?.title, "Fix the badge");
  assert.equal(saved?.summary, "Why.");
  assert.equal(saved?.prompt, "Do it.", "hidden characters never reach the prompt");

  const missing = await suggest(store, { title: "Only a title" });
  assert.equal(missing.isError, true);
  assert.equal(missing.content[0]?.text, "Give summary, prompt.");
  const long = await suggest(store, { ...input, prompt: "x".repeat(LIMITS.prompt + 1) });
  assert.equal(long.isError, true);
  assert.match(long.content[0]?.text ?? "", /prompt \(at most 6000 characters\)/);
  const unbound = await suggest(store, input, null);
  assert.equal(unbound.isError, true);
  assert.equal(store.list("s1").length, 1);
});

test("a chat holds a limited number of suggestions", async () => {
  const store = createTaskSuggestions(scratchFile());
  for (let index = 0; index < MAX_PER_SESSION; index += 1) store.add("s1", input);
  const refused = await suggest(store, input);
  assert.equal(refused.isError, true);
  assert.match(refused.content[0]?.text ?? "", /already has 20 suggestions/);
});
