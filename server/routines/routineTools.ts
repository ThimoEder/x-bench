// The routine tools on the host's MCP server: list, create, change and delete routines. They go through the same
// checks as the Routines page. A change follows the chat's approval mode: Auto and Always approve go ahead, and the
// other modes ask in the permission card. A routine whose runs start in Always approve asks in every mode.

import { isRecord } from "../../bridge/lenient.ts";
import type { Provider } from "../../bridge/provider.ts";
import { MCP_SERVER, preview, toolText, type McpContext, type McpGroup, type ToolResult } from "../mcp/mcp.ts";
import { approved, type Prompts } from "../chat/prompts.ts";
import { clock, dayDate, describeSchedule, nextSlot, shortWhen } from "./routineSchedule.ts";
import { routineChange, type Routine, type RoutineFields } from "./routines.ts";
import type { RoutineEdits } from "./routineEdits.ts";

export const LIST_TOOL = "routine_list";
export const CREATE_TOOL = "routine_create";
export const UPDATE_TOOL = "routine_update";
export const DELETE_TOOL = "routine_delete";

export interface RoutineDefaults {
  cwd: string;
  provider: string;
}

export interface RoutineToolHost {
  edits: RoutineEdits;
  // The folder and provider a routine made in this chat starts from.
  defaults(sessionId: string): RoutineDefaults;
  // The providers that are on.
  providers(): Provider[];
  // The approval mode a run of the routine starts in, or "" for an unknown provider.
  runMode(routine: Pick<Routine, "provider" | "mode">): string;
}

export interface RoutineToolOptions {
  // The chat's approval mode in the app's names (provider.ts MODES), or null when unknown.
  modeOf?: (sessionId: string) => string | null;
  now?: () => Date;
}

const HINT = `To see, create, change or delete X Bench's routines, prompts X Bench runs on a schedule, use ${LIST_TOOL}, ${CREATE_TOOL}, ${UPDATE_TOOL} and ${DELETE_TOOL} of the ${MCP_SERVER} MCP server.`;

const FIELDS = ["name", "prompt", "cwd", "start", "provider", "model", "effort", "mode", "schedule", "catchUp", "notify", "enabled"] as const;

const SCHEDULE = {
  type: "object",
  description:
    'When it runs, in the Mac\'s local time. One of {"every":"manual"}, {"every":"hours","hours":1|2|3|4|6|8|12,"minute":0-59}, {"every":"day","at":"HH:MM","days":[0-6, 0 is Sunday]}, {"every":"once","at":"YYYY-MM-DDTHH:MM"}.',
};

const PROPERTIES = {
  name: { type: "string", description: "The routine's name, at most 120 characters." },
  prompt: { type: "string", description: "The prompt each run sends to a new chat." },
  schedule: SCHEDULE,
  cwd: { type: "string", description: "The folder each run starts in. Defaults to this chat's project folder." },
  start: { type: "string", enum: ["folder", "worktree"], description: "folder runs in the folder itself, worktree in a new git worktree of it. Defaults to folder." },
  provider: { type: "string", description: `The provider id, as ${LIST_TOOL} lists them. Defaults to this chat's provider.` },
  model: { type: "string", description: "A model id of the provider. Empty for its default." },
  effort: { type: "string", description: "A reasoning effort of the model. Empty for its default." },
  mode: { type: "string", description: "The approval mode runs start in, one the provider lists other than plan. Empty for its default." },
  catchUp: { type: "boolean", description: "Run once when a scheduled time was missed. Defaults to true." },
  notify: { type: "boolean", description: "Notify the person when a run ends. Defaults to true." },
  enabled: { type: "boolean", description: "false pauses the routine. Defaults to true." },
};

export function routineTools(host: () => RoutineToolHost, prompts: Pick<Prompts, "ask" | "allowed">, { modeOf = () => null, now = () => new Date() }: RoutineToolOptions = {}): McpGroup {
  // Asks the person, unless the chat's mode goes ahead and the routine's runs do not start in Always approve. null means go ahead.
  async function gate(context: McpContext, title: string, detail: string, routine?: Pick<Routine, "provider" | "mode">): Promise<ToolResult | null> {
    const chat = chatOf(context);
    const full = routine ? host().runMode(routine) === "full" : false;
    if (await approved(prompts, full ? null : modeOf(chat), chat, { kind: "routine", title, detail, origin: "" }, context.signal)) return null;
    return toolText("The person declined this routine change. Ask them how to go on.", true);
  }

  function describe(routine: Pick<Routine, "schedule" | "enabled" | "cwd" | "start" | "provider" | "model" | "mode">): string {
    const next = routine.enabled ? nextSlot(routine.schedule, now()) : null;
    const state = !routine.enabled ? "paused" : next ? `next run ${shortWhen(next, now())}` : "on";
    const model = [routine.provider, routine.model].filter(Boolean).join(" ");
    const runs = host().runMode(routine);
    const mode = routine.mode || (runs ? `default mode (${runs})` : "default mode");
    return `${describeSchedule(routine.schedule)} (${state}) | ${routine.cwd}${routine.start === "worktree" ? " in a worktree" : ""} | ${model} | ${mode}`;
  }

  function list(args: unknown): ToolResult {
    const { edits, providers } = host();
    const id = idIn(args);
    if (id) {
      const routine = edits.get(id);
      return routine ? toolText(JSON.stringify(routine, null, 2)) : missing(id);
    }
    const routines = edits.list();
    const at = now();
    const lines = [
      `It is ${dayDate(at)} ${at.getFullYear()} ${clock(at)} on this Mac.`,
      routines.length ? "Routines, as id | name | schedule | folder | model | mode, then the prompt cut at 200 characters (pass id for one routine's whole prompt):" : "No routines yet.",
      ...routines.flatMap((routine) => [`${routine.id} | ${routine.name} | ${describe(routine)}${routine.pausedReason ? ` | paused because ${routine.pausedReason}` : ""}`, `  ${preview(routine.prompt)}`]),
      "Providers, as id: modes | models:",
      ...providers().map((provider) => {
        const modes = provider.modes.filter((mode) => mode.id !== "plan").map((mode) => mode.id);
        return `${provider.id}: ${modes.join(", ")} | ${provider.models().models.map((model) => model.value).join(", ") || "default only"}`;
      }),
    ];
    return toolText(lines.join("\n"));
  }

  async function create(args: unknown, context: McpContext): Promise<ToolResult> {
    const chat = chatOf(context);
    const { edits, defaults } = host();
    const body = routineChange({ ...defaults(chat), ...fieldsIn(args) });
    const fields = edits.draft(body);
    const denied = await gate(context, `Create the routine ${fields.name}`, card(fields), fields);
    if (denied) return denied;
    const routine = edits.create(body);
    return toolText(`Created ${routine.id} | ${routine.name} | ${describe(routine)}.`);
  }

  async function update(args: unknown, context: McpContext): Promise<ToolResult> {
    const { edits } = host();
    const id = idIn(args);
    const asked = fieldsIn(args);
    if (!Object.keys(asked).length) return toolText(`Give the fields to change, next to id.`, true);
    const current = edits.get(id);
    if (!current) return missing(id);
    const body = routineChange(asked);
    const next = edits.draftChange(id, body);
    const denied = await gate(context, `Change the routine ${current.name}`, `${changesOf(current, next).join("\n")}\n\n${card(next)}`, next);
    if (denied) return denied;
    const moved = changedMeanwhile(edits, current);
    if (moved) return moved;
    const routine = edits.update(id, body);
    return toolText(`Changed ${routine.id} | ${routine.name} | ${describe(routine)}.`);
  }

  async function remove(args: unknown, context: McpContext): Promise<ToolResult> {
    const { edits } = host();
    const id = idIn(args);
    const routine = edits.get(id);
    if (!routine) return missing(id);
    const denied = await gate(context, `Delete the routine ${routine.name}`, card(routine));
    if (denied) return denied;
    const moved = changedMeanwhile(edits, routine);
    if (moved) return moved;
    edits.remove(id);
    return toolText(`Deleted the routine ${routine.name}.`);
  }

  // Everything the routine will do, with its whole prompt, since the person approves all of it.
  function card(routine: RoutineFields): string {
    const settings = `effort ${routine.effort || "default"} | catch up ${routine.catchUp ? "on" : "off"} | notify ${routine.notify ? "on" : "off"}`;
    return `${routine.name} | ${describe(routine)}\n${settings}\nPrompt:\n${routine.prompt}`;
  }

  return {
    instructions: HINT,
    tools: [
      {
        spec: {
          name: LIST_TOOL,
          title: "List routines",
          description: `List X Bench's routines: each one's id, name, schedule, next run, folder, model, approval mode and the start of its prompt. Also lists the providers with the approval modes and models a routine can use, and the time on this Mac. With id, gives that one routine's exact fields as JSON, with its whole prompt: read it before changing a prompt. Use the ids with ${UPDATE_TOOL} and ${DELETE_TOOL}.`,
          inputSchema: { type: "object", properties: { id: { type: "string", description: "A routine's id, for its exact fields and whole prompt." } }, additionalProperties: false },
          annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        },
        trusted: true,
        call: (args) => list(args),
      },
      {
        spec: {
          name: CREATE_TOOL,
          title: "Create a routine",
          description: `Create a routine: a prompt X Bench sends to a new chat on a schedule. The person may be asked first, depending on the chat's approval mode, and is always asked when its runs start in full.`,
          inputSchema: { type: "object", properties: PROPERTIES, required: ["name", "prompt", "schedule"], additionalProperties: false },
          annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        },
        trusted: true,
        call: (args, context) => create(args, context),
      },
      {
        spec: {
          name: UPDATE_TOOL,
          title: "Change a routine",
          description: `Change a routine by its id from ${LIST_TOOL}. Fields left out stay as they are. enabled false pauses it, true turns it on again. The person may be asked first, depending on the chat's approval mode, and is always asked when its runs start in full.`,
          inputSchema: { type: "object", properties: { id: { type: "string", description: `The routine's id from ${LIST_TOOL}.` }, ...PROPERTIES }, required: ["id"], additionalProperties: false },
          annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        },
        trusted: true,
        call: (args, context) => update(args, context),
      },
      {
        spec: {
          name: DELETE_TOOL,
          title: "Delete a routine",
          description: `Delete a routine by its id from ${LIST_TOOL}. Its past runs stay in the sidebar. The person may be asked first, depending on the chat's approval mode.`,
          inputSchema: { type: "object", properties: { id: { type: "string", description: `The routine's id from ${LIST_TOOL}.` } }, required: ["id"], additionalProperties: false },
          annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        },
        trusted: true,
        call: (args, context) => remove(args, context),
      },
    ],
  };
}

function chatOf(context: McpContext): string {
  if (!context.sessionId) throw new Error("This chat is still opening. Try again in a moment.");
  return context.sessionId;
}

function missing(id: string): ToolResult {
  return toolText(`No routine has the id ${id || "(none)"}. Read the ids with ${LIST_TOOL}.`, true);
}

// The person approved the routine as the card showed it. One changed meanwhile, on the page or by another chat, is left alone.
function changedMeanwhile(edits: RoutineEdits, shown: Routine): ToolResult | null {
  if (JSON.stringify(edits.get(shown.id)) === JSON.stringify(shown)) return null;
  return toolText(`The routine ${shown.name} changed while the person was asked, so nothing was done. Read it again with ${LIST_TOOL} and try again.`, true);
}

// One line per field the change sets to a new value. A new prompt shows whole in the card below.
function changesOf(current: Routine, next: Routine): string[] {
  const text = (routine: Routine, key: (typeof FIELDS)[number]) => (key === "schedule" ? describeSchedule(routine.schedule) : String(routine[key]) || "default");
  const changed = FIELDS.filter((key) => JSON.stringify(current[key]) !== JSON.stringify(next[key]));
  if (!changed.length) return ["No field changes."];
  return changed.map((key) => (key === "prompt" ? "prompt: the new one is below" : `${key}: ${text(current, key)} → ${text(next, key)}`));
}

function idIn(args: unknown): string {
  return isRecord(args) && typeof args.id === "string" ? args.id.trim() : "";
}

// Only the routine's own fields, so an agent cannot reach the page's other options.
function fieldsIn(args: unknown): Record<string, unknown> {
  const input = isRecord(args) ? args : {};
  return Object.fromEntries(FIELDS.filter((key) => input[key] !== undefined).map((key) => [key, input[key]]));
}
