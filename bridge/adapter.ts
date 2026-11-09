// What the ACP adapters on stdio share: Claude's claude-agent-acp and ChatGPT's codex-acp. Each runs
// its harness's own binary under it, and both speak the same extensions beside standard ACP: the
// account's sign-in state (_auth/status_update), notices, and JetBrains AIR's background tasks
// (async_task_*, stopped with _session/async_task/stop) and native subagent sessions (subagent_*), for a
// provider that asks for them. One adapter process holds every session of its provider. If it exits,
// the running turn ends with the error, a new adapter starts, and the open sessions come back with
// session/load.
//
// Login stays in the harness. A provider on this client never reads, stores or passes a token.

import { createRequire } from "node:module";
import path from "node:path";
import { z } from "zod";
import { AcpClient, messageOf } from "./acp.ts";
import { fields, listOf, maybe } from "./lenient.ts";
import type { BackgroundTask, Translated } from "./protocol.ts";
import type { ReducerEvent } from "./reducer.ts";
import type { RpcNotification } from "./rpc.ts";
import type { StdioAgent } from "./stdio.ts";

const AuthStatus = fields({
  authStatus: maybe(fields({ kind: maybe(z.string()), label: maybe(z.string()) })),
});

// A notice update: a line from the adapter, not from the model.
const Notice = fields({
  sessionId: maybe(z.string()),
  update: fields({ sessionUpdate: maybe(z.string()), title: maybe(z.string()), description: maybe(z.string()) }),
});

// Background work: shell commands and agents that outlive the turn.
const AsyncTask = fields({
  sessionId: maybe(z.string()),
  update: fields({
    sessionUpdate: maybe(z.string()),
    asyncTaskId: maybe(z.string()),
    name: maybe(z.string()),
    taskType: maybe(z.string()),
    description: maybe(z.string()),
    state: maybe(z.string()),
    summary: maybe(z.string()),
    toolCallId: maybe(z.string()),
    canStop: maybe(z.boolean()),
  }),
});

// The predicted next prompt, after a turn.
const Suggestion = fields({
  sessionId: maybe(z.string()),
  update: fields({
    sessionUpdate: maybe(z.string()),
    _meta: maybe(fields({ promptSuggestions: maybe(fields({ suggestions: maybe(listOf(fields({ text: maybe(z.string()) }))) })) })),
  }),
});

const ENDED = new Set(["completed", "failed"]);

// A subagent that runs in a session of its own, reported to the session that started it.
const Subagent = fields({
  sessionId: maybe(z.string()),
  update: fields({
    sessionUpdate: maybe(z.string()),
    subagentSessionId: maybe(z.string()),
    name: maybe(z.string()),
    task: maybe(z.string()),
    state: maybe(z.string()),
  }),
});

export abstract class AdapterClient extends AcpClient {
  protected agent: StdioAgent | null = null;
  // null until the adapter or the harness has said.
  protected signedIn: boolean | null = null;
  // The account as the adapter names it ("ChatGPT Plus"), while signed in.
  protected accountLabel = "";
  // The kind and label of the adapter's last sign-in report.
  private account: string | null = null;
  // Background tasks per session, in the order the harness started them.
  private tasks = new Map<string, Map<string, BackgroundTask>>();
  // When each session last heard from its harness. Claude thinks for a while before the first lines of its
  // summary arrive, and Codex sends a step's heading only once the step is done, so a thought is timed
  // from here, not from its first chunk.
  private quietSince = new Map<string, number>();
  // Each subagent's own session, and the open session whose chat shows it.
  private subagents = new Map<string, string>();

  agentPid() {
    return this.agent?.pid ?? null;
  }

  protected override async shutdown() {
    await this.agent?.stop();
  }

  protected override agentIdentity() {
    return this.agent;
  }

  // The adapters report a background shell command through its whole run (async_task_*) only to a client
  // that says it shows them. Their extension for that is JetBrains AIR's. With recommendedValue the
  // adapters report the effort level a session runs on in place of "Default".
  protected override initializeParams() {
    const params = super.initializeParams();
    return {
      ...params,
      clientCapabilities: {
        ...params.clientCapabilities,
        // Notices come as notice updates, not as assistant text that would look like a new turn.
        session: { notices: {} },
        _meta: { jetbrains: { air: { version: 1, capabilities: ["asyncTasks", "recommendedValue"] } } },
      },
    };
  }

  protected override shownIn(sessionId: string | null) {
    return (sessionId && this.subagents.get(sessionId)) || sessionId;
  }

  protected override translate(message: unknown): Translated | null {
    const translated = this.fromSubagent(super.translate(message));
    const sessionId = translated?.sessionId;
    if (translated && sessionId && this.sessionMap.has(sessionId)) {
      const event = translated.event;
      const tail = this.sessionMap.get(sessionId)?.transcript.at(-1);
      const startsThought = event.type === "chunk" && event.role === "thought" && !(tail?.type === "thought" && tail.streaming);
      if (startsThought && event.at === undefined) event.at = this.quietSince.get(sessionId) ?? Date.now();
      this.quietSince.set(sessionId, Date.now());
    }
    return translated;
  }

  protected override onTurnStart(sessionId: string) {
    this.quietSince.set(sessionId, Date.now());
  }

  protected override handleNotification(message: RpcNotification) {
    if (message.method === "_auth/status_update") {
      const status = AuthStatus.parse(message.params).authStatus;
      if (status?.kind) {
        const account = `${status.kind}\0${status.label ?? ""}`;
        const changed = this.account !== null && this.account !== account;
        this.account = account;
        this.signedIn = status.kind !== "none";
        this.accountLabel = this.signedIn ? (status.label ?? "") : "";
        if (changed) this.authChanged();
      }
      return true;
    }
    if (message.method === "session/update") {
      if (this.noteNotice(message)) return true;
      if (this.noteAsyncTask(message)) return true;
      if (this.noteSubagent(message)) return true;
      if (this.noteSuggestion(message.params)) return true;
    }
    return false;
  }

  // A notice from the adapter ("Task stopped by user") shows as a line in the chat, the way the adapter
  // would have written it, without starting a turn.
  private noteNotice(message: RpcNotification) {
    const { sessionId: from, update } = Notice.parse(message.params);
    const sessionId = this.shownIn(from ?? null);
    if (update.sessionUpdate !== "notice") return false;
    if (!sessionId || !this.sessionMap.has(sessionId) || !update.title) return true;
    const text = update.description ? `**${update.title}:** ${update.description}` : `**${update.title}**`;
    this.apply(sessionId, { type: "notice", text });
    return true;
  }

  // async_task_* updates become the session's background tasks, which the task row shows while they run.
  private noteAsyncTask(message: RpcNotification) {
    const { sessionId: from, update } = AsyncTask.parse(message.params);
    const sessionId = this.shownIn(from ?? null);
    const kind = update.sessionUpdate;
    if (kind !== "async_task_spawned" && kind !== "async_task_progress" && kind !== "async_task_state_update") return false;
    if (!sessionId || !update.asyncTaskId || !this.sessionMap.has(sessionId)) return true;
    const list = this.tasks.get(sessionId) ?? new Map<string, BackgroundTask>();
    const known = list.get(update.asyncTaskId);
    const label = update.description || update.name || known?.label || "Background task";
    const toolCallId = update.toolCallId || known?.toolCallId;
    const canStop = update.canStop ?? known?.canStop;
    const task: BackgroundTask = {
      id: update.asyncTaskId,
      kind: update.taskType || known?.kind || "",
      status: update.state || known?.status || "running",
      label: label.length > 88 ? `${label.slice(0, 87)}…` : label,
      ...(toolCallId ? { toolCallId } : {}),
      ...(canStop === false ? { canStop } : {}),
    };
    list.set(update.asyncTaskId, task);
    this.tasks.set(sessionId, list);
    this.apply(sessionId, { type: "background-tasks", tasks: [...list.values()] });
    if (ENDED.has(task.status) && !ENDED.has(known?.status ?? "")) this.taskEnded(sessionId, task, update.summary ?? "");
    return true;
  }

  // A subagent in a session of its own becomes a subagent row in the chat that shows its parent, with its
  // session id as the row's tool call id.
  private noteSubagent(message: RpcNotification) {
    const { sessionId, update } = Subagent.parse(message.params);
    const kind = update.sessionUpdate;
    if (kind !== "subagent_spawned" && kind !== "subagent_state_update") return false;
    const chat = this.shownIn(sessionId ?? null);
    const id = update.subagentSessionId;
    if (!sessionId || !chat || !id || !this.sessionMap.has(chat)) return true;
    this.subagents.set(id, chat);
    const event: ReducerEvent =
      kind === "subagent_spawned"
        ? { type: "tool", toolCallId: id, kind: "task", status: "in_progress", title: firstLine(update.task) || update.name || "Subagent", rawInput: { description: update.task, subagent_type: update.name } }
        : { type: "tool", toolCallId: id, status: update.state === "completed" || update.state === "cancelled" ? update.state : "failed" };
    // A subagent of a subagent folds under the outer one.
    if (sessionId !== chat) event.parentId = sessionId;
    this.apply(chat, event);
    return true;
  }

  // A subagent's steps show in its parent's chat, folded under its row. The rest of its session (its replies,
  // its model, its title) stays out of that chat.
  private fromSubagent(translated: Translated | null): Translated | null {
    const from = translated?.sessionId;
    const chat = from ? this.subagents.get(from) : undefined;
    if (!translated || !from || !chat) return translated;
    if (translated.event.type !== "tool") return null;
    return { sessionId: chat, event: { ...translated.event, parentId: translated.event.parentId ?? from } };
  }

  // An empty list clears the suggestion, which the start of a turn has already done.
  private noteSuggestion(params: unknown) {
    const { sessionId, update } = Suggestion.parse(params);
    if (update.sessionUpdate !== "session_info_update" || !update._meta?.promptSuggestions) return false;
    const suggestion = update._meta.promptSuggestions.suggestions?.[0]?.text;
    if (!sessionId || !suggestion || !this.sessionMap.has(sessionId)) return true;
    // The suggestion comes after the turn's result. One tick later the app has ended that turn.
    // A turn running then is a newer one, so the suggestion is stale.
    setTimeout(() => {
      if (this.sessionMap.get(sessionId)?.status === "idle") this.apply(sessionId, { type: "suggestion", text: suggestion });
    }, 0);
    return true;
  }

  // The adapter reported another account, or a sign-in or sign-out, after its first report.
  protected authChanged() {}

  // A background task completed or failed. summary is the harness's line about it, when it sent one.
  // Stopped is left out: the adapter can report a task that is finishing as stopped just before its real end state.
  protected taskEnded(_sessionId: string, _task: BackgroundTask, _summary: string) {}

  // A background command outlives the turn, so cancel does not reach it. The adapter stops one by its id.
  async stopTask(sessionId: string, taskId: string) {
    this.require(sessionId);
    await this.rpc.request("_session/async_task/stop", { sessionId, asyncTaskId: taskId }, 30000);
  }

  // A turn the harness started by itself has no prompt of this app's to end it. Cancelling it ends it here,
  // since the harness may never send what would.
  override cancel(sessionId: string) {
    super.cancel(sessionId);
    const session = this.sessionMap.get(sessionId);
    if (session?.status === "running" && !this.ownsTurn(sessionId)) this.apply(sessionId, { type: "turn-finished", stopReason: "cancelled" });
  }

  override async forgetSession(sessionId: string) {
    this.tasks.delete(sessionId);
    this.quietSince.delete(sessionId);
    for (const [subagent, chat] of this.subagents) if (chat === sessionId) this.subagents.delete(subagent);
    await super.forgetSession(sessionId);
  }

  // The adapter's exit, with the end of its stderr.
  protected stoppedMessage(name: string) {
    return `${name} stopped${stderrTail(this.agent?.stderrTail() ?? "")}`;
  }

  protected adapterError(name: string, error: unknown) {
    const text = messageOf(error);
    if (text === "connection closed") return `${this.stoppedMessage(name)}. It is starting again.`;
    return text;
  }
}

function firstLine(text: string | undefined) {
  const line = text?.trim().split("\n")[0]?.trim() ?? "";
  return line.length > 88 ? `${line.slice(0, 87)}…` : line;
}

// An adapter's entry script inside node_modules, run with node. null when the package is missing.
export function adapterEntry(pkg: string): string | null {
  try {
    const require = createRequire(import.meta.url);
    const manifest = require.resolve(`${pkg}/package.json`);
    return path.join(path.dirname(manifest), "dist", "index.js");
  } catch {
    return null;
  }
}

// The last lines an adapter wrote to stderr, for an error message, without the lines that match skip.
export function stderrTail(stderr: string, skip?: RegExp) {
  const last = stderr
    .split("\n")
    .filter((line) => line.trim() && !skip?.test(line.trim()))
    .slice(-2)
    .join(" ")
    .trim();
  return last ? `: ${last.slice(0, 300)}` : "";
}

let shellEnvironment: NodeJS.ProcessEnv = {};

export function setShellEnvironment(env: NodeJS.ProcessEnv) {
  shellEnvironment = env;
}

export function adapterEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const own = Object.entries(process.env).filter(([key]) => key === "PATH" || key === "HOME" || key.startsWith("X_BENCH_"));
  return { ...process.env, ...shellEnvironment, ...Object.fromEntries(own), ...extra };
}
