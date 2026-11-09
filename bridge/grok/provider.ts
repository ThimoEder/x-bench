// The Grok provider: the shared ACP client, plus how to start `grok agent serve`,
// Grok's own extensions (_x.ai/*): steer, its prompt queue, side questions, next-line
// suggestions, billing, questions, plan approval and stopping background tasks, and its
// files under ~/.grok: session folders, update logs and the roster of open sessions.

import os from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { commandOutput, commandVersion } from "../command.ts";
import { AcpClient, type AcpOptions } from "../acp.ts";
import type { RpcId, RpcNotification, RpcRequest, Transport } from "../rpc.ts";
import { cleanSuggestion, emptySession, type PendingElicitation, type SessionState, type UserItem } from "../reducer.ts";
import type { ConfigOption, Image, Translated } from "../protocol.ts";
import type {
  AccountUsage,
  Capabilities,
  Detected,
  Mode,
  ModeChoice,
  ModelCatalog,
  NewSession,
  Provider,
  SessionToolGrant,
  SideAnswer,
  SideEntry,
} from "../provider.ts";
import { AgentProcess, openWebSocket } from "./runtime.ts";
import { ExitPlanParams, SettingsParams, SuggestResult, grokEventFromNotification, rpcBody } from "./protocol.ts";
import { readPromptSuggestions } from "./promptSuggestions.ts";
import { AskParams, grokQuestionForm, grokQuestionReply, type GrokQuestion } from "./questions.ts";
import { readComposerCatalog } from "./models.ts";
import { presentUsage } from "./usage.ts";
import { activeSessionFiles, liveActiveSessionIds, registerActiveSession, unregisterActivePid, unregisterActiveSession, type ActiveSessionFiles } from "./active.ts";
import { forgetSessionUpdates, readSessionUpdates } from "./follow.ts";
import { readPlan } from "./plan.ts";
import { deleteSessionHistory, moveSessionDir } from "./sessionFiles.ts";
import { openTurnIds } from "./turns.ts";
import { imagesFromUpdates, readSessionUpdateLog } from "./updateLog.ts";
import { canonicalCwd } from "../home.ts";
import { grokFacts } from "./tools.ts";
import type { ToolCall, ToolFacts } from "../tools.ts";
import { fields, isRecord, maybe } from "../lenient.ts";
import { z } from "zod";

const SUGGEST_TIMEOUT_MS = 20000;
const PREVIEW_SLICE_MS = 8;

// One line of a session's update log, down to its update kind.
const LoggedUpdate = fields({
  params: fields({ update: fields({ sessionUpdate: z.unknown().optional() }) }),
});

// The body of Grok's _x.ai/btw reply.
const BtwReply = fields({
  btwSessionId: maybe(z.string()),
  answer: maybe(z.string()),
});

export interface GrokOptions extends AcpOptions {
  // Tests start a stand-in grok with command and pass a fake socket here.
  openSocket?: (url: string) => Promise<Transport>;
  url?: string;
  secret?: string;
  port?: number;
  permissionMode?: string;
  command?: string;
  btwTimeoutMs?: number;
  promptSuggestions?: boolean;
  configFile?: string;
  modelsFile?: string;
  // Called with Grok's pid and running true each time the provider spawns it,
  // also when it starts Grok again after an exit, and with running false once
  // that Grok has exited.
  onAgentProcess?: (pid: number, running: boolean) => void;
  // Grok's folder, ~/.grok unless set.
  home?: string;
  // Grok keeps each session's side questions on disk. The host reads them.
  readSideHistory?: (sessionId: string, cwd: string) => SideEntry[];
  clearSideHistory?: (sessionId: string, cwd: string) => void;
}

// Grok's approval modes. "agent" never asks.
const GROK_MODES: readonly ModeChoice[] = [
  { id: "full", name: "Always approve" },
  { id: "acceptEdits", name: "Accept edits" },
  { id: "plan", name: "Plan" },
];

export class GrokProvider extends AcpClient implements Provider {
  readonly id = "grok";
  readonly label = "Grok";
  readonly capabilities: Capabilities = {
    loadSession: true,
    steer: true,
    deliverNext: false,
    steerAttachments: false,
  };
  readonly startsWithPage = true;
  readonly modes = GROK_MODES;
  readonly defaultMode: Mode = "full";
  declare options: GrokOptions;
  url: string | null;
  port: number | null;
  secret: string | null;

  constructor(options: GrokOptions = {}) {
    super(options);
    this.url = null;
    this.port = null;
    this.secret = null;
    this.agent = null;
    this.onProcessExit = null;
    this.suggestionsBlocked = false;
    this.suggestionGen = new Map();
    this.asked = new Map();
    this.owned = new Map();
    const home = options.home ?? path.join(os.homedir(), ".grok");
    this.sessionRoot = path.join(home, "sessions");
    this.roster = activeSessionFiles(home);
  }

  private agent: AgentProcess | null;
  private onProcessExit: (() => void) | null;
  private suggestionsBlocked: boolean;
  private suggestionGen: Map<string, number>;
  // The questions behind each session's waiting ask_user_question, to build Grok's answer from the card's form.
  private asked: Map<string, { rpcId: RpcId; questions: GrokQuestion[] }>;
  // The sessions this provider put on Grok's roster, with the pid they are filed under.
  private owned: Map<string, number>;
  private sessionRoot: string;
  private roster: ActiveSessionFiles;

  async detect(): Promise<Detected> {
    const command = this.options.command ?? "grok";
    const version = await commandVersion(command);
    if (version === null) return { installed: false, version, signedIn: null, message: "Grok is not installed. Install the grok CLI to use Grok models.", command: "curl -fsSL https://x.ai/cli/install.sh | bash" };
    const signedIn = grokSignedIn(await commandOutput(command, ["models"], { GROK_DISABLE_AUTOUPDATER: "1" }));
    return {
      installed: true,
      version,
      signedIn,
      message: signedIn === false ? "Grok is not signed in. Sign in with grok login in a terminal, then try again." : null,
      command: signedIn === false ? "grok login" : null,
    };
  }

  models(): ModelCatalog {
    return readComposerCatalog(this.options.modelsFile, this.options.configFile);
  }

  agentPid() {
    return this.agent?.proc.pid || null;
  }

  // ---- Reaching Grok ----

  protected override async prepare() {
    if (this.options.connect) {
      this.url = this.options.url ?? "ws://bridge.test/ws";
      this.secret = this.options.secret ?? "test";
      this.port = this.options.port ?? 0;
      return;
    }
    // A Grok left from a run that gave up may still be alive but unreachable.
    await this.agent?.stop();
    await this.spawnAgent();
    if (!this.onProcessExit) {
      this.onProcessExit = () => {
        if (!this.agent?.proc.pid || this.agent.exited) return;
        try {
          process.kill(-this.agent.proc.pid, "SIGTERM");
        } catch {
          /* already gone */
        }
      };
      process.on("exit", this.onProcessExit);
    }
  }

  // Spawn here rather than on exit, so the loop's backoff and retry limit also cover a Grok that keeps crashing.
  protected override async connectTransport() {
    if (this.options.connect) return this.options.connect();
    if (!this.agent || this.agent.exited) await this.spawnAgent();
    const openSocket = this.options.openSocket ?? openWebSocket;
    return openSocket(this.url ?? "");
  }

  protected override async shutdown() {
    if (this.onProcessExit) process.removeListener("exit", this.onProcessExit);
    this.onProcessExit = null;
    this.releaseAll();
    await this.agent?.stop();
  }

  protected override agentIdentity() {
    return this.agent;
  }

  private async spawnAgent() {
    const agent = await AgentProcess.start({
      permissionMode: this.options.permissionMode ?? "bypassPermissions",
      command: this.options.command ?? "grok",
      onProcess: this.options.onAgentProcess,
    });
    if (this.stopped) {
      await agent.stop();
      throw new Error("Grok was stopped while it started");
    }
    this.agent = agent;
    this.url = agent.url;
    this.secret = agent.secret;
    this.port = agent.port;
    agent.proc.on("exit", () => {
      if (this.agent !== agent || this.stopped) return;
      this.lastError = new Error(`grok exited: ${agent.stderrTail()}`);
      this.transport?.close();
    });
  }

  // ---- Grok's names for modes and config ----

  protected override modeToAgent(mode: Mode) {
    return mode === "full" ? "agent" : mode;
  }

  protected override modeFromAgent(modeId: string | null): Mode | null {
    if (modeId === "agent") return "full";
    if (modeId === "acceptEdits" || modeId === "plan") return modeId;
    if (modeId === "default") return "ask";
    return null;
  }

  protected override configFromAgent(options: ConfigOption[]) {
    return options.map((option) => (option.id === "reasoning_effort" ? { ...option, id: "effort" } : option));
  }

  protected override configToAgent(key: string) {
    return key === "effort" ? "reasoning_effort" : key;
  }

  // Grok keeps the rules with the session, so the host tools' line goes in once, at session/new.
  protected override newSessionParams(options: NewSession, tools?: SessionToolGrant) {
    const rules = this.withToolLine(options.rules, tools);
    return rules ? { _meta: { rules } } : {};
  }

  // ---- Grok's extensions ----

  protected override translate(message: unknown): Translated | null {
    return grokEventFromNotification(message);
  }

  protected override toolFacts(tool: ToolCall): ToolFacts {
    return grokFacts(tool);
  }

  protected override handleNotification(message: RpcNotification) {
    if (message.method !== "_x.ai/settings/update") return false;
    this.noteSuggestions(SettingsParams.parse(message.params).prompt_suggestions_enabled);
    return true;
  }

  protected override handleRequest(message: RpcRequest) {
    if (message.method === "_x.ai/ask_user_question" || message.method === "x.ai/ask_user_question") {
      this.onAskUserQuestion(message);
      return true;
    }
    if (message.method !== "_x.ai/exit_plan_mode" && message.method !== "x.ai/exit_plan_mode") return false;
    const params = ExitPlanParams.parse(message.params);
    const sessionId = params.sessionId;
    const session = sessionId ? this.sessionMap.get(sessionId) : undefined;
    if (sessionId && session && !session.pendingPlan) {
      const given = typeof params.planContent === "string" ? params.planContent : "";
      // Grok can leave the plan out of the request when it wrote it to the session's plan.md.
      const plan = given.trim() ? given : readPlan(session.cwd, sessionId, this.sessionRoot).text;
      this.apply(sessionId, {
        type: "plan-approval",
        rpcId: message.id,
        toolCallId: params.toolCallId ?? null,
        plan,
      });
      return true;
    }
    this.rpc.respond(message.id, { outcome: "cancelled" });
    return true;
  }

  private onAskUserQuestion(message: RpcRequest) {
    const params = AskParams.parse(message.params);
    const sessionId = params.sessionId;
    const session = sessionId ? this.sessionMap.get(sessionId) : undefined;
    const questions = params.questions ?? [];
    if (!sessionId || !session || session.pendingElicitation || !questions.length) {
      this.rpc.respond(message.id, { outcome: "cancelled" });
      return;
    }
    this.asked.set(sessionId, { rpcId: message.id, questions });
    this.apply(sessionId, {
      type: "elicitation",
      rpcId: message.id,
      ...grokQuestionForm(questions, params.mode),
    });
  }

  protected override questionReply(sessionId: string, pending: PendingElicitation, action: string, content?: unknown) {
    const asked = this.asked.get(sessionId);
    if (!asked || asked.rpcId !== pending.rpcId) return super.questionReply(sessionId, pending, action, content);
    this.asked.delete(sessionId);
    return grokQuestionReply(asked.questions, pending.fields, action, content);
  }

  async steer(sessionId: string, text: string) {
    this.require(sessionId);
    return rpcBody(await this.rpc.request("_x.ai/interject", { sessionId, text }));
  }

  // A side question. Grok answers from the session and does not append the exchange.
  async sideQuestion(sessionId: string, question: string): Promise<SideAnswer> {
    this.require(sessionId);
    const text = String(question ?? "").trim();
    if (!text) throw new Error("Ask a question first");
    const result = await this.rpc.request("_x.ai/btw", { sessionId, question: text }, this.options.btwTimeoutMs ?? 120000);
    const reply = BtwReply.parse(rpcBody(result));
    return { id: reply.btwSessionId ?? null, answer: reply.answer ?? "" };
  }

  sideHistory(sessionId: string) {
    const session = this.sessionMap.get(sessionId);
    if (!session) return [];
    return this.options.readSideHistory?.(sessionId, session.cwd) ?? [];
  }

  clearSideHistory(sessionId: string) {
    const session = this.sessionMap.get(sessionId);
    if (session) this.options.clearSideHistory?.(sessionId, session.cwd);
  }

  // Grok queues a second session/prompt itself and reports the queue on _x.ai/queue/changed.
  override editQueued(sessionId: string, id: string, text: string, version: number) {
    this.require(sessionId);
    this.rpc.notify("_x.ai/queue/edit", { sessionId, id, newText: text, version });
  }

  override removeQueued(sessionId: string, id: string, version: number) {
    this.require(sessionId);
    this.rpc.notify("_x.ai/queue/remove", { sessionId, id, version });
  }

  override async sendQueuedNow(sessionId: string, id: string) {
    const session = this.require(sessionId);
    const queue = session.queue;
    if (!queue.some((entry) => entry.id === id)) throw new Error("queued message is gone");
    if (queue[0]?.id !== id) {
      const orderedIds = [id, ...queue.filter((entry) => entry.id !== id).map((entry) => entry.id)];
      this.rpc.notify("_x.ai/queue/reorder", { sessionId, orderedIds });
      const started = Date.now();
      while (Date.now() - started < 1500) {
        if (this.sessionMap.get(sessionId)?.queue[0]?.id === id) break;
        await new Promise((resolve) => {
          setTimeout(resolve, 30);
        });
      }
      if (this.sessionMap.get(sessionId)?.queue[0]?.id !== id) throw new Error("couldn't send that queued message");
    }
    this.cancel(sessionId);
  }

  override async createSession(options: NewSession) {
    const session = await super.createSession(options);
    this.own(session.id);
    return session;
  }

  // session/load leaves out the pictures and the background tasks the update log keeps.
  override async loadSession(sessionId: string, cwd: string, options: { rules?: string } = {}) {
    const session = await super.loadSession(sessionId, cwd, options);
    if (!session) return session;
    // A session already loaded skips afterReload, so one that missed the roster gets another try here.
    this.own(sessionId);
    await this.restoreFromLog(sessionId);
    return this.sessionMap.get(sessionId);
  }

  protected override async afterReload(sessionId: string) {
    this.own(sessionId);
  }

  override async forgetSession(sessionId: string) {
    this.suggestionGen.delete(sessionId);
    await super.forgetSession(sessionId);
    // Cleared after super, whose cancel of a waiting question reads it to reply in Grok's shape.
    this.asked.delete(sessionId);
    this.release(sessionId);
  }

  // Grok's copy goes once the session is closed and off the roster.
  async deleteSession(sessionId: string) {
    await this.forgetSession(sessionId);
    await deleteSessionHistory(sessionId, this.sessionRoot);
  }

  moveSession(sessionId: string, cwd: string) {
    moveSessionDir(sessionId, cwd, this.sessionRoot);
  }

  // A background command outlives the turn, so cancel does not reach it. Grok stops one by its task id.
  async stopTask(sessionId: string, taskId: string) {
    this.require(sessionId);
    await this.rpc.request("_x.ai/task/kill", { sessionId, taskId }, 30000);
  }

  answerPlan(sessionId: string, outcome: string) {
    const pending = this.require(sessionId).pendingPlan;
    if (!pending) throw new Error("no plan is waiting");
    if (!["approved", "cancelled", "abandoned"].includes(outcome)) {
      throw new Error(`unknown plan outcome: ${outcome}`);
    }
    this.rpc.respond(pending.rpcId, { outcome });
    this.apply(sessionId, { type: "plan-cleared" });
  }

  async billing() {
    this.assertReady();
    return rpcBody(await this.rpc.request("_x.ai/billing", {}));
  }

  async accountUsage(): Promise<AccountUsage | null | undefined> {
    if (this.status === "connecting" || this.status === "reconnecting") return undefined;
    if (this.status !== "ready") return null;
    return presentUsage(await this.billing());
  }

  // ---- Grok's roster of open sessions ----
  // Opened chats stay on ~/.grok/active_sessions.json until they close, so the builder can open that same
  // session and end it. A restarted Grok files the chats it reloaded again under its new pid.

  private own(sessionId: string) {
    const pid = this.agentPid();
    const session = this.sessionMap.get(sessionId);
    if (!pid || !session || this.owned.get(sessionId) === pid) return;
    try {
      const next = registerActiveSession({ sessionId, pid, cwd: canonicalCwd(session.cwd) }, this.roster);
      if (next.some((entry) => isRecord(entry) && entry.session_id === sessionId && entry.pid === pid)) this.owned.set(sessionId, pid);
    } catch {
      // The chat still opens if the roster is busy.
    }
  }

  private release(sessionId: string) {
    const pid = this.owned.get(sessionId) || this.agentPid();
    if (!pid) return;
    try {
      unregisterActiveSession(sessionId, pid, this.roster);
      this.owned.delete(sessionId);
    } catch {
      // Shutdown still drops every row owned by this agent.
    }
  }

  private releaseAll() {
    const pid = this.agentPid();
    if (!pid) return;
    try {
      unregisterActivePid(pid, this.roster);
      this.owned.clear();
    } catch {
      // Shutdown still stops the agent.
    }
  }

  // ---- Grok's update logs ----
  // Grok keeps each session's updates on disk. They fill what session/load leaves out, show a stored
  // chat, and follow a turn another grok process runs.

  // A turn stays open until events.jsonl records its end, while the process on the roster that runs it is alive.
  openTurns() {
    return openTurnIds(this.sessionRoot, liveActiveSessionIds(this.roster));
  }

  followTurn(sessionId: string, open: boolean) {
    if (!open || !this.sessionMap.has(sessionId) || this.ownsTurn(sessionId)) {
      forgetSessionUpdates(sessionId);
      return false;
    }
    const pulled = readSessionUpdates(this.sessionRoot, sessionId);
    if (!pulled.messages.length) return false;
    if (pulled.reset) this.replaySessionLog(sessionId, pulled.messages);
    else this.ingestSessionLog(sessionId, pulled.messages);
    return true;
  }

  private async restoreFromLog(sessionId: string) {
    try {
      const messages = await readSessionUpdateLog(this.sessionRoot, sessionId);
      const images = imagesFromUpdates(messages);
      this.fillToolImages(sessionId, images.byTool);
      this.fillUserImages(sessionId, images.byPrompt);
      const tasks = messages.findLast((message) => LoggedUpdate.parse(message).params.update.sessionUpdate === "background_tasks");
      if (tasks) this.ingestSessionLog(sessionId, [tasks]);
    } catch {
      // The opened transcript still shows if the session log cannot be read.
    }
  }

  // Session replay can omit image bytes. Put screenshots from the update log back on the matching tool rows.
  fillToolImages(sessionId: string, byTool: Map<string, Image[]> | null | undefined) {
    const session = this.sessionMap.get(sessionId);
    if (!session || !byTool?.size) return session ?? null;
    for (const item of session.transcript) {
      if (item.type !== "tool" || !item.toolCallId || item.images?.length) continue;
      const images = byTool.get(item.toolCallId);
      if (!images?.length) continue;
      this.apply(sessionId, { type: "tool", toolCallId: item.toolCallId, status: item.status, images });
    }
    return this.sessionMap.get(sessionId) ?? null;
  }

  // Session replay can omit the bytes of a picture the person sent. Put them back on that prompt.
  fillUserImages(sessionId: string, byPrompt: Map<number, Image[]> | null | undefined) {
    const session = this.sessionMap.get(sessionId);
    if (!session || !byPrompt?.size) return session ?? null;
    for (const [promptIndex, images] of byPrompt) {
      const current = this.sessionMap.get(sessionId);
      const item = current?.transcript.find((entry): entry is UserItem => entry.type === "user" && entry.promptIndex === promptIndex);
      if (!item || !images.length) continue;
      const have = new Set((item.images || []).map((image) => image.data));
      const missing = images.filter((image) => image.data && !have.has(image.data));
      if (!missing.length) continue;
      this.apply(sessionId, { type: "user-images", promptIndex, images: missing });
    }
    return this.sessionMap.get(sessionId) ?? null;
  }

  // Rebuild a chat from the on-disk update log when the live turn belongs to another process.
  replaySessionLog(sessionId: string, messages: unknown[]) {
    const current = this.sessionMap.get(sessionId);
    if (!current) return null;
    this.fromLog = true;
    try {
      this.apply(sessionId, { type: "reset", cwd: current.cwd });
      if (current.configOptions.length || current.modelId) {
        this.apply(sessionId, {
          type: "config",
          configOptions: current.configOptions,
          modelId: current.modelId,
        });
      }
      this.ingest(sessionId, messages);
      const next = this.sessionMap.get(sessionId);
      if (next) this.emit(next);
      return next;
    } finally {
      this.fromLog = false;
    }
  }

  // A chat whose folder is gone, built from its update log alone: grok loads a session only in its own folder.
  async showStoredSession(sessionId: string, cwd: string) {
    const messages = await readSessionUpdateLog(this.sessionRoot, sessionId);
    if (!this.sessionMap.has(sessionId)) this.sessionMap.set(sessionId, emptySession({ id: sessionId, cwd }));
    this.replaySessionLog(sessionId, messages);
    // A log cut off mid-turn would leave the stored chat running with no turn behind it.
    if (this.sessionMap.get(sessionId)?.status === "running" && !this.ownsTurn(sessionId)) this.apply(sessionId, { type: "turn-finished", stopReason: "cancelled" });
    return this.sessionMap.get(sessionId) ?? null;
  }

  // A stored chat built from its update log, to show while session/load runs. Grok's own copy stays as it is.
  // It yields to the event loop every few milliseconds, so a long log does not stall a reply streaming meanwhile.
  async previewStoredSession(sessionId: string, cwd: string): Promise<SessionState | null> {
    const messages = await readSessionUpdateLog(this.sessionRoot, sessionId);
    if (!messages.length) return null;
    let session = emptySession({ id: sessionId, cwd });
    let slice = performance.now();
    for (const message of messages) {
      if (performance.now() - slice > PREVIEW_SLICE_MS) {
        await nextTurn();
        slice = performance.now();
      }
      let translated;
      try {
        translated = this.readNotification(message);
      } catch {
        continue;
      }
      if (!translated?.event || translated.event.type === "catalog") continue;
      if (translated.sessionId && translated.sessionId !== sessionId) continue;
      session = this.reduce(session, this.inAppNames(translated.event));
    }
    return session.status === "running" ? this.reduce(session, { type: "turn-finished", stopReason: "cancelled" }) : session;
  }

  ingestSessionLog(sessionId: string, messages: unknown[] | null | undefined) {
    if (!this.sessionMap.has(sessionId) || !messages?.length) return this.sessionMap.get(sessionId) ?? null;
    this.fromLog = true;
    try {
      this.ingest(sessionId, messages);
      const next = this.sessionMap.get(sessionId);
      if (next) this.emit(next);
      return next;
    } finally {
      this.fromLog = false;
    }
  }

  private ingest(sessionId: string, messages: unknown[] | null | undefined) {
    for (const message of messages ?? []) {
      let translated;
      try {
        translated = this.readNotification(message);
      } catch {
        continue;
      }
      if (!translated?.event) continue;
      const { event } = translated;
      if (event.type === "catalog") continue;
      if (translated.sessionId && translated.sessionId !== sessionId) continue;
      this.apply(sessionId, this.inAppNames(event));
    }
  }

  // ---- Next-line suggestions ----

  protected override onTurnStart(sessionId: string) {
    this.nextSuggestionGen(sessionId);
  }

  protected override afterIdle(sessionId: string) {
    this.refreshSuggestion(sessionId);
  }

  private noteSuggestions(enabled: unknown) {
    if (enabled !== true && enabled !== false) return;
    this.suggestionsBlocked = enabled === false;
    if (enabled) return;
    for (const id of this.sessionMap.keys()) {
      this.nextSuggestionGen(id);
      if (this.sessionMap.get(id)?.suggestion) this.apply(id, { type: "suggestion", text: null });
    }
  }

  private suggestionsAllowed() {
    if (this.suggestionsBlocked || this.options.promptSuggestions === false) return false;
    if (this.options.promptSuggestions === true) return true;
    return readPromptSuggestions(this.options.configFile);
  }

  private nextSuggestionGen(sessionId: string) {
    const next = (this.suggestionGen.get(sessionId) ?? 0) + 1;
    this.suggestionGen.set(sessionId, next);
    return next;
  }

  // generation is echoed by the agent. A reply for an older number arrives after the user has started another turn.
  private refreshSuggestion(sessionId: string) {
    if (!this.suggestionsAllowed()) return;
    const session = this.sessionMap.get(sessionId);
    if (!session || session.status !== "idle" || session.queue.length > 0) return;
    if (!session.transcript.some((item) => String(item.text ?? "").trim())) return;
    const generation = this.nextSuggestionGen(sessionId);
    this.rpc
      .request("_x.ai/suggestPrompt", { sessionId, generation }, SUGGEST_TIMEOUT_MS)
      .then((result) => {
        if (this.suggestionGen.get(sessionId) !== generation) return;
        const current = this.sessionMap.get(sessionId);
        if (!current || current.status !== "idle") return;
        const reply = SuggestResult.parse(result);
        const text = cleanSuggestion(reply.suggestion ?? reply.result?.suggestion);
        if ((current.suggestion ?? null) === text) return;
        this.apply(sessionId, { type: "suggestion", text });
      })
      .catch(() => {});
  }
}

// Whether `grok models` says the account is signed in: its first line is "You are logged in with
// grok.com." or "You are not authenticated.". null when it says neither. Grok reads its own login;
// this app never opens ~/.grok/auth.json.
export function grokSignedIn(output: string | null): boolean | null {
  const first = (output ?? "").trim().split("\n")[0] ?? "";
  if (/^You are logged in\b/i.test(first)) return true;
  if (/not authenticated|not logged in/i.test(first)) return false;
  return null;
}
