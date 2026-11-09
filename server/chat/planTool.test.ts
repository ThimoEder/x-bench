import assert from "node:assert/strict";
import test from "node:test";
import type { PlanEntry } from "../../bridge/protocol.ts";
import type { TranscriptItem } from "../../bridge/reducer.ts";
import { answerMcp } from "../mcp/mcp.ts";
import { PLAN_TOOL, nextPlan, planTools } from "./planTool.ts";

const statuses = (steps: PlanEntry[]) => steps.map((step) => step.status);

function stepsOf(result: ReturnType<typeof nextPlan>): PlanEntry[] {
  assert.ok("steps" in result, "error" in result ? result.error : "");
  return result.steps;
}

test("items set the whole plan, cleaned and capped", () => {
  const steps = stepsOf(nextPlan(null, { items: [{ content: "  Read   the code ", status: "in_progress" }, { content: "", status: "pending" }, { content: "Fix it", status: "odd" }] }));
  assert.deepEqual(steps, [
    { content: "Read the code", status: "in_progress" },
    { content: "Fix it", status: "pending" },
  ]);
  assert.equal(stepsOf(nextPlan(null, { items: Array.from({ length: 20 }, (_, i) => ({ content: `Step ${i}`, status: "pending" })) })).length, 12);
  assert.ok("error" in nextPlan(null, { items: [] }));
});

test("advance completes the current step and starts the next pending one", () => {
  const plan = stepsOf(nextPlan(null, { items: [{ content: "A", status: "in_progress" }, { content: "B", status: "pending" }, { content: "C", status: "pending" }] }));
  const second = stepsOf(nextPlan(plan, { advance: true }));
  assert.deepEqual(statuses(second), ["completed", "in_progress", "pending"]);
  const last = stepsOf(nextPlan(stepsOf(nextPlan(second, { advance: true })), { advance: true }));
  assert.deepEqual(statuses(last), ["completed", "completed", "completed"]);
  assert.deepEqual(nextPlan(last, { advance: true }), { steps: last, reply: "Plan updated: every step is done." });
});

test("done and start move steps out of order, and wrong numbers change nothing", () => {
  const plan = stepsOf(nextPlan(null, { items: ["A", "B", "C", "D"].map((content) => ({ content, status: "pending" })) }));
  assert.deepEqual(statuses(stepsOf(nextPlan(plan, { done: [1, 2], start: 4 }))), ["completed", "completed", "pending", "in_progress"]);
  assert.ok("error" in nextPlan(plan, { done: [5] }));
  assert.ok("error" in nextPlan(plan, { start: 0 }));
  assert.ok("error" in nextPlan(plan, { done: ["2"] }));
  assert.ok("error" in nextPlan(null, { advance: true }), "an update needs a plan first");
  assert.ok("error" in nextPlan(plan, {}));
});

test("the tool loads upfront, runs without asking, and sets the session's plan", async () => {
  const plans = new Map<string, PlanEntry[]>();
  const transcript: TranscriptItem[] = [];
  const row = (toolCallId: string, parentId?: string) => ({ type: "tool", toolCallId, parentId }) as TranscriptItem;
  const group = planTools({ sessionOf: (id) => ({ plan: plans.get(id) ?? null, transcript }), setPlan: (id, entries) => plans.set(id, entries) });
  const [tool] = group.tools;
  assert.ok(tool);
  assert.equal(tool.trusted, true);
  assert.deepEqual(tool.spec._meta, { "anthropic/alwaysLoad": true });

  const context = { sessionId: "s1", signal: new AbortController().signal };
  const listed = await answerMcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }, group.tools, context);
  const listedTools = (listed?.result as { tools?: { _meta?: unknown }[] } | undefined)?.tools ?? [];
  assert.deepEqual(listedTools[0]?._meta, { "anthropic/alwaysLoad": true });

  const call = (args: unknown, sessionId: string | null = "s1") => tool.call(args, { ...context, sessionId });
  assert.equal((await call({ items: [{ content: "A", status: "in_progress" }, { content: "B", status: "pending" }] })).isError, false);
  assert.equal((await call({ advance: true })).content[0]?.text, "Plan updated: step 2 of 2 is in progress.");
  assert.deepEqual(statuses(plans.get("s1") ?? []), ["completed", "in_progress"]);
  assert.equal((await call({ advance: true }, null)).isError, true);

  const callAs = (toolCallId: string) => answerMcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: PLAN_TOOL, arguments: { items: [{ content: "Mine", status: "in_progress" }] }, _meta: { toolUseId: toolCallId } } }, group.tools, context);
  transcript.push(row("sub-1", "agent-1"));
  await callAs("sub-1");
  const late = callAs("sub-2");
  setTimeout(() => transcript.push(row("sub-2", "agent-1")), 30);
  await late;
  assert.deepEqual(statuses(plans.get("s1") ?? []), ["completed", "in_progress"], "a subagent's call leaves the plan alone, also when its row comes after the request");
  transcript.push(row("main-1"));
  await callAs("main-1");
  assert.deepEqual(plans.get("s1"), [{ content: "Mine", status: "in_progress" }]);
  assert.equal(PLAN_TOOL, tool.spec.name);
});
