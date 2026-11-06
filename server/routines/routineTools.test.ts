import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Provider } from "../../bridge/provider.ts";
import { answerMcp, type McpTool, type ToolResult } from "../mcp/mcp.ts";
import { PROMPT_OPTIONS, createPrompts, type HostPrompt } from "../chat/prompts.ts";
import { createRoutineEdits } from "./routineEdits.ts";
import { createRoutineStore } from "./routines.ts";
import { routineTools } from "./routineTools.ts";

process.env.TZ = "Europe/Berlin";

const NOW = new Date(2026, 9, 27, 12, 0);

const CLAUDE = {
  id: "claude",
  label: "Claude",
  modes: [
    { id: "ask", name: "Ask" },
    { id: "plan", name: "Plan" },
    { id: "auto", name: "Auto" },
    { id: "full", name: "Always approve" },
  ],
  models: () => ({ defaultModel: "", defaultEffort: "", models: [{ value: "opus", name: "Opus", defaultEffort: "", efforts: [] }] }),
} as unknown as Provider;

function setup(mode: string | null, defaultMode = "ask") {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "x-bench-routine-tools-")));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createRoutineStore(path.join(dir, "routines.json"), () => NOW);
  const forgotten: string[] = [];
  const edits = createRoutineEdits({ providers: { get: (id) => (id === "claude" ? CLAUDE : null) }, store, scheduler: { forget: (id) => forgotten.push(id) }, chatHome: path.join(dir, "chats") });
  const prompts = createPrompts(() => {});
  const group = routineTools(() => ({ edits, defaults: () => ({ cwd: dir, provider: "claude" }), providers: () => [CLAUDE], runMode: (routine) => routine.mode || defaultMode }), prompts, { modeOf: () => mode, now: () => NOW });
  const tools = Object.fromEntries(group.tools.map((tool) => [tool.spec.name, tool])) as Record<string, McpTool>;
  return { dir, store, tools, prompts, forgotten };
}

async function run(tool: McpTool | undefined, args: unknown): Promise<ToolResult> {
  const reply = await answerMcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool?.spec.name, arguments: args } }, tool ? [tool] : [], { sessionId: "s1", signal: new AbortController().signal });
  return reply?.result as ToolResult;
}

function text(result: ToolResult): string {
  return result.content.map((item) => item.text ?? "").join("\n");
}

async function waitingPrompt(prompts: ReturnType<typeof createPrompts>): Promise<HostPrompt | null> {
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  return prompts.prompt("s1");
}

function optionOf(prompt: HostPrompt | null, kind: string): string {
  return prompt?.options.find((option) => option.optionId.startsWith(`${kind}:`))?.optionId ?? "";
}

const DAILY = { every: "day", at: "09:00", days: [1, 2, 3, 4, 5] };

test("in Auto a routine is made at once, in this chat's folder and on its provider", async () => {
  const { dir, store, tools, prompts } = setup("auto");
  const result = await run(tools.routine_create, { name: "Triage", prompt: "Sort the new issues.", schedule: DAILY, mode: "auto" });
  assert.equal(result.isError, false, text(result));
  assert.equal(prompts.prompt("s1"), null);
  const [routine] = store.list();
  assert.deepEqual([routine?.name, routine?.cwd, routine?.provider, routine?.mode, routine?.enabled], ["Triage", dir, "claude", "auto", true]);
  const listed = text(await run(tools.routine_list, {}));
  assert.match(listed, new RegExp(`${routine?.id} \\| Triage \\| Weekdays at 09:00 \\(next run Tomorrow 09:00\\)`));
  assert.match(listed, /"Sort the new issues\."/);
  assert.match(listed, /claude: ask, auto, full \| opus/);
});

test("in Auto a routine whose runs start in Always approve still asks, for a create and for any change", async () => {
  const { store, tools, prompts } = setup("auto");
  const made = run(tools.routine_create, { name: "Triage", prompt: "Sort the new issues.", schedule: DAILY, mode: "full" });
  const card = await waitingPrompt(prompts);
  assert.equal(card?.title, "Create the routine Triage");
  assert.deepEqual(card?.options.map((option) => option.name), ["Allow once", "Deny"]);
  prompts.answer("s1", optionOf(card, PROMPT_OPTIONS.once));
  assert.equal((await made).isError, false);
  const id = store.list()[0]?.id ?? "";

  const reworded = run(tools.routine_update, { id, prompt: "Close every issue." });
  const change = await waitingPrompt(prompts);
  assert.equal(change?.title, "Change the routine Triage");
  prompts.answer("s1", optionOf(change, PROMPT_OPTIONS.deny));
  assert.equal((await reworded).isError, true);
  assert.equal(store.get(id)?.prompt, "Sort the new issues.");

  const calmed = await run(tools.routine_update, { id, mode: "auto" });
  assert.equal(calmed.isError, false, text(calmed));
  const raised = run(tools.routine_update, { id, mode: "full" });
  assert.match((await waitingPrompt(prompts))?.detail ?? "", /^mode: auto → full/);
  prompts.answer("s1", optionOf(prompts.prompt("s1"), PROMPT_OPTIONS.once));
  assert.equal((await raised).isError, false);
  assert.equal(store.get(id)?.mode, "full");
});

test("in Auto a routine without its own mode asks when the provider's runs start in Always approve", async () => {
  const { store, tools, prompts } = setup("auto", "full");
  const made = run(tools.routine_create, { name: "Triage", prompt: "Go.", schedule: DAILY });
  const card = await waitingPrompt(prompts);
  assert.equal(card?.title, "Create the routine Triage");
  assert.match(card?.detail ?? "", /\| claude \| default mode \(full\)\n/);
  prompts.answer("s1", optionOf(prompts.prompt("s1"), PROMPT_OPTIONS.deny));
  assert.equal((await made).isError, true);
  assert.deepEqual(store.list(), []);
});

test("in other modes a change asks first, and a declined one changes nothing", async () => {
  const { store, tools, prompts } = setup("ask");
  const asked = run(tools.routine_create, { name: "Triage", prompt: "Sort the new issues.", schedule: DAILY });
  const prompt = await waitingPrompt(prompts);
  assert.equal(prompt?.title, "Create the routine Triage");
  assert.equal(prompt?.kind, "routine");
  assert.deepEqual(prompt?.options.map((option) => option.name), ["Allow once", "Deny"]);
  prompts.answer("s1", optionOf(prompt, PROMPT_OPTIONS.deny));
  const declined = await asked;
  assert.equal(declined.isError, true);
  assert.match(text(declined), /declined/);
  assert.deepEqual(store.list(), []);

  const again = run(tools.routine_create, { name: "Triage", prompt: "Sort the new issues.", schedule: DAILY });
  prompts.answer("s1", optionOf(await waitingPrompt(prompts), PROMPT_OPTIONS.once));
  assert.equal((await again).isError, false);
  const id = store.list()[0]?.id ?? "";

  const paused = run(tools.routine_update, { id, name: "Weekly triage", enabled: false });
  const change = await waitingPrompt(prompts);
  assert.equal(change?.title, "Change the routine Triage");
  assert.match(change?.detail ?? "", /^name: Triage → Weekly triage\nenabled: true → false\n\nWeekly triage \| .*\(paused\)/);
  prompts.answer("s1", optionOf(change, PROMPT_OPTIONS.once));
  assert.equal((await paused).isError, false);
  assert.equal(store.get(id)?.enabled, false);
});

test("a routine the Routines page would refuse is refused before anyone is asked", async () => {
  const { store, tools, prompts } = setup("ask");
  for (const [args, message] of [
    [{ name: "Triage", prompt: "Go.", schedule: DAILY, mode: "plan" }, /no approval mode plan/],
    [{ name: "Triage", prompt: "Go.", schedule: { every: "once", at: "2026-10-27T11:00" } }, /has not passed/],
    [{ name: "Triage", prompt: "Go.", schedule: DAILY, provider: "nobody" }, /Choose a model/],
    [{ name: "Triage", prompt: "Go.", schedule: DAILY, cwd: "/no/such/folder" }, /Folder does not exist/],
    [{ name: "Triage", prompt: "Go.", schedule: { every: "weekly" } }, /Choose when/],
  ] as const) {
    const result = await run(tools.routine_create, args);
    assert.equal(result.isError, true);
    assert.match(text(result), message);
  }
  assert.equal(prompts.prompt("s1"), null);
  assert.deepEqual(store.list(), []);
  assert.match(text(await run(tools.routine_update, { id: "gone", name: "New" })), /No routine has the id gone/);
  assert.match(text(await run(tools.routine_delete, { id: "gone" })), /No routine has the id gone/);
  assert.equal(prompts.prompt("s1"), null);
});

test("deleting a routine removes it and lets the scheduler forget it", async () => {
  const { store, tools, forgotten } = setup("full");
  await run(tools.routine_create, { name: "Triage", prompt: "Go.", schedule: { every: "manual" } });
  const id = store.list()[0]?.id ?? "";
  const changed = await run(tools.routine_update, { id, schedule: { every: "hours", hours: 2, minute: 30 } });
  assert.match(text(changed), /Every 2 hours at :30/);
  assert.equal(text(await run(tools.routine_delete, { id })), "Deleted the routine Triage.");
  assert.deepEqual(store.list(), []);
  assert.deepEqual(forgotten, [id]);
});

test("the card shows the whole prompt and every setting, and routine_list with an id gives the exact routine", async () => {
  const { store, tools, prompts } = setup("ask");
  const prompt = `Check the build.\n${"Then look again. ".repeat(30)}Last line.`;
  const asked = run(tools.routine_create, { name: "Long", prompt, schedule: DAILY, effort: "high", notify: false });
  const card = await waitingPrompt(prompts);
  assert.ok(card?.detail.endsWith(`Prompt:\n${prompt}`));
  assert.match(card?.detail ?? "", /effort high \| catch up on \| notify off/);
  prompts.answer("s1", optionOf(card, PROMPT_OPTIONS.once));
  await asked;
  const id = store.list()[0]?.id ?? "";
  assert.match(text(await run(tools.routine_list, {})), /Then look again\. .*…"/);
  assert.equal(JSON.parse(text(await run(tools.routine_list, { id }))).prompt, prompt);
  assert.match(text(await run(tools.routine_list, { id: "gone" })), /No routine has the id gone/);
});

test("a routine that changed while the person was asked is left alone", async () => {
  const { store, tools, prompts } = setup("ask");
  const made = run(tools.routine_create, { name: "Triage", prompt: "Go.", schedule: DAILY });
  prompts.answer("s1", optionOf(await waitingPrompt(prompts), PROMPT_OPTIONS.once));
  await made;
  const id = store.list()[0]?.id ?? "";

  const renamed = run(tools.routine_update, { id, name: "Renamed" });
  const card = await waitingPrompt(prompts);
  store.update(id, { prompt: "Something else." });
  prompts.answer("s1", optionOf(card, PROMPT_OPTIONS.once));
  const result = await renamed;
  assert.equal(result.isError, true);
  assert.match(text(result), /changed while the person was asked/);
  assert.deepEqual([store.get(id)?.name, store.get(id)?.prompt], ["Triage", "Something else."]);

  const deleted = run(tools.routine_delete, { id });
  const ask = await waitingPrompt(prompts);
  store.update(id, { enabled: false });
  prompts.answer("s1", optionOf(ask, PROMPT_OPTIONS.once));
  assert.match(text(await deleted), /changed while the person was asked/);
  assert.ok(store.get(id));
});
