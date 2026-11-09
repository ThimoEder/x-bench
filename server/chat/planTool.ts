// update_plan: the agent's step list, shown in the composer's plan shelf and the dock's Plan tab.

import { setTimeout as sleep } from "node:timers/promises";
import type { PlanEntry } from "../../bridge/protocol.ts";
import type { SessionState, ToolItem } from "../../bridge/reducer.ts";
import { isRecord } from "../../bridge/lenient.ts";
import { MCP_SERVER, toolText, type McpGroup } from "../mcp/mcp.ts";

export const PLAN_TOOL = "update_plan";

const MAX_STEPS = 12;
const MAX_STEP_TEXT = 160;
const STATUSES = ["pending", "in_progress", "completed"];
const ROW_WAIT_MS = 500;

export interface PlanHost {
  sessionOf(sessionId: string): Pick<SessionState, "plan" | "transcript"> | null | undefined;
  setPlan(sessionId: string, entries: PlanEntry[]): void;
}

const PLAN_HINT = `Keep the step list the person sees above the composer with the ${PLAN_TOOL} tool of the ${MCP_SERVER} MCP server, as its description says.`;

const PLAN_DESCRIPTION = [
  "Keep the step list the app shows above the composer while you work. Every request that edits files or runs more than one command gets one (implement-and-test, investigate-then-fix, anything the person listed); only a single-command answer or pure conversation does not.",
  "Never spend a message on this tool alone while work remains: send it in the same message as another tool call, in parallel.",
  '- First call: with the very first tool call of the turn, even one that only reads files: {"items": [...]}, the whole plan in order, short imperative phrases (about 7 words, no numbering), the step you start "in_progress", the rest "pending". If you must look around first, make "Look at how X is set up" step one and refine the list once you know.',
  '- Next step: {"advance": true} alongside the call that begins it. It completes the step in progress and starts the next pending one.',
  '- Out of order: {"done": [2], "start": 4}, with steps counted from 1.',
  '- Plan changed, also when the person sends a new instruction mid-task: {"items": [...]} again, the new whole list.',
  '- Last step done: {"advance": true} before your closing message, so the list shows every step done.',
  "Keep exactly one step in_progress while working. Do not also write the plan as a numbered list in your message: the list on screen is the plan.",
].join("\n");

const PLAN_TOOL_SPEC = {
  name: PLAN_TOOL,
  title: "Update the plan",
  description: PLAN_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        description: `The whole plan in order (1 to ${MAX_STEPS} steps). It replaces the list on screen.`,
        items: {
          type: "object",
          properties: { content: { type: "string" }, status: { type: "string", enum: STATUSES } },
          required: ["content", "status"],
        },
      },
      advance: { type: "boolean", description: "Completes the step in progress and starts the next pending one." },
      done: { type: "array", items: { type: "integer" }, description: "Steps to mark completed, counted from 1." },
      start: { type: "integer", description: "The step to mark in_progress, counted from 1." },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  // A harness may otherwise defer the tool behind its tool search, where the agent seldom looks.
  _meta: { "anthropic/alwaysLoad": true },
};

// shortcut: the plan lives only in the open session, so reopening a chat from its log drops it until the agent's next call.
export function planTools(host: PlanHost): McpGroup {
  return {
    instructions: PLAN_HINT,
    tools: [
      {
        spec: PLAN_TOOL_SPEC,
        trusted: true,
        async call(args, { sessionId, meta = {} }) {
          if (!sessionId) return toolText("This chat is still opening. Try again in a moment.", true);
          if (await fromSubagent(host, sessionId, meta)) return toolText("The step list belongs to the main agent, so nothing changed. Carry on without this tool.", false);
          const result = nextPlan(host.sessionOf(sessionId)?.plan ?? null, args);
          if ("error" in result) return toolText(result.error, true);
          host.setPlan(sessionId, result.steps);
          return toolText(result.reply, false);
        },
      },
    ],
  };
}

// The plan belongs to the main agent. A harness names the tool call a request makes in its _meta, and a subagent's
// row names its parent. The request can arrive before its row, so a call with no row yet waits a moment for it.
async function fromSubagent(host: PlanHost, sessionId: string, meta: Record<string, unknown>): Promise<boolean> {
  const named = Object.values(meta).filter((value) => typeof value === "string");
  const row = () => host.sessionOf(sessionId)?.transcript.find((item): item is ToolItem => item.type === "tool" && named.includes(item.toolCallId));
  for (let waited = 0; named.length > 0 && !row() && waited < ROW_WAIT_MS; waited += 20) await sleep(20);
  return Boolean(row()?.parentId);
}

export function nextPlan(current: PlanEntry[] | null, args: unknown): { steps: PlanEntry[]; reply: string } | { error: string } {
  const input = isRecord(args) ? args : {};
  if (Array.isArray(input.items)) {
    const steps = input.items.flatMap(planStep).slice(0, MAX_STEPS);
    if (!steps.length) return { error: 'items needs at least one step with "content" and "status".' };
    const doing = steps.filter((step) => step.status === "in_progress").length;
    return { steps, reply: `Plan shown (${steps.length} steps).${doing > 1 ? " Keep only one step in_progress." : ""}` };
  }
  const advance = input.advance === true;
  const done: unknown[] = Array.isArray(input.done) ? input.done : [];
  const start = input.start;
  if (!advance && !done.length && start === undefined) {
    return { error: 'Send {"items": [...]} (the whole plan), {"advance": true}, or {"done": [n], "start": m}.' };
  }
  if (!current?.length) return { error: 'There is no plan yet. Send the whole plan first: {"items": [...]}.' };
  const count = current.length;
  const isStep = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 1 && Number(value) <= count;
  if (!done.every(isStep) || (start !== undefined && !isStep(start))) {
    return { error: `Nothing changed: the plan has ${count} steps, counted from 1. Send the numbers again, or the whole plan if it changed.` };
  }
  const statuses = current.map((step) => step.status || "pending");
  for (const step of done) statuses[step - 1] = "completed";
  if (isStep(start)) statuses[start - 1] = "in_progress";
  if (advance) {
    const doing = statuses.indexOf("in_progress");
    if (doing >= 0) statuses[doing] = "completed";
    const after = statuses.indexOf("pending", doing + 1);
    const next = after >= 0 ? after : statuses.indexOf("pending");
    if (next >= 0) statuses[next] = "in_progress";
  }
  const steps = current.map((step, index) => ({ ...step, status: statuses[index] }));
  return { steps, reply: `Plan updated: ${standing(statuses)}.` };
}

function planStep(item: unknown): PlanEntry[] {
  if (!isRecord(item) || typeof item.content !== "string") return [];
  const content = item.content.replace(/\s+/g, " ").trim().slice(0, MAX_STEP_TEXT);
  if (!content) return [];
  const status = typeof item.status === "string" && STATUSES.includes(item.status) ? item.status : "pending";
  return [{ content, status }];
}

function standing(statuses: string[]): string {
  const doing = statuses.flatMap((status, index) => (status === "in_progress" ? [index + 1] : []));
  if (doing.length === 1) return `step ${doing[0]} of ${statuses.length} is in progress`;
  if (doing.length > 1) return `steps ${doing.join(", ")} of ${statuses.length} are in progress; keep one`;
  const done = statuses.filter((status) => status === "completed").length;
  return done === statuses.length ? "every step is done" : `no step is in progress (${done} of ${statuses.length} done)`;
}
