// The ChatGPT provider: the shared ACP client over stdio to @agentclientprotocol/codex-acp, which
// starts the installed codex's app-server and translates it into ACP. One adapter process holds
// every ChatGPT session. If it exits, the running turn ends with the error, a new adapter starts,
// and the open sessions come back with session/load.
//
// Login stays in Codex. This provider never reads, stores or passes a token: the adapter runs the
// installed codex (CODEX_PATH) with the user's environment, and codex keeps its own login in its
// home folder. Signed out, the app says to run codex login in a terminal.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { messageOf, type AcpOptions } from "../acp.ts";
import { AdapterClient, adapterEntry as entryOf, adapterEnvironment, stderrTail } from "../adapter.ts";
import type { PromptBlock } from "../attachments.ts";
import { commandVersion } from "../command.ts";
import { fields, isRecord, listOf, maybe } from "../lenient.ts";
import type { ConfigOption, Image, Translated } from "../protocol.ts";
import type { AccountUsage, Capabilities, Detected, Mode, ModeChoice, ModelCatalog, ModelChoice, NewSession, Provider, SessionToolGrant, SideAnswer, SideEntry } from "../provider.ts";
import type { ReducerEvent } from "../reducer.ts";
import type { RpcNotification, RpcRequest } from "../rpc.ts";
import { nodeStdioAgent, spawnStdioAgent } from "../stdio.ts";
import { readRateLimits, usageFromRateLimits, type AppServerCommand } from "./usage.ts";
import { codexSkillText } from "./skills.ts";
import { codexFacts } from "./tools.ts";
import type { ToolCall, ToolFacts } from "../tools.ts";

// Codex's own name for each of the app's modes but plan. Codex's modes are approval and sandbox presets:
// read-only asks before every edit, workspace-write edits the folder without asking, agent (Auto review)
// asks only for what Codex judges unsafe, and agent-full-access never asks. Plan is not one of them:
// it is Codex's collaboration mode, which runs on top of whichever preset the session has.
const TO_CODEX: Record<Exclude<Mode, "plan">, string> = {
  ask: "read-only",
  acceptEdits: "workspace-write",
  auto: "agent",
  full: "agent-full-access",
};

const CHATGPT_MODES: readonly ModeChoice[] = [
  { id: "ask", name: "Ask first" },
  { id: "acceptEdits", name: "Accept edits" },
  { id: "plan", name: "Plan" },
  { id: "auto", name: "Auto" },
  { id: "full", name: "Always approve" },
];

// Codex lists its newest models first. The rest are folded under "More models".
const RECENT_MODELS = 4;

// The config ids the adapter uses. The approval menu covers mode and collaboration_mode.
const MODE_OPTION = "mode";
const COLLABORATION_OPTION = "collaboration_mode";
const EFFORT_OPTION = "reasoning_effort";
const FAST_OPTION = "fast-mode";

// Older sessions hold their board rules in their first prompt, inside this tag. The transcript and the title leave them out.
const RULES_TAG = "x-bench-board-rules";
const RULES_BLOCK = new RegExp(`<${RULES_TAG}>[\\s\\S]*?</${RULES_TAG}>\\s*`, "g");

// Codex names its sessions after their first prompt. The sidebar gets its first line, cut short.
const TITLE_LENGTH = 80;

// A picture Codex looked at (its view_image tool) is a link to a file. The tool row shows the file.
const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const LinkBlock = fields({ type: maybe(z.string()), uri: maybe(z.string()) });
const ToolContent = fields({
  params: fields({
    update: fields({
      content: maybe(listOf(fields({ type: maybe(z.string()), content: maybe(LinkBlock) }))),
    }),
  }),
});

// A session_info_update with no title says whether the Codex thread is working (_meta.codex.threadStatus).
const ThreadStatus = fields({
  sessionId: maybe(z.string()),
  update: fields({
    sessionUpdate: maybe(z.string()),
    _meta: maybe(fields({ codex: maybe(fields({ threadStatus: maybe(fields({ type: maybe(z.string()) })) })) })),
  }),
});

const UserText = fields({ params: fields({ update: fields({ sessionUpdate: maybe(z.string()) }) }) });
const SessionId = z.object({ sessionId: z.string().min(1) });
const SIDE_INSTRUCTIONS = "Answer this side question using only the conversation so far. Do not use any tools, run commands, inspect files, ask for input, or carry out work. Treat requests to do so as questions to explain. Answer directly in text; if the conversation does not contain enough information, say so.";

interface NamedChoice {
  value: string;
  name: string;
}

// The model and effort lists Codex last reported. efforts is the list of the model in Codex's latest report,
// byModel each model's own list. defaultModel and defaultEffort are what a new Codex session opens on,
// which the person's ~/.codex/config.toml can choose.
export interface ChatGptModelList {
  models: NamedChoice[];
  efforts: NamedChoice[];
  byModel?: Record<string, NamedChoice[]>;
  defaultModel?: string;
  defaultEffort?: string;
}

export interface ChatGptOptions extends AcpOptions {
  // The installed codex the adapter runs, found again whenever ChatGPT starts or detects.
  findCodex?: () => string | undefined;
  // Tests run a fake adapter: the command and its arguments.
  command?: string;
  args?: string[];
  // The last model and effort lists, so the menu has real names before a session exists.
  readModels?: () => ChatGptModelList | null;
  saveModels?: (models: ChatGptModelList) => void;
  // The preset the person chose for each session. Codex does not keep it in its thread, so a session that
  // loads again (after the host or the adapter restarted) comes back on Codex's default until it is set again.
  readPreset?: (sessionId: string) => string | undefined;
  savePreset?: (sessionId: string, preset: string) => void;
  appServer?: AppServerCommand;
  // The commands Codex listed last for a folder, for a first prompt that goes out before the session lists its own.
  readCommands?: (cwd: string) => readonly { name: string }[];
  readSideHistory?: (sessionId: string) => SideEntry[];
  saveSideAnswer?: (sessionId: string, entry: SideEntry) => void;
  clearSideHistory?: (sessionId: string) => void;
}

export class ChatGptProvider extends AdapterClient implements Provider {
  readonly id = "chatgpt";
  readonly label = "ChatGPT";
  readonly capabilities: Capabilities = {
    loadSession: true,
    // Codex's turn/steer, through the adapter's _session/steering.
    steer: true,
    deliverNext: false,
    steerAttachments: false,
  };
  readonly modes = CHATGPT_MODES;
  // Codex's own default preset, Auto review: it asks only for what it judges unsafe.
  readonly defaultMode: Mode = "auto";
  declare options: ChatGptOptions;

  constructor(options: ChatGptOptions = {}) {
    // A first Codex start can take long (updating its model list), so both waits get two minutes.
    super({ initTimeoutMs: 120000, readyTimeoutMs: 120000, ...options });
  }

  // The codex this start found. Every restart of the adapter until the next start() runs the same one.
  private codexPath: string | null = null;
  // Each session's Codex preset (read-only, workspace-write, agent, agent-full-access) and collaboration
  // mode (default or plan), as Codex last reported them.
  private preset = new Map<string, string>();
  private collaboration = new Map<string, string>();
  // Sessions whose config Codex has reported. The first report of a new session shows what Codex opens a session on.
  private configSeen = new Set<string>();
  // Presets being set again after a load. Every load (a reopen, or a reload after the adapter restarted)
  // waits for it, so the session answers on the chosen preset and no held message reaches Codex before.
  private restoring = new Map<string, Promise<void>>();
  // Concurrent refreshes share one read; a sign-in change and stop invalidate its generation.
  private readingUsage: Promise<AccountUsage | null | undefined> | null = null;
  private usageReads = 0;
  private usageListeners = new Set<() => void>();
  private sideForks = new Map<string, { answer: string; plan: string; usedTool: boolean }>();
  private sideClears = new Map<string, object>();

  async detect(): Promise<Detected> {
    if (!this.options.command && !adapterEntry()) {
      return { installed: false, version: null, signedIn: null, message: "The ChatGPT adapter is missing. Run npm install." };
    }
    const codex = this.options.command ? "test" : this.findCodex();
    const version = this.options.command ? "test" : codex ? await commandVersion(codex, ["--version"]) : null;
    if (!codex || version === null) {
      return { installed: false, version: null, signedIn: null, message: "Codex is not installed. Install the codex CLI to use ChatGPT models.", command: "npm install -g @openai/codex" };
    }
    const status = this.options.command ? null : await loginStatus(codex);
    if (status !== null) this.signedIn = status;
    return {
      installed: true,
      version,
      signedIn: this.signedIn,
      account: this.signedIn && this.accountLabel ? this.accountLabel : null,
      message: this.signedIn === false ? SIGN_IN : null,
      command: this.signedIn === false ? "codex login" : null,
    };
  }

  private findCodex() {
    return this.options.findCodex?.() ?? undefined;
  }

  models(): ModelCatalog {
    const cached = this.options.readModels?.() ?? null;
    const listed = cached?.models ?? [];
    const general = cached?.efforts ?? [];
    // Before Codex has ever reported its models, the menu offers the one Codex's own config picks.
    const named = listed.length ? listed : [{ value: "default", name: "Default" }];
    const models: ModelChoice[] = named.map((model, index) => {
      const efforts = cached?.byModel?.[model.value] ?? general;
      const preferred = [cached?.defaultEffort, "high", "medium"].find((value) => value && efforts.some((effort) => effort.value === value));
      return {
        value: model.value,
        name: modelName(model.name || model.value),
        defaultEffort: preferred ?? efforts[0]?.value ?? "",
        efforts,
        ...(index >= RECENT_MODELS ? { older: true } : {}),
      };
    });
    const defaultModel = models.find((model) => model.value === cached?.defaultModel)?.value ?? models[0]?.value ?? "";
    return { defaultModel, defaultEffort: "", models };
  }

  // Codex is asked even while the app thinks it is signed out, since a sign-in in a terminal may not reach the adapter.
  async accountUsage() {
    const codex = this.codexPath ?? this.findCodex();
    const server = this.options.appServer ?? (codex ? { command: codex, args: ["app-server"] } : null);
    if (!server) return null;
    if (this.readingUsage) return this.readingUsage;
    const read = this.usageReads;
    const reading = readRateLimits(server)
      .then((answer) => {
        if (read !== this.usageReads || answer.kind === "unreachable") return undefined;
        return answer.kind === "answer" ? usageFromRateLimits(answer.result, this.accountLabel) : null;
      })
      .finally(() => {
        if (this.readingUsage === reading) this.readingUsage = null;
      });
    this.readingUsage = reading;
    return reading;
  }

  onUsageChange(listener: () => void) {
    this.usageListeners.add(listener);
    return () => this.usageListeners.delete(listener);
  }

  protected override authChanged() {
    this.invalidateUsage();
    for (const listener of this.usageListeners) listener();
  }

  private invalidateUsage() {
    this.usageReads += 1;
    this.readingUsage = null;
  }

  override async stop() {
    this.invalidateUsage();
    await super.stop();
  }

  // ---- Reaching the adapter ----

  protected override async prepare() {
    if (this.options.connect || this.options.command) return;
    if (!adapterEntry()) throw new Error("The ChatGPT adapter is missing. Run npm install.");
    const codex = this.findCodex();
    if (!codex) throw new Error("Codex is not installed. Install the codex CLI to use ChatGPT models.");
    this.codexPath = codex;
  }

  protected override async connectTransport() {
    if (this.options.connect) return this.options.connect();
    await this.agent?.stop();
    const codex = this.codexPath ?? this.findCodex();
    const env = adapterEnvironment({ ...(codex ? { CODEX_PATH: codex } : {}), CODEX_CONFIG });
    const agent = this.options.command ? spawnStdioAgent({ command: this.options.command, args: this.options.args ?? [], env }) : nodeStdioAgent(adapterEntry() ?? "", env);
    this.agent = agent;
    agent.exited.then(() => {
      if (this.agent === agent && !this.stopped) this.lastError = new Error(`ChatGPT stopped${stderrTail(agent.stderrTail())}`);
    });
    return agent.transport;
  }

  // ---- Codex's names for modes and config ----

  protected override modeToAgent(mode: Mode) {
    return TO_CODEX[mode === "plan" ? "auto" : mode];
  }

  protected override modeFromAgent(modeId: string | null): Mode | null {
    if (!modeId) return null;
    return (Object.keys(TO_CODEX) as Exclude<Mode, "plan">[]).find((mode) => TO_CODEX[mode] === modeId) ?? null;
  }

  // Plan switches Codex's collaboration mode and keeps the preset. Any other mode leaves plan and sets the preset.
  override async setMode(sessionId: string, mode: Mode) {
    this.require(sessionId);
    const planning = mode === "plan";
    if (planning !== (this.collaboration.get(sessionId) === "plan")) {
      await this.setConfig(sessionId, COLLABORATION_OPTION, planning ? "plan" : "default");
    }
    if (mode !== "plan") {
      await this.rpc.request("session/set_mode", { sessionId, modeId: TO_CODEX[mode] });
      this.preset.set(sessionId, TO_CODEX[mode]);
      try {
        this.options.savePreset?.(sessionId, TO_CODEX[mode]);
      } catch {
        // The session keeps its preset now. A later reload falls back to Codex's default.
      }
    }
    this.apply(sessionId, { type: "mode", modeId: mode });
    return this.sessionMap.get(sessionId);
  }

  // While Codex plans, the session's mode is plan, whatever preset Codex reports under it.
  protected override apply(sessionId: string, event: ReducerEvent) {
    const planning = this.collaboration.get(sessionId) === "plan";
    super.apply(sessionId, event.type === "mode" && planning && event.modeId !== "plan" ? { ...event, modeId: "plan" } : event);
  }

  // The approval menu covers the preset and plan, so the option menus leave them out. Fast mode uses the plan
  // faster, so it stays out of the menus while it is off, and shows while it is on, so it can be switched off.
  protected override configFromAgent(options: ConfigOption[]) {
    return options
      .filter((option) => option.id !== MODE_OPTION && option.id !== COLLABORATION_OPTION && (option.id !== FAST_OPTION || option.currentValue === "on"))
      .map((option) => {
        if (option.id === EFFORT_OPTION) return { ...option, id: "effort" };
        if (option.id === "model" && option.options) {
          return { ...option, options: option.options.map((choice, index) => ({ ...choice, name: modelName(choice.name || choice.value), ...(index >= RECENT_MODELS ? { older: true } : {}) })) };
        }
        return option;
      });
  }

  protected override configToAgent(key: string) {
    return key === "effort" ? EFFORT_OPTION : key;
  }

  // The host's trusted tools run without Codex's own prompt. The patched adapter adds a server's
  // _meta["x-bench/codex"] to Codex's config for that server.
  protected override mcpServers(tools?: SessionToolGrant): unknown[] {
    return (tools?.servers ?? []).map((server) => {
      const trusted = (tools?.trusted ?? []).filter((tool) => tool.server === server.name);
      if (!trusted.length) return server;
      return { ...server, _meta: { "x-bench/codex": { tools: Object.fromEntries(trusted.map((tool) => [tool.tool, { approval_mode: "approve" }])) } } };
    });
  }

  protected override onAgentConfig(sessionId: string, options: ConfigOption[]) {
    const preset = options.find((option) => option.id === MODE_OPTION)?.currentValue;
    const collaboration = options.find((option) => option.id === COLLABORATION_OPTION)?.currentValue;
    if (typeof preset === "string") this.preset.set(sessionId, preset);
    if (typeof collaboration === "string") this.collaboration.set(sessionId, collaboration);
    // A loaded session replays first. A config report for a session never seen and not loading is a new one's.
    const opening = !this.configSeen.has(sessionId) && !this.replaying.has(sessionId);
    this.configSeen.add(sessionId);
    this.rememberModels(options, opening);
    if (this.replaying.has(sessionId)) this.restorePreset(sessionId);
    // Codex can switch plan on and off itself (its /plan command), so the approval menu follows its report.
    const session = this.sessionMap.get(sessionId);
    if (!session || (typeof preset !== "string" && typeof collaboration !== "string")) return;
    const mode = this.collaboration.get(sessionId) === "plan" ? "plan" : this.modeFromAgent(this.preset.get(sessionId) ?? null);
    if (mode && session.modeId !== mode) this.apply(sessionId, { type: "mode", modeId: mode });
  }

  // A session that loads again comes back on Codex's default preset. The one the person chose is set again,
  // under plan too, so a plan approved after a restart is carried out with the approvals they picked.
  private restorePreset(sessionId: string) {
    const wanted = this.options.readPreset?.(sessionId);
    const reported = this.preset.get(sessionId);
    if (!wanted || !reported || wanted === reported || !Object.values(TO_CODEX).includes(wanted)) return;
    this.preset.set(sessionId, wanted);
    const restored = this.rpc
      .request("session/set_mode", { sessionId, modeId: wanted }, 30000)
      .then(() => {
        // A mode the person picked meanwhile wins.
        if (!this.sessionMap.has(sessionId) || this.preset.get(sessionId) !== wanted) return;
        const mode = this.collaboration.get(sessionId) === "plan" ? "plan" : this.modeFromAgent(wanted);
        if (mode) this.apply(sessionId, { type: "mode", modeId: mode });
      })
      .catch(() => {
        // Codex keeps its default. The approval menu shows what Codex reported, unless the person picked one meanwhile.
        if (this.preset.get(sessionId) !== wanted) return;
        this.preset.set(sessionId, reported);
        const mode = this.collaboration.get(sessionId) === "plan" ? "plan" : this.modeFromAgent(reported);
        if (mode && this.sessionMap.has(sessionId)) this.apply(sessionId, { type: "mode", modeId: mode });
      })
      .finally(() => {
        if (this.restoring.get(sessionId) === restored) this.restoring.delete(sessionId);
      });
    this.restoring.set(sessionId, restored);
  }

  // The model and effort lists, kept for the menu of the next new chat, with the current model's effort levels.
  private rememberModels(options: ConfigOption[], defaults: boolean) {
    const choices = (id: string) =>
      (options.find((option) => option.id === id)?.options ?? []).map((choice) => ({ value: choice.value, name: choice.name || choice.value }));
    const models = choices("model");
    if (!models.length || !this.options.saveModels) return;
    const efforts = choices(EFFORT_OPTION);
    const current = (id: string) => {
      const value = options.find((option) => option.id === id)?.currentValue;
      return typeof value === "string" && value ? value : undefined;
    };
    const previous = this.options.readModels?.() ?? null;
    const model = current("model");
    const byModel = { ...previous?.byModel };
    if (model) byModel[model] = efforts;
    const defaultModel = defaults ? model : previous?.defaultModel;
    const defaultEffort = defaults ? current(EFFORT_OPTION) : previous?.defaultEffort;
    try {
      this.options.saveModels({ models, efforts, byModel, ...(defaultModel ? { defaultModel } : {}), ...(defaultEffort ? { defaultEffort } : {}) });
    } catch {
      // The menu keeps the list it had.
    }
  }

  // Codex writes its plan in plan mode as a plan item. A client that shows plans gets it as plan_update, the
  // whole markdown text each time it grows, which the Plan tab shows and the transcript keeps as one reply.
  // Without this the adapter sends it as ordinary reply text.
  // subagents makes the adapter run each Codex subagent in a session of its own, whose steps fold under its row.
  protected override initializeParams() {
    const params = super.initializeParams();
    return { ...params, clientCapabilities: { ...params.clientCapabilities, plan: {}, subagents: {} } };
  }

  // ---- Sessions ----

  // A load sends the rules again: a restarted adapter resumes the thread without them.
  protected override newSessionParams(options: NewSession, tools?: SessionToolGrant) {
    return systemPrompt(this.withToolLine(options.rules, tools));
  }

  protected override loadSessionParams(sessionId: string, tools?: SessionToolGrant) {
    return systemPrompt(this.withToolLine(this.sessionRules.get(sessionId), tools));
  }

  protected override async afterReload(sessionId: string) {
    await this.restoring.get(sessionId);
  }

  protected override promptBlocks(sessionId: string, sent: PromptBlock[]): PromptBlock[] {
    const [head, ...tail] = sent;
    return head?.type === "text" ? [{ ...head, text: this.skillText(sessionId, head.text) }, ...tail] : sent;
  }

  private skillText(sessionId: string, text: string) {
    const session = this.sessionMap.get(sessionId);
    const listed = session?.commands.length ? session.commands : session ? (this.options.readCommands?.(session.cwd) ?? []) : [];
    return codexSkillText(text, listed.flatMap((command) => (command.name ? [command.name] : [])));
  }

  // Codex has no queue of its own: a second session/prompt would replace the running one's turn. A message
  // sent during a turn waits in the shared client's queue.
  protected override queuesPrompts() {
    return false;
  }

  override async forgetSession(sessionId: string) {
    this.sideClears.delete(sessionId);
    this.preset.delete(sessionId);
    this.collaboration.delete(sessionId);
    this.configSeen.delete(sessionId);
    await super.forgetSession(sessionId);
  }

  // Codex keeps a deleted session in its archive (thread/archive), out of its session list.
  async deleteSession(sessionId: string) {
    this.assertReady();
    await this.rpc.request("session/delete", { sessionId }, 30000);
  }

  protected override async listSessions(cwd?: string) {
    return (await super.listSessions(cwd)).filter((entry) => !entry.sessionId || !this.sideForks.has(entry.sessionId));
  }

  async sideQuestion(sessionId: string, question: string): Promise<SideAnswer> {
    const session = this.require(sessionId);
    const text = question.trim();
    if (!text) throw new Error("Ask a question first");
    const clears = this.sideClears.get(sessionId) ?? {};
    this.sideClears.set(sessionId, clears);
    const fork = SessionId.parse(await this.rpc.request("session/fork", {
      sessionId,
      cwd: session.cwd,
      mcpServers: [],
      _meta: { "x-bench/sideQuestion": true },
      ...systemPrompt(SIDE_INSTRUCTIONS),
    }, 120000));
    const reply = { answer: "", plan: "", usedTool: false };
    this.sideForks.set(fork.sessionId, reply);
    let answer: string;
    try {
      await this.rpc.request("session/set_mode", { sessionId: fork.sessionId, modeId: "read-only" }, 30000);
      await this.rpc.request("session/set_config_option", { sessionId: fork.sessionId, configId: COLLABORATION_OPTION, value: "plan" }, 30000);
      await this.rpc.request("session/prompt", {
        sessionId: fork.sessionId,
        prompt: [{ type: "text", text: `${SIDE_INSTRUCTIONS}\n\nSide question:\n${text}` }],
      }, 300000);
      if (reply.usedTool) throw new Error("ChatGPT tried to use a tool for the side question. Ask again.");
      answer = (reply.plan || reply.answer).trim();
      if (!answer) throw new Error("ChatGPT gave no answer. Ask again.");
    } finally {
      try {
        await this.rpc.request("session/delete", { sessionId: fork.sessionId }, 30000);
      } finally {
        this.sideForks.delete(fork.sessionId);
      }
    }
    const entry = { id: randomUUID(), question: text, answer, askedAt: new Date().toISOString() };
    if (this.sessionMap.has(sessionId) && this.sideClears.get(sessionId) === clears) this.options.saveSideAnswer?.(sessionId, entry);
    return { id: entry.id, answer };
  }

  sideHistory(sessionId: string) {
    return this.sessionMap.has(sessionId) ? (this.options.readSideHistory?.(sessionId) ?? []) : [];
  }

  clearSideHistory(sessionId: string) {
    if (!this.sessionMap.has(sessionId)) return;
    this.sideClears.set(sessionId, {});
    this.options.clearSideHistory?.(sessionId);
  }

  protected override handleRequest(message: RpcRequest) {
    const target = SessionId.safeParse(message.params);
    if (!target.success || !this.sideForks.has(target.data.sessionId)) return super.handleRequest(message);
    if (message.method === "session/request_permission") this.rpc.respond(message.id, { outcome: { outcome: "cancelled" } });
    else if (message.method === "elicitation/create") this.rpc.respond(message.id, { action: "decline" });
    else this.rpc.respondError(message.id, -32601, `not implemented: ${message.method}`);
    return true;
  }

  // ---- Codex's updates ----

  protected override toolFacts(tool: ToolCall): ToolFacts {
    return codexFacts(tool);
  }

  protected override translate(message: unknown): Translated | null {
    const translated = super.translate(message);
    if (!translated) return translated;
    const event = translated.event;
    if (event.type === "tool" && !event.images?.length) {
      const images = viewedImages(message);
      if (images.length) event.images = images;
    }
    // Codex asks to leave plan mode through a permission on this tool call, whose updates carry no title.
    if (event.type === "tool" && event.toolCallId?.startsWith("plan-review:") && !event.title) event.title = "Plan review";
    if (event.type === "catalog") {
      for (const entry of event.upserted) {
        if (typeof entry.title === "string") entry.title = shortTitle(entry.title);
      }
    }
    if (event.type === "chunk" && event.role === "user" && UserText.parse(message).params.update.sessionUpdate === "user_message_chunk") {
      const text = withoutRules(event.text);
      // A chunk that held only the rules (as a session from before they shared the prompt's block) shows nothing.
      if (!text.trim() && event.text.trim() && !event.images?.length) return null;
      event.text = text;
    }
    return translated;
  }

  // A turn Codex started by itself (a steer that came just after the turn ended) has no prompt of this
  // app's to end it. It ends when Codex says the thread is idle again.
  protected override handleNotification(message: RpcNotification) {
    const target = SessionId.safeParse(message.params);
    const side = target.success ? this.sideForks.get(target.data.sessionId) : undefined;
    if (side && target.success) {
      const event = super.translate(message)?.event;
      if (event?.type === "chunk" && event.role === "assistant") side.answer += event.text;
      if (event?.type === "plan-doc") side.plan = event.text;
      if (event?.type === "tool") {
        side.usedTool = true;
        this.rpc.notify("session/cancel", { sessionId: target.data.sessionId });
      }
      return true;
    }
    if (super.handleNotification(message)) return true;
    if (message.method !== "session/update") return false;
    const { sessionId, update } = ThreadStatus.parse(message.params);
    if (update.sessionUpdate !== "session_info_update" || update._meta?.codex?.threadStatus?.type !== "idle" || !sessionId) return false;
    const session = this.sessionMap.get(sessionId);
    if (session?.status === "running" && !this.ownsTurn(sessionId) && !this.replaying.has(sessionId)) {
      queueMicrotask(() => {
        if (this.sessionMap.get(sessionId)?.status === "running" && !this.ownsTurn(sessionId)) {
          this.apply(sessionId, { type: "turn-finished", stopReason: "end_turn" });
        }
      });
    }
    return false;
  }

  // A message typed during a turn joins it (Codex's turn/steer). When the turn has just ended, the
  // adapter starts a new turn with it. The adapter never echoes a steered message live, so the
  // transcript adds it here.
  async steer(sessionId: string, text: string) {
    const session = this.require(sessionId);
    if (session.status !== "running") return this.followUp(sessionId, text);
    const result = await this.rpc.request("_session/steering", { sessionId, prompt: [{ type: "text", text: this.skillText(sessionId, text) }] });
    // The adapter answers a steer it could not deliver with this outcome, not an error.
    if (isRecord(result) && result.outcome === "failed") throw new Error("Codex could not take the message. Send it again once the turn ends.");
    if (isRecord(result) && result.outcome === "startedNewTurn") {
      const current = this.sessionMap.get(sessionId);
      if (current && current.status !== "running") this.apply(sessionId, { type: "begin-turn" });
    }
    if (isRecord(result) && (result.outcome === "injected" || result.outcome === "startedNewTurn")) this.apply(sessionId, { type: "user", text });
    return result;
  }

  protected override explainError(error: unknown) {
    // Only an explicit sign-in failure marks ChatGPT signed out. Another failure that mentions a 401 or
    // "auth" (an MCP server's, say) shows as itself.
    if (SIGNED_OUT.test(messageOf(error))) {
      this.signedIn = false;
      return SIGN_IN;
    }
    return this.adapterError("ChatGPT", error);
  }

  // lastError is the old adapter's exit, with its stderr. By now this.agent is the new one.
  protected override restartMessage() {
    const reason = messageOf(this.lastError);
    return `${reason || "ChatGPT stopped"}. It was started again.`;
  }
}

// Codex's settings for every thread. Codex offers request_user_input only in Plan mode unless this feature is on.
const CODEX_CONFIG = JSON.stringify({ features: { default_mode_request_user_input: true } });

// Login stays in Codex. The app only says where to sign in.
const SIGN_IN = "ChatGPT is not signed in. Run codex login in a terminal, then try again.";

// A signed-out turn: ACP's "Authentication required" (the adapter's RequestError.authRequired), or Codex
// saying in so many words that the account is not signed in or its login expired.
const SIGNED_OUT = /^Authentication required\b|\bnot (?:logged|signed) in\b|\b(?:log|sign) ?in (?:again|required)\b|\b(?:access|refresh) token (?:has )?expired\b/i;

// What `codex login status` says: true or false, or null when this codex has no such command.
// It prints one line on stderr ("Logged in using ChatGPT", "Not logged in"), and nothing else is kept.
function loginStatus(codex: string): Promise<boolean | null> {
  return new Promise((resolve) => {
    execFile(codex, ["login", "status"], { timeout: 8000 }, (error, stdout, stderr) => {
      const said = `${stdout}\n${stderr}`;
      if (/not logged in/i.test(said)) resolve(false);
      else if (!error && /logged in/i.test(said)) resolve(true);
      else resolve(null);
    });
  });
}

// "6.1 Sol" reads as a version number in a menu of several providers.
function modelName(name: string) {
  return /^\d/.test(name) ? `GPT-${name}` : name;
}

function systemPrompt(text: string) {
  return text ? { systemPrompt: { mode: "append", content: [{ type: "text", text }] } } : {};
}

function withoutRules(text: string) {
  return text.replace(RULES_BLOCK, "");
}

function shortTitle(title: string) {
  const line = withoutRules(title).trim().split("\n")[0]?.trim() ?? "";
  if (line.length <= TITLE_LENGTH) return line;
  const cut = line.slice(0, TITLE_LENGTH - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > TITLE_LENGTH / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

// The pictures a tool call links to by file: Codex's view_image names the file it looked at. Only
// pictures by their extension, at most 8 MB each. A file that is gone by now shows nothing.
function viewedImages(message: unknown): Image[] {
  const found: Image[] = [];
  for (const block of ToolContent.parse(message).params.update.content ?? []) {
    const link = block.content;
    if (block.type !== "content" || link?.type !== "resource_link" || !link.uri) continue;
    const file = link.uri.startsWith("file:") ? safeFilePath(link.uri) : link.uri;
    if (!file || !path.isAbsolute(file) || !IMAGE_TYPES[path.extname(file).toLowerCase()]) continue;
    try {
      // A picture under its real name too, so a link named .png cannot put another kind of file on the row.
      const real = realpathSync(file);
      const mimeType = IMAGE_TYPES[path.extname(real).toLowerCase()];
      if (!mimeType) continue;
      const stat = statSync(real);
      if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) continue;
      const data = readFileSync(real).toString("base64");
      if (!found.some((image) => image.data === data)) found.push({ mimeType, data });
    } catch {
      // Gone or unreadable.
    }
  }
  return found;
}

function safeFilePath(uri: string) {
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

// The adapter's entry script inside node_modules, run with node.
function adapterEntry(): string | null {
  return entryOf("@agentclientprotocol/codex-acp");
}
