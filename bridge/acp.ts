// The shared ACP client. It speaks standard ACP to one agent process and keeps every
// session on it as the reducer's SessionState. A provider (grok/provider.ts,
// claude/provider.ts, chatgpt/provider.ts) extends it with how to reach its harness and with the harness's
// own extensions, through the protected hooks below.

import { RpcClient, type RpcId, type RpcNotification, type RpcRequest, type Transport } from "./rpc.ts";
import { emptySession, reduce, waitsOnPerson, type DisplayAttachment, type PendingElicitation, type PermissionEvent, type ReducerEvent, type SessionState } from "./reducer.ts";
import { composePrompt, withThumbnails, type ComposedPrompt, type PromptBlock } from "./attachments.ts";
import { acpFacts, type ToolCall, type ToolFacts } from "./tools.ts";
import { formContent, formFields } from "./elicitation.ts";
import {
  ElicitationParams,
  PromptResult,
  SessionList,
  SessionResult,
  SetConfigResult,
  eventFromNotification,
  initializeParams,
  isRecord,
  permissionFromRequest,
  type CatalogEntry,
  type ConfigOption,
  type Translated,
} from "./protocol.ts";
import type { InitializeRequest } from "@agentclientprotocol/sdk";
import type { Mode, NewSession, ProviderStatus, SessionToolGrant, SessionTools } from "./provider.ts";

const INIT_TIMEOUT_MS = 20000;
const SESSION_TIMEOUT_MS = 120000;
const MAX_RECONNECTS = 8;
const LIVE_TOOL = new Set<string | null | undefined>(["in_progress", "pending", "running"]);

export interface AcpOptions {
  // Tests pass a fake socket here instead of starting the agent.
  connect?: () => Transport | Promise<Transport>;
  readyTimeoutMs?: number;
  promptTimeoutMs?: number;
  // The initialize request on every connect, the first and each reconnect.
  initTimeoutMs?: number;
  // The host's MCP servers, passed to every session/new and session/load.
  sessionTools?: SessionTools;
}

export interface Buffered {
  sessionId: string | null;
  event: ReducerEvent;
}

// A follow-up the app holds for an agent that does not queue prompts.
interface HeldPrompt {
  id: string;
  version: number;
  text: string;
  attachments: unknown;
  files: DisplayAttachment[];
  resolve: (session: SessionState | undefined) => void;
  reject: (error: Error) => void;
}

interface Ticket {
  id: string | null;
  text: string;
  attachments: DisplayAttachment[];
  // Sent while another prompt ran, so the agent queues it.
  queued: boolean;
  // The prompt running when this one was sent.
  sentDuring: string | null;
  queuedId?: string;
}

type QueueEvent = Extract<ReducerEvent, { type: "queue" }>;

type LoadTail = "finished" | "tool" | "attention" | "text" | "user" | null;

export class AcpClient {
  options: AcpOptions;
  rpc: RpcClient;
  sessionMap: Map<string, SessionState>;
  catalog: Map<string, CatalogEntry>;
  status: ProviderStatus;
  lastError: unknown;
  // What the agent said about itself in initialize.
  agentInfo: unknown;

  constructor(options: AcpOptions = {}) {
    this.options = options;
    this.rpc = new RpcClient();
    this.sessionMap = new Map();
    this.catalog = new Map();
    this.status = "idle";
    this.lastError = null;
    this.agentInfo = null;
    this.listeners = new Set();
    this.statusListeners = new Set();
    this.catalogListeners = new Set();
    this.buffer = [];
    this.openCount = 0;
    this.settling = new Set();
    this.stopped = false;
    this.epoch = 0;
    this.openTickets = new Map();
    this.warm = new Set();
    this.inflightLoads = new Map();
    this.loadTail = new Map();
    this.replaying = new Set();
    this.fromLog = false;
    this.transport = null;
    this.loopDone = null;
    this.running = false;
    this.loadedOn = null;
    this.kick = () => {};
    this.held = new Map();
    this.heldSeq = 0;
    this.composing = new Map();
    this.waitingPermissions = new Map();
    this.waitingQuestions = new Map();

    this.rpc.onNotification = (message) => this.onNotification(message);
    this.rpc.onRequest = (message) => this.onRequest(message);
  }

  private listeners: Set<(session: SessionState) => void>;
  private statusListeners: Set<(status: ProviderStatus) => void>;
  private catalogListeners: Set<(entry: CatalogEntry) => void>;
  private buffer: Buffered[];
  // Opens in flight. While any runs, events for a session nobody holds yet are buffered.
  private openCount: number;
  // Sessions being opened or loaded. Their replayed events do not start a turn.
  private settling: Set<string>;
  protected stopped: boolean;
  private epoch: number;
  private openTickets: Map<string, Ticket[]>;
  private warm: Set<string>;
  private inflightLoads: Map<string, Promise<SessionState | undefined>>;
  // How each loading session's replay ended.
  private loadTail: Map<string, LoadTail>;
  // Sessions whose session/load replay is running.
  protected replaying: Set<string>;
  protected fromLog: boolean;
  protected transport: Transport | null;
  private loopDone: Promise<void> | null;
  private running: boolean;
  // The agent the open sessions were last loaded on, so a reconnect can tell it is talking to a new one.
  private loadedOn: unknown;
  private kick: () => void;
  // Follow-ups held until the running turn ends, for agents that do not queue prompts.
  private held: Map<string, HeldPrompt[]>;
  private heldSeq: number;
  // Follow-ups keep their order while one waits for its thumbnail.
  private composing: Map<string, Promise<unknown>>;
  // Permission requests that arrived while another one waits for the person, shown one after another.
  private waitingPermissions: Map<string, PermissionEvent[]>;
  // Questions that arrived while another one waits for the person, shown the same way.
  private waitingQuestions: Map<string, Extract<ReducerEvent, { type: "elicitation" }>[]>;

  protected get opening() {
    return this.openCount > 0;
  }

  // ---- Hooks a provider overrides ----

  // Called once per start, before the connect loop.
  protected async prepare(): Promise<void> {
    if (!this.options.connect) throw new Error("this provider has no way to reach its agent");
  }

  // A fresh connection for each attempt of the loop.
  protected connectTransport(): Transport | Promise<Transport> {
    if (!this.options.connect) throw new Error("this provider has no way to reach its agent");
    return this.options.connect();
  }

  // Stops the agent process, if the provider started one.
  protected async shutdown(): Promise<void> {}

  // The agent process now running. A new one after a reconnect means the running turns died with the old one.
  protected agentIdentity(): unknown {
    return null;
  }

  protected initializeParams(): InitializeRequest {
    const params = initializeParams();
    return { ...params, clientCapabilities: { ...params.clientCapabilities, elicitation: { form: {} } } };
  }

  // Notifications to reducer events. A provider adds its extensions.
  protected translate(message: unknown): Translated | null {
    return eventFromNotification(message);
  }

  // What a tool call does. A provider reads its harness's tool names and inputs.
  protected toolFacts(tool: ToolCall): ToolFacts {
    return acpFacts(tool);
  }

  protected reduce(session: SessionState, event: ReducerEvent): SessionState {
    return reduce(session, event, (tool) => this.toolFacts(tool));
  }

  // A notification that is not a session event. True when the provider handled it.
  protected handleNotification(_message: RpcNotification): boolean {
    return false;
  }

  // The reply to a waiting question, in the shape the agent asked in. action is accept, decline, cancel,
  // or one of the question's own actions.
  protected questionReply(_sessionId: string, pending: PendingElicitation, action: string, content?: unknown): unknown {
    return action === "accept" ? { action, content: formContent(pending.fields, content) } : { action };
  }

  // A request from the agent beyond permissions and elicitations. True when the provider handled it.
  protected handleRequest(_message: RpcRequest): boolean {
    return false;
  }

  // The open session whose chat shows the requests the agent makes in sessionId, such as a subagent's own session.
  protected shownIn(sessionId: string | null): string | null {
    return sessionId;
  }

  // Fields beside cwd and mcpServers for session/new, and for session/load. tools is the host's grant in mcpServers.
  protected newSessionParams(_options: NewSession, _tools?: SessionToolGrant): Record<string, unknown> {
    return {};
  }

  protected loadSessionParams(_sessionId: string, _tools?: SessionToolGrant): Record<string, unknown> {
    return {};
  }

  // The host's servers as session/new and session/load send them.
  protected mcpServers(tools?: SessionToolGrant): unknown[] {
    return tools?.servers ?? [];
  }

  protected withToolLine(rules: unknown, tools?: SessionToolGrant): string {
    const own = typeof rules === "string" ? rules.trim() : "";
    return [own, tools?.instructions ?? ""].filter(Boolean).join("\n\n");
  }

  // The blocks session/prompt sends, for a harness that takes something along with the person's prompt.
  protected promptBlocks(_sessionId: string, blocks: PromptBlock[]): PromptBlock[] {
    return blocks;
  }

  // The rules each session was opened or loaded with, for a reload after the agent restarts.
  protected sessionRules = new Map<string, string>();

  // The agent's config options in the app's names, and one of the app's keys in the agent's names.
  protected configFromAgent(options: ConfigOption[]): ConfigOption[] {
    return options;
  }

  protected configToAgent(key: string): string {
    return key;
  }

  // The app's approval mode as the agent names it, and back. null leaves the mode as it was.
  protected modeToAgent(mode: Mode): string {
    return mode;
  }

  protected modeFromAgent(modeId: string | null): Mode | null {
    return (modeId as Mode | null) ?? null;
  }

  // Whether the agent queues a prompt sent while a turn runs. Without that, a follow-up waits for the turn to end.
  protected queuesPrompts(): boolean {
    return true;
  }

  // The message a failed turn shows. A provider can say what the person can do about it.
  protected explainError(error: unknown): string {
    return messageOf(error);
  }

  // A turn started, or the session came back idle after one.
  protected onTurnStart(_sessionId: string): void {}
  protected afterIdle(_sessionId: string): void {}

  // Awaited at the end of every session/load: a sidebar reopen, and each reload after a reconnect.
  protected async afterReload(_sessionId: string): Promise<void> {}

  // Every config list the agent sends for a session, in its own names, before the app maps it.
  protected onAgentConfig(_sessionId: string, _options: ConfigOption[]): void {}

  // ---- Listeners and reads ----

  onSession(listener: (session: SessionState) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onStatus(listener: (status: ProviderStatus) => void) {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  onCatalog(listener: (entry: CatalogEntry) => void) {
    this.catalogListeners.add(listener);
    return () => this.catalogListeners.delete(listener);
  }

  getSession(sessionId: string) {
    return this.sessionMap.get(sessionId) ?? null;
  }

  sessions() {
    return [...this.sessionMap.values()];
  }



  ownsTurn(sessionId: string) {
    return (this.openTickets.get(sessionId) ?? []).length > 0;
  }

  activityMarks() {
    const working: string[] = [];
    const attention: string[] = [];
    for (const session of this.sessionMap.values()) {
      const pendingPrompt = (this.openTickets.get(session.id) ?? []).length > 0 || (this.held.get(session.id) ?? []).length > 0;
      if (waitsOnPerson(session)) attention.push(session.id);
      else if (session.status === "running" || pendingPrompt) working.push(session.id);
    }
    return { working, attention };
  }

  // ---- Lifecycle ----

  // Safe to call again. While the loop runs, this waits for it to end up ready, failed, or stopped:
  // reloading every open chat can take far longer than the first start is allowed.
  async start() {
    // A stop under way reads "stopped" before its loop ends, which the wait for "ready" below would take as final.
    if (this.stopped && this.running) await this.loopDone;
    if (this.running) {
      await this.waitForStatus("ready", null);
      return;
    }
    this.running = true;
    this.stopped = false;
    this.lastError = null;
    try {
      await this.prepare();
    } catch (error) {
      this.running = false;
      this.lastError = error;
      if (!this.stopped) this.setStatus("failed");
      throw error;
    }

    this.loopDone = this.run()
      .catch((error: unknown) => {
        this.lastError = error;
        this.setStatus("failed");
      })
      .finally(() => {
        this.running = false;
      });
    await this.waitForStatus("ready", this.options.readyTimeoutMs ?? INIT_TIMEOUT_MS);
  }

  async stop() {
    this.stopped = true;
    this.setStatus("stopped");
    this.kick();
    this.rpc.detach();
    this.transport?.close();
    await this.shutdown();
    await this.loopDone;
  }

  // ---- Sessions ----

  async createSession(options: NewSession) {
    this.assertReady();
    this.openCount += 1;
    let id = "";
    try {
      const tools = this.options.sessionTools?.grant(null, options.cwd);
      const params = { cwd: options.cwd, mcpServers: this.mcpServers(tools), ...this.newSessionParams(options, tools) };
      const rules = typeof options.rules === "string" ? options.rules.trim() : "";
      const parsed = SessionResult.parse(await this.rpc.request("session/new", params, SESSION_TIMEOUT_MS));
      if (!parsed.sessionId) throw new Error("session/new returned no session id");
      id = parsed.sessionId;
      tools?.bind(id);
      if (rules) this.sessionRules.set(id, rules);
      const configOptions = this.configFromAgent(parsed.configOptions ?? []);
      const session = emptySession({ id, cwd: options.cwd, configOptions, modelId: parsed.models?.currentModelId });
      const mode = this.modeFromAgent(parsed.modes?.currentModeId ?? null);
      this.sessionMap.set(id, mode ? { ...session, modeId: mode } : session);
      this.onAgentConfig(id, parsed.configOptions ?? []);
      this.settling.add(id);
      this.drain(id);
      this.warm.add(id);
    } finally {
      this.openCount -= 1;
      this.settling.delete(id);
    }
    await this.applyChoices(id, options);
    const created = this.sessionMap.get(id);
    if (!created) throw new Error("the session closed while it opened");
    this.emit(created);
    return created;
  }

  // The model, then the effort (its levels depend on the model), then the mode. A refused pick
  // keeps the agent's default, and the later picks are still set.
  protected async applyChoices(sessionId: string, { model, effort, mode }: Pick<NewSession, "model" | "effort" | "mode">) {
    const current = () => this.sessionMap.get(sessionId);
    const optionOf = (key: string) => current()?.configOptions.find((option) => option.id === key);
    // An option that lists no choices takes any value, as the menus did before a session existed.
    // A model without the option (Claude's Haiku has no effort) takes no value for it.
    const offers = (key: string, value: string) => {
      const option = optionOf(key);
      if (!option) return false;
      const choices = option.options ?? [];
      return !choices.length || choices.some((choice) => choice.value === value);
    };
    const attempt = async (step: () => Promise<unknown>) => {
      try {
        await step();
      } catch (error) {
        this.lastError = error;
      }
    };
    if (model && optionOf("model")?.currentValue !== model && offers("model", model)) {
      await attempt(() => this.setConfig(sessionId, "model", model));
    }
    if (effort && optionOf("effort")?.currentValue !== effort && offers("effort", effort)) {
      await attempt(() => this.setConfig(sessionId, "effort", effort));
    }
    if (mode && current()?.modeId !== mode) await attempt(() => this.setMode(sessionId, mode));
  }

  async loadSession(sessionId: string, cwd: string, options: { rules?: string } = {}) {
    this.assertReady();
    const rules = typeof options.rules === "string" ? options.rules.trim() : "";
    if (rules) this.sessionRules.set(sessionId, rules);
    if (!this.warm.has(sessionId)) {
      const job: Promise<SessionState | undefined> = this.inflightLoads.get(sessionId) ?? this.reload(sessionId, cwd).finally(() => {
        if (this.inflightLoads.get(sessionId) === job) this.inflightLoads.delete(sessionId);
      });
      this.inflightLoads.set(sessionId, job);
      await job;
    }
    const session = this.sessionMap.get(sessionId);
    if (session?.status === "idle" && session.error) this.apply(sessionId, { type: "error-cleared" });
    return this.sessionMap.get(sessionId);
  }

  // Stored sessions, where the agent can list them (session/list).
  protected async listSessions(cwd?: string): Promise<CatalogEntry[]> {
    this.assertReady();
    const result = SessionList.parse(await this.rpc.request("session/list", cwd ? { cwd } : {}, SESSION_TIMEOUT_MS));
    return (result.sessions ?? []).map((row) => ({
      sessionId: row.sessionId,
      title: row.title ?? null,
      cwd: row.cwd ?? null,
      isWorktree: false,
      sessionKind: null,
      updatedAt: row.updatedAt ?? null,
    }));
  }

  async prompt(sessionId: string, text: unknown, attachments?: unknown) {
    const session = this.require(sessionId);
    if (session.status === "running") throw new Error("session is already running a turn");
    const composed = composePrompt(text, attachments);
    this.apply(sessionId, { type: "begin-turn" });
    this.apply(sessionId, { type: "user", text: composed.text, attachments: composed.attachments });
    return this.sendPrompt(sessionId, composed);
  }

  async followUp(sessionId: string, text: unknown, attachments?: unknown): Promise<SessionState | undefined> {
    this.require(sessionId);
    const ready = (this.composing.get(sessionId) ?? Promise.resolve()).then(() => withThumbnails(composePrompt(text, attachments)));
    this.composing.set(sessionId, ready.catch(() => {}));
    const composed = await ready;
    if (this.require(sessionId).status !== "running") return this.prompt(sessionId, text, attachments);
    if (this.queuesPrompts()) return this.sendPrompt(sessionId, composed, true);
    // The agent would refuse a second prompt, so the app holds this one until the turn ends.
    return new Promise((resolve, reject) => {
      const list = this.held.get(sessionId) ?? [];
      this.heldSeq += 1;
      list.push({ id: `held-${this.heldSeq}`, version: 0, text: composed.text, attachments, files: composed.attachments, resolve, reject });
      this.held.set(sessionId, list);
      this.showHeld(sessionId);
    });
  }

  // The follow-ups waiting behind the running turn. A provider whose agent queues them overrides these.
  editQueued(sessionId: string, id: string, text: string, _version: number) {
    this.require(sessionId);
    const entry = (this.held.get(sessionId) ?? []).find((item) => item.id === id);
    if (!entry) throw new Error("queued message is gone");
    entry.text = text;
    entry.version += 1;
    this.showHeld(sessionId);
  }

  removeQueued(sessionId: string, id: string, _version: number) {
    this.require(sessionId);
    const list = this.held.get(sessionId) ?? [];
    const entry = list.find((item) => item.id === id);
    if (!entry) return;
    this.held.set(sessionId, list.filter((item) => item !== entry));
    entry.resolve(this.sessionMap.get(sessionId) ?? undefined);
    this.showHeld(sessionId);
  }

  // Stops the running turn. The chosen message goes next, when the turn has ended.
  async sendQueuedNow(sessionId: string, id: string) {
    const session = this.require(sessionId);
    const list = this.held.get(sessionId) ?? [];
    const entry = list.find((item) => item.id === id);
    if (!entry) throw new Error("queued message is gone");
    this.held.set(sessionId, [entry, ...list.filter((item) => item !== entry)]);
    this.showHeld(sessionId);
    if (session.status === "running") this.cancel(sessionId);
    else this.sendHeld(sessionId);
  }

  private showHeld(sessionId: string) {
    const entries = (this.held.get(sessionId) ?? []).map((entry, position) => ({
      id: entry.id,
      version: entry.version,
      text: entry.text,
      position,
      ...(entry.files.length ? { attachments: entry.files } : {}),
    }));
    this.apply(sessionId, { type: "queue", entries, runningPromptId: null, runningText: null });
  }

  // Sends the first held follow-up once the session is idle, nothing waits on a person, and the agent is
  // connected. A follow-up held while the agent restarts goes once the sessions have reloaded.
  private sendHeld(sessionId: string) {
    const session = this.sessionMap.get(sessionId);
    const list = this.held.get(sessionId) ?? [];
    const first = list[0];
    if (this.status !== "ready" || !session || !first || session.status === "running" || waitsOnPerson(session)) return;
    this.held.set(sessionId, list.slice(1));
    this.showHeld(sessionId);
    this.prompt(sessionId, first.text, first.attachments).then(first.resolve, (error: unknown) => {
      first.reject(error instanceof Error ? error : new Error(String(error)));
    });
  }

  private dropHeld(sessionId: string, reason = "the session closed before the message was sent") {
    for (const entry of this.held.get(sessionId) ?? []) entry.reject(new Error(reason));
    this.held.delete(sessionId);
  }

  private async sendPrompt(sessionId: string, composed: ComposedPrompt, queued = false) {
    const epoch = this.epoch;
    const ticket: Ticket = {
      id: null,
      text: composed.text,
      attachments: composed.attachments,
      queued,
      sentDuring: queued ? (this.sessionMap.get(sessionId)?.queueRunningId ?? null) : null,
    };
    const open = this.openTickets.get(sessionId) ?? [];
    open.push(ticket);
    this.openTickets.set(sessionId, open);
    try {
      // A turn can run longer than any fixed client limit. The connection closing still rejects this.
      const result = PromptResult.parse(
        await this.rpc.request(
          "session/prompt",
          { sessionId, prompt: this.promptBlocks(sessionId, composed.blocks) },
          this.options.promptTimeoutMs ?? 0,
        ),
      );
      if (this.epoch === epoch) this.completeTicket(sessionId, ticket, result.stopReason ?? null);
      return this.sessionMap.get(sessionId);
    } catch (error) {
      // A dropped connection bumps the epoch and session/load rebuilds the transcript.
      const explained = this.explainError(error);
      if (this.epoch === epoch) this.completeTicket(sessionId, ticket, "error", explained);
      throw explained && explained !== messageOf(error) ? new Error(explained, { cause: error }) : error;
    }
  }

  // Ties each sent prompt to the agent's IDs for its queue row and its run. The agent reports text only.
  private bindTickets(sessionId: string, event: QueueEvent) {
    const open = this.openTickets.get(sessionId) ?? [];
    // A row the queue already showed belongs to an earlier message, even with the same text.
    const shown = new Set((this.sessionMap.get(sessionId)?.queue ?? []).map((entry) => entry.id));
    for (const entry of [...event.entries].sort((left, right) => left.position - right.position)) {
      if (shown.has(entry.id)) continue;
      const ticket = open.find((item) => item.queued && !item.queuedId && !item.id && item.text === entry.text);
      if (ticket) ticket.queuedId = entry.id;
    }
    const runningId = event.runningPromptId;
    if (!runningId || open.some((item) => item.id === runningId)) return;
    // A follow-up is never the prompt that was already running when it was sent.
    const ticket =
      open.find((item) => !item.id && item.queuedId === runningId) ??
      open.find(
        (item) =>
          !item.id &&
          item.text === event.runningText &&
          (!item.queued || (item.sentDuring !== null && item.sentDuring !== runningId)),
      );
    if (ticket) ticket.id = runningId;
  }

  private withTicketFiles(sessionId: string, event: QueueEvent): QueueEvent {
    const open = this.openTickets.get(sessionId) ?? [];
    const entries = event.entries.map((entry) => {
      if (entry.attachments?.length) return entry;
      const files = open.find((item) => item.queuedId === entry.id)?.attachments;
      return files?.length ? { ...entry, attachments: files } : entry;
    });
    return { ...event, entries };
  }

  private completeTicket(sessionId: string, ticket: Ticket, stopReason: string | null, error: string | null = null) {
    const open = this.openTickets.get(sessionId) ?? [];
    const index = open.indexOf(ticket);
    if (index >= 0) open.splice(index, 1);
    const session = this.sessionMap.get(sessionId);
    if (!session) return;
    if (this.queuesPrompts() && session.queueRunningId && ticket.id !== session.queueRunningId) return;
    if (this.queuesPrompts() && session.queue.length > 0) return;
    if (open.length > 0) return;
    this.apply(sessionId, { type: "turn-finished", stopReason, error });
  }

  answerPermission(sessionId: string, optionId: string) {
    const pending = this.require(sessionId).pendingPermission;
    if (!pending) throw new Error("no permission is waiting");
    if (!pending.options.some((option) => option.optionId === optionId)) {
      throw new Error(`unknown permission option: ${optionId}`);
    }
    this.rpc.respond(pending.rpcId, { outcome: { outcome: "selected", optionId } });
    this.apply(sessionId, { type: "permission-cleared" });
  }

  cancelPermission(sessionId: string) {
    const pending = this.require(sessionId).pendingPermission;
    if (!pending) throw new Error("no permission is waiting");
    this.rpc.respond(pending.rpcId, { outcome: { outcome: "cancelled" } });
    this.apply(sessionId, { type: "permission-cleared" });
  }

  answerElicitation(sessionId: string, action: string, content?: unknown) {
    const pending = this.require(sessionId).pendingElicitation;
    if (!pending) throw new Error("no question is waiting");
    const known = ["accept", "decline", "cancel", ...pending.actions.map((choice) => choice.id)];
    if (!known.includes(action)) throw new Error(`unknown answer: ${action}`);
    if (action === "accept") {
      const filled = formContent(pending.fields, content);
      if (pending.fields.some((field) => field.required && !(field.key in filled))) throw new Error("answer every required question");
    }
    this.rpc.respond(pending.rpcId, this.questionReply(sessionId, pending, action, content));
    this.apply(sessionId, { type: "elicitation-cleared" });
  }

  cancel(sessionId: string) {
    const session = this.require(sessionId);
    // Waiting ones go first, so answering the shown question does not show the next.
    this.cancelWaiting(sessionId);
    if (session.pendingElicitation) this.answerElicitation(sessionId, "cancel");
    this.rpc.notify("session/cancel", { sessionId });
  }

  async forgetSession(sessionId: string) {
    const session = this.sessionMap.get(sessionId);
    // Before any await: a cancelled turn that ends meanwhile must not send a held follow-up to a closing session.
    this.dropHeld(sessionId);
    this.openTickets.delete(sessionId);
    if (session) this.answerOpenRequests(session);
    if (this.status === "ready" && session) {
      if (session.status === "running") this.rpc.notify("session/cancel", { sessionId });
      await this.beforeClose(session);
      await this.rpc.request("session/close", { sessionId }, 3000).catch(() => {});
    }
    this.sessionMap.delete(sessionId);
    this.catalog.delete(sessionId);
    this.openTickets.delete(sessionId);
    this.warm.delete(sessionId);
    this.inflightLoads.delete(sessionId);
    this.dropHeld(sessionId);
    this.composing.delete(sessionId);
    this.sessionRules.delete(sessionId);
    this.buffer = this.buffer.filter((item) => item.sessionId !== sessionId);
  }

  // Extra cleanup a provider does on the agent before session/close.
  protected async beforeClose(_session: SessionState): Promise<void> {}

  // Answers everything the agent is waiting on for this session, as a cancel.
  protected answerOpenRequests(session: SessionState) {
    this.cancelWaiting(session.id);
    if (session.pendingPermission) {
      this.rpc.respond(session.pendingPermission.rpcId, { outcome: { outcome: "cancelled" } });
    }
    if (session.pendingPlan) {
      this.rpc.respond(session.pendingPlan.rpcId, { outcome: "cancelled" });
    }
    if (session.pendingElicitation) {
      this.rpc.respond(session.pendingElicitation.rpcId, this.questionReply(session.id, session.pendingElicitation, "cancel"));
    }
  }

  private cancelWaiting(sessionId: string) {
    for (const queued of this.waitingPermissions.get(sessionId) ?? []) this.rpc.respond(queued.rpcId, { outcome: { outcome: "cancelled" } });
    for (const queued of this.waitingQuestions.get(sessionId) ?? []) this.rpc.respond(queued.rpcId, this.questionReply(sessionId, queued, "cancel"));
    this.waitingPermissions.delete(sessionId);
    this.waitingQuestions.delete(sessionId);
  }

  async setMode(sessionId: string, mode: Mode) {
    this.require(sessionId);
    await this.rpc.request("session/set_mode", { sessionId, modeId: this.modeToAgent(mode) });
    this.apply(sessionId, { type: "mode", modeId: mode });
    return this.sessionMap.get(sessionId);
  }

  async setConfig(sessionId: string, key: string, value: unknown) {
    this.require(sessionId);
    const result = SetConfigResult.parse(
      await this.rpc.request("session/set_config_option", {
        sessionId,
        configId: this.configToAgent(key),
        value,
      }),
    );
    const options = Array.isArray(result) ? result : result.configOptions;
    if (Array.isArray(options) && options.length) {
      this.onAgentConfig(sessionId, options);
      this.apply(sessionId, { type: "config", configOptions: this.configFromAgent(options) });
    }
    return this.sessionMap.get(sessionId);
  }

  // The session's folder, when the harness or git status says it moved.
  setSessionCwd(sessionId: string, cwd: unknown) {
    const next = String(cwd || "").trim();
    const current = this.sessionMap.get(sessionId);
    if (!current || !next || sameFolder(current.cwd, next)) return current?.cwd || "";
    this.apply(sessionId, { type: "cwd", cwd: next });
    return this.sessionMap.get(sessionId)?.cwd || next;
  }

  // ---- The connect loop ----

  private async run() {
    let attempt = 0;
    while (!this.stopped) {
      try {
        this.epoch += 1;
        this.setStatus(this.status === "idle" ? "connecting" : "reconnecting");
        const transport = await this.connectTransport();
        if (this.stopped) {
          transport.close();
          return;
        }
        const wrapped = wrapTransport(transport, () => {
          if (this.transport !== wrapped || this.stopped) return;
          this.setStatus("reconnecting");
        });
        this.transport = wrapped;
        this.rpc.attach(wrapped);
        this.agentInfo = await this.rpc.request("initialize", this.initializeParams(), this.options.initTimeoutMs ?? INIT_TIMEOUT_MS);
        // A new agent is not running any turn the old one was in, whatever the replay shows.
        const agent = this.agentIdentity();
        const replaced = this.loadedOn !== null && agent !== this.loadedOn;
        await this.reloadAll(replaced);
        this.loadedOn = agent;
        attempt = 0;
        this.setStatus("ready");
        for (const sessionId of this.held.keys()) this.sendHeld(sessionId);
        await wrapped.closed;
        if (this.transport === wrapped) this.transport = null;
        if (this.stopped) return;
      } catch (error) {
        this.lastError = error;
        if (this.stopped) return;
      }
      attempt += 1;
      if (attempt > MAX_RECONNECTS) {
        this.setStatus("failed");
        return;
      }
      this.setStatus("reconnecting");
      await this.pause(Math.min(250 * attempt, 3000));
    }
  }

  private async reloadAll(replaced: boolean) {
    for (const session of [...this.sessionMap.values()]) {
      try {
        await this.reload(session.id, session.cwd, replaced);
      } catch (error) {
        this.lastError = error;
        // A session the new agent cannot load still ends its running turn.
        if (replaced) this.settleOrphaned(session.id);
      }
    }
  }

  private async reload(sessionId: string, cwd: string, replaced = false) {
    this.openCount += 1;
    this.settling.add(sessionId);
    this.replaying.add(sessionId);
    this.loadTail.delete(sessionId);
    this.warm.delete(sessionId);
    try {
      if (!this.sessionMap.has(sessionId)) this.sessionMap.set(sessionId, emptySession({ id: sessionId, cwd }));
      // Requests queued on a connection that dropped are dead, so the reset must not show one.
      this.waitingPermissions.delete(sessionId);
      this.waitingQuestions.delete(sessionId);
      this.apply(sessionId, { type: "reset", cwd });
      const tools = this.options.sessionTools?.grant(sessionId, cwd);
      const parsed = SessionResult.parse(
        await this.rpc.request("session/load", { sessionId, cwd, mcpServers: this.mcpServers(tools), ...this.loadSessionParams(sessionId, tools) }, SESSION_TIMEOUT_MS),
      );
      this.drain(sessionId);
      this.onAgentConfig(sessionId, parsed.configOptions ?? []);
      this.apply(sessionId, {
        type: "config",
        configOptions: this.configFromAgent(parsed.configOptions ?? []),
        modelId: parsed.models?.currentModelId ?? null,
      });
      const mode = this.modeFromAgent(parsed.modes?.currentModeId ?? null);
      if (mode) this.apply(sessionId, { type: "mode", modeId: mode });
      if (replaced) this.settleOrphaned(sessionId);
      else this.settleLoaded(sessionId);
      // A provider's own work on the loaded session finishes before the load answers, and before a
      // reconnect marks the agent ready and sends held follow-ups.
      await this.afterReload(sessionId);
      this.warm.add(sessionId);
    } finally {
      this.replaying.delete(sessionId);
      this.settling.delete(sessionId);
      this.loadTail.delete(sessionId);
      this.openCount -= 1;
    }
    return this.sessionMap.get(sessionId);
  }

  private settleLoaded(sessionId: string) {
    const session = this.sessionMap.get(sessionId);
    if (!session) return;
    const tail = this.loadTail.get(sessionId) ?? null;
    const tickets = (this.openTickets.get(sessionId) ?? []).length > 0;
    const liveTool = session.transcript.some(
      (item) => item.type === "tool" && item.statusExplicit && LIVE_TOOL.has(item.status),
    );
    const resume = tickets || waitsOnPerson(session) || tail === "attention" || liveTool;
    if (resume) {
      if (session.status !== "running") this.apply(sessionId, { type: "begin-turn" });
      return;
    }
    this.apply(sessionId, { type: "settle" });
    this.afterIdle(sessionId);
  }

  // The replay can end on a live tool or a request from the agent that died. Nothing will finish them now.
  private settleOrphaned(sessionId: string) {
    const session = this.sessionMap.get(sessionId);
    if (!session) return;
    // Answered as forgetSession does, in case the new agent did ask again and is waiting.
    this.answerOpenRequests(session);
    if (session.pendingPermission) this.apply(sessionId, { type: "permission-cleared" });
    if (session.pendingPlan) this.apply(sessionId, { type: "plan-cleared" });
    if (session.pendingElicitation) this.apply(sessionId, { type: "elicitation-cleared" });
    if (this.sessionMap.get(sessionId)?.status === "running") {
      this.apply(sessionId, { type: "turn-finished", stopReason: "error", error: this.restartMessage() });
    } else this.apply(sessionId, { type: "settle" });
  }

  // What a turn that died with the old agent shows.
  protected restartMessage(): string {
    const reason = messageOf(this.lastError);
    return reason ? `The agent stopped and was started again: ${reason}` : "The agent stopped and was started again.";
  }

  private noteLoadTail(sessionId: string, event: ReducerEvent) {
    if (!this.replaying.has(sessionId)) return;
    const tail: LoadTail | undefined =
      event.type === "reset" ? null
      : event.type === "turn-finished" ? "finished"
      : event.type === "tool" ? "tool"
      : event.type === "permission" || event.type === "plan-approval" || event.type === "elicitation" ? "attention"
      : event.type === "chunk" && event.role !== "user" ? "text"
      : event.type === "user" || (event.type === "chunk" && event.role === "user") ? "user"
      : undefined;
    if (tail !== undefined) this.loadTail.set(sessionId, tail);
  }

  // ---- Messages from the agent ----

  private onNotification(message: RpcNotification) {
    if (message.method === "$/cancel_request") {
      this.withdrawRequest(message.params);
      return;
    }
    if (this.handleNotification(message)) return;
    const translated = this.translate(message);
    if (!translated) return;
    if (translated.event.type === "catalog") {
      this.applyCatalog(translated.event.upserted);
      return;
    }
    const { sessionId, event } = translated;
    if (event.type === "config" && event.configOptions && sessionId && this.sessionMap.has(sessionId)) this.onAgentConfig(sessionId, event.configOptions);
    const reducerEvent = this.inAppNames(event);
    if (sessionId && this.sessionMap.has(sessionId)) {
      this.apply(sessionId, reducerEvent);
      return;
    }
    if (this.opening) this.buffer.push({ sessionId, event: reducerEvent });
  }

  private onRequest(message: RpcRequest) {
    if (this.handleRequest(message)) return;
    if (message.method === "session/request_permission") {
      const asked = permissionFromRequest(message);
      const event = { ...asked, sessionId: this.shownIn(asked.sessionId) };
      if (event.sessionId && this.sessionMap.has(event.sessionId)) this.apply(event.sessionId, event);
      else if (this.opening) this.buffer.push({ sessionId: event.sessionId, event });
      return;
    }
    if (message.method === "elicitation/create") {
      const params = ElicitationParams.parse(message.params);
      const sessionId = this.shownIn(params.sessionId ?? null);
      const session = sessionId ? this.sessionMap.get(sessionId) : undefined;
      if (sessionId && session && (params.mode ?? "form") === "form") {
        this.apply(sessionId, {
          type: "elicitation",
          rpcId: message.id,
          message: params.message ?? "",
          fields: formFields(params.requestedSchema),
          actions: [],
        });
        return;
      }
      this.rpc.respond(message.id, { action: "decline" });
      return;
    }
    this.rpc.respondError(message.id, -32601, `not implemented: ${message.method}`);
  }

  // The agent withdrew a request it was waiting on, such as a question that timed out.
  private withdrawRequest(params: unknown) {
    const requestId = isRecord(params) ? params.requestId : undefined;
    if (typeof requestId !== "string" && typeof requestId !== "number") return;
    for (const session of this.sessionMap.values()) {
      const queues: { rpcId: RpcId }[][] = [this.waitingPermissions.get(session.id) ?? [], this.waitingQuestions.get(session.id) ?? []];
      const queued = queues.some((queue) => {
        const at = queue.findIndex((event) => event.rpcId === requestId);
        if (at >= 0) queue.splice(at, 1);
        return at >= 0;
      });
      const cleared =
        session.pendingElicitation?.rpcId === requestId ? "elicitation-cleared"
        : session.pendingPermission?.rpcId === requestId ? "permission-cleared"
        : session.pendingPlan?.rpcId === requestId ? "plan-cleared"
        : null;
      if (!cleared && !queued) continue;
      this.rpc.respondError(requestId, -32800, "Request cancelled");
      if (cleared) this.apply(session.id, { type: cleared });
    }
  }

  private drain(sessionId: string) {
    const rest: Buffered[] = [];
    for (const translated of this.buffer) {
      if (!translated.sessionId || translated.sessionId === sessionId) this.apply(sessionId, translated.event);
      else rest.push(translated);
    }
    this.buffer = rest;
  }

  protected apply(sessionId: string, incoming: ReducerEvent) {
    let current = this.sessionMap.get(sessionId);
    if (!current) return;
    if (incoming.type === "queue") this.bindTickets(sessionId, incoming);
    const event = incoming.type === "queue" ? this.withTicketFiles(sessionId, incoming) : incoming;
    if (event.type === "permission" && current.pendingPermission) {
      this.waitingPermissions.set(sessionId, [...(this.waitingPermissions.get(sessionId) ?? []), event]);
      return;
    }
    if (event.type === "elicitation" && current.pendingElicitation) {
      this.waitingQuestions.set(sessionId, [...(this.waitingQuestions.get(sessionId) ?? []), event]);
      return;
    }
    if (event.type === "permission-resolved" && event.toolCallId) {
      this.waitingPermissions.set(sessionId, (this.waitingPermissions.get(sessionId) ?? []).filter((queued) => queued.toolCallId !== event.toolCallId));
    }
    this.noteLoadTail(sessionId, event);
    if (event.type === "turn-finished") {
      const open = this.openTickets.get(sessionId) ?? [];
      if (open.length > 0 || (this.queuesPrompts() && current.queue.length > 0)) return;
    }
    if (!this.settling.has(sessionId) && !this.fromLog && current.status !== "running" && resumesTurn(event)) {
      current = this.reduce(current, { type: "begin-turn" });
      this.onTurnStart(sessionId);
    }
    if (event.type === "begin-turn") this.onTurnStart(sessionId);
    let next = this.reduce(current, event);
    const shownNext = current.pendingPermission && !next.pendingPermission ? this.waitingPermissions.get(sessionId)?.shift() : undefined;
    if (shownNext) next = this.reduce(next, shownNext);
    const askedNext = current.pendingElicitation && !next.pendingElicitation ? this.waitingQuestions.get(sessionId)?.shift() : undefined;
    if (askedNext) next = this.reduce(next, askedNext);
    this.sessionMap.set(sessionId, next);
    if (!this.fromLog) this.emit(next);
    if (event.type === "turn-finished" && next.status === "idle" && !this.replaying.has(sessionId) && !this.fromLog) {
      this.afterIdle(sessionId);
    }
    // A held follow-up goes once the turn has ended and any permission is answered.
    if (!this.replaying.has(sessionId) && !this.fromLog && next.status === "idle" && (this.held.get(sessionId) ?? []).length > 0) {
      queueMicrotask(() => this.sendHeld(sessionId));
    }
  }



  // An agent's mode and config ids in the app's names, the same for live notifications and update logs.
  protected inAppNames(event: ReducerEvent): ReducerEvent {
    if (event.type === "mode") return { ...event, modeId: this.modeFromAgent(event.modeId) };
    if (event.type === "config" && event.configOptions) return { ...event, configOptions: this.configFromAgent(event.configOptions) };
    return event;
  }

  private applyCatalog(upserted: (Partial<CatalogEntry> & { sessionId?: string })[]) {
    for (const entry of upserted) {
      if (!entry.sessionId) continue;
      const known = this.catalog.get(entry.sessionId);
      const next: CatalogEntry = {
        sessionId: entry.sessionId,
        title: null,
        cwd: null,
        isWorktree: false,
        sessionKind: null,
        ...known,
        ...definedFields(entry),
      };
      this.catalog.set(entry.sessionId, next);
      for (const listener of this.catalogListeners) listener(next);
      if (typeof entry.cwd === "string" && entry.cwd.trim()) this.setSessionCwd(entry.sessionId, entry.cwd);
    }
  }

  // A listener that throws does not undo the event. The session is already
  // updated, and a request it carries (a permission, a plan) still waits for
  // the user's answer, so the error must not reach the agent as a failed request.
  protected emit(session: SessionState) {
    for (const listener of this.listeners) {
      try {
        listener(session);
      } catch (error) {
        console.error(`session listener failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  protected require(sessionId: string) {
    const session = this.sessionMap.get(sessionId);
    if (!session) throw new Error(`unknown session ${sessionId}`);
    return session;
  }

  protected assertReady() {
    if (this.status !== "ready") throw new Error(`the agent is ${this.status}`);
  }

  private setStatus(status: ProviderStatus) {
    if (this.status === status) return;
    this.status = status;
    // The agent is gone for good, so nothing held can be sent.
    if (status === "failed" || status === "stopped") {
      for (const sessionId of [...this.held.keys()]) this.dropHeld(sessionId, `the agent ${status} before the message was sent`);
    }
    for (const listener of this.statusListeners) listener(status);
  }

  // Settles on wanted, or rejects once the loop has ended up failed or stopped. No timeout when timeoutMs is null.
  private waitForStatus(wanted: ProviderStatus, timeoutMs: number | null) {
    if (this.status === wanted) return Promise.resolve();
    const ended = () => this.lastError ?? new Error(`bridge ${this.status}`);
    if (this.status === "failed" || this.status === "stopped") return Promise.reject(ended());
    return new Promise<void>((resolve, reject) => {
      const timer =
        timeoutMs === null
          ? null
          : setTimeout(() => {
              unsubscribe();
              const message = this.lastError instanceof Error ? this.lastError.message : "";
              reject(new Error(message || `the agent did not become ${wanted}`));
            }, timeoutMs);
      const unsubscribe = this.onStatusChange((status) => {
        if (status !== wanted && status !== "failed" && status !== "stopped") return;
        if (timer) clearTimeout(timer);
        unsubscribe();
        if (status === wanted) resolve();
        else reject(ended());
      });
    });
  }

  private onStatusChange(listener: (status: ProviderStatus) => void) {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private pause(ms: number) {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.kick = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}

export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return error ? String(error) : "";
}

function definedFields<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as Partial<T>;
}

function sameFolder(left: unknown, right: unknown) {
  return String(left || "").replace(/[/\\]+$/, "") === String(right || "").replace(/[/\\]+$/, "");
}

function resumesTurn(event: ReducerEvent) {
  if (event.type === "chunk") return event.role !== "user";
  if (event.type === "tool") return !event.status || LIVE_TOOL.has(event.status);
  return false;
}

function wrapTransport(transport: Transport, beforeClose: () => void): Transport {
  return {
    send(value) {
      transport.send(value);
    },
    close() {
      transport.close();
    },
    closed: transport.closed,
    setHandlers({ onMessage, onClose }) {
      transport.setHandlers({
        onMessage,
        onClose: () => {
          beforeClose();
          onClose();
        },
      });
    },
  };
}
