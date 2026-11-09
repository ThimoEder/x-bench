// The Claude provider: the shared ACP client over stdio to @agentclientprotocol/claude-agent-acp,
// which runs Claude Code through Anthropic's Agent SDK. One adapter process holds every Claude
// session. If it exits, the running turn ends with the error, a new adapter starts, and the open
// sessions come back with session/load.
//
// Login stays in Claude Code. This provider never reads, stores or passes a token: the adapter
// runs the installed claude binary with the user's environment, plus the config folder the user
// chose (CLAUDE_CONFIG_DIR), and reports whether that account is signed in.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { z } from "zod";
import { messageOf, type AcpOptions } from "../acp.ts";
import { AdapterClient, adapterEntry as entryOf, adapterEnvironment, stderrTail } from "../adapter.ts";
import { collapseHome } from "../home.ts";
import { composePrompt, type PromptBlock } from "../attachments.ts";
import { fields, isRecord, maybe } from "../lenient.ts";
import { SetConfigResult, type BackgroundTask, type ConfigOption, type Translated } from "../protocol.ts";
import type {
  AccountUsage,
  Capabilities,
  Detected,
  Mode,
  ModeChoice,
  ModelCatalog,
  ModelChoice,
  NewSession,
  Provider,
  SessionToolGrant,
  SideAnswer,
  SideEntry,
  SteerOptions,
  SteerTiming,
} from "../provider.ts";
import type { ReducerEvent } from "../reducer.ts";
import type { RpcNotification } from "../rpc.ts";
import type { ToolCall, ToolFacts } from "../tools.ts";
import { nodeStdioAgent, spawnStdioAgent } from "../stdio.ts";
import { commandVersion } from "../command.ts";
import { readClaudeUsage, usageFromAnswer, usageFromRateLimit, type ClaudeCode } from "./usage.ts";
import { claudeFacts } from "./tools.ts";

// The adapter's own name for each of the app's modes. Always approve is full, which is
// bypassPermissions: the same promise as Grok's agent mode. Claude's auto, where Claude
// decides what to ask, is its own entry. Safety checks can still ask under bypassPermissions.
const TO_CLAUDE: Record<Mode, string> = {
  ask: "default",
  acceptEdits: "acceptEdits",
  plan: "plan",
  auto: "auto",
  full: "bypassPermissions",
};

// Claude lists its newest models first. The rest are folded under "More models".
const RECENT_MODELS = 4;

// The adapter's info logs share stderr with its errors: "[session/create] sessionId=… phase=…" and "[authStatus] …".
export const INFO_LOG = /^\[(authStatus\]|[\w/-]+\] \w+=)/;

// Marks every model after the first few as older, in a list as Claude ordered it.
function markOlder<T extends { value: string }>(choices: T[]): (T & { older?: boolean })[] {
  let seen = 0;
  return choices.map((choice) => {
    if (choice.value === "default") return choice;
    seen += 1;
    return seen > RECENT_MODELS ? { ...choice, older: true } : choice;
  });
}

// A refresh right after a turn takes the figures Claude just sent instead of starting Claude Code.
const SENT_USAGE_FRESH_MS = 60_000;

const CLAUDE_MODES: readonly ModeChoice[] = [
  { id: "ask", name: "Ask first" },
  { id: "acceptEdits", name: "Accept edits" },
  { id: "plan", name: "Plan" },
  { id: "auto", name: "Auto" },
  { id: "full", name: "Always approve" },
];

const UsageUpdate = fields({
  params: fields({
    sessionId: maybe(z.string()),
    update: fields({
      sessionUpdate: maybe(z.string()),
      // Claude sends the cost when a turn ends, also a turn it started itself.
      cost: z.unknown().optional(),
      _meta: maybe(z.looseObject({ "_claude/rateLimit": z.unknown().optional() })),
    }),
  }),
});

// The tool Claude Code ran, and the subagent's tool call it ran in, which the adapter names in _meta.
const ToolName = fields({
  params: fields({
    update: fields({
      _meta: maybe(fields({ claudeCode: maybe(fields({ toolName: maybe(z.string()), parentToolUseId: maybe(z.string()) })) })),
    }),
  }),
});

type UsageFields = z.output<typeof UsageUpdate>["params"]["update"];

// What `claude auth status --json` says. Only these fields are kept: whether the account is
// signed in, and how to name it on the settings page.
const AuthReport = fields({ loggedIn: maybe(z.boolean()), email: maybe(z.string()), subscriptionType: maybe(z.string()) });

// The adapter's _session/btw reply. response is null when Claude Code gave no answer.
const SideReply = fields({ response: maybe(z.string()) });

// Claude Code reports each message it was sent by uuid: queued, started (Claude took it in), then completed.
const CommandLifecycle = fields({
  sessionId: maybe(z.string()),
  message: fields({ type: maybe(z.string()), state: maybe(z.string()), command_uuid: maybe(z.string()) }),
});

// started and completed mean Claude took the message in. cancelled and discarded mean it never will.
const DELIVERY_OF_LIFECYCLE: Partial<Record<string, "read" | "unread">> = {
  started: "read",
  completed: "read",
  cancelled: "unread",
  discarded: "unread",
};

// A steered message Claude has not read yet, kept so Send now can send the same prompt again.
interface WaitingSteer {
  sessionId: string;
  text: string;
  attachments: unknown;
  blocks: PromptBlock[];
}

interface NamedChoice {
  value: string;
  name: string;
}

// The model and effort lists Claude last reported. efforts is the list of the model in Claude's latest report.
// byModel keeps each model's own list as Claude reports it, since the levels differ by model (Haiku has none).
export interface ClaudeModelList {
  models: NamedChoice[];
  efforts: NamedChoice[];
  byModel?: Record<string, NamedChoice[]>;
}

// The model, effort and permission mode of one thread, in Claude's own names. Claude forgets them on session/load.
export interface ClaudeThreadPicks {
  model?: string;
  effort?: string;
  mode?: string;
}

// How Claude runs: the settings page's choices, read again each time they matter.
export interface ClaudeRunSettings {
  // The Claude config folder, as CLAUDE_CONFIG_DIR. Unset keeps whatever the environment has.
  configDir?: string;
  // The claude binary the adapter runs, as CLAUDE_CODE_EXECUTABLE.
  executable?: string;
  // Why Claude cannot start with these settings (a settings file that does not read).
  problem?: string;
}

export interface ClaudeOptions extends AcpOptions, Omit<ClaudeRunSettings, "problem"> {
  // The current settings. Without it, the fields above are used.
  readSettings?: () => ClaudeRunSettings;
  // True while the host's own plan tool keeps the step list.
  hostPlans?: () => boolean;
  // Tests run a fake adapter: the command and its arguments.
  command?: string;
  args?: string[];
  // Tests answer usage reads with a fake Claude Code at this path. A fake adapter without one reads nothing.
  claudeCode?: string;
  // The last model and effort lists, so the menu has real names before a session exists.
  readModels?: () => ClaudeModelList | null;
  saveModels?: (models: ClaudeModelList) => void;
  // Where each thread's choices are kept.
  readPicks?: (sessionId: string) => ClaudeThreadPicks | null;
  savePicks?: (sessionId: string, picks: ClaudeThreadPicks) => void;
  // Where side questions and their answers are kept, by session.
  readSideHistory?: (sessionId: string) => SideEntry[];
  saveSideAnswer?: (sessionId: string, entry: SideEntry) => void;
  clearSideHistory?: (sessionId: string) => void;
}

export class ClaudeProvider extends AdapterClient implements Provider {
  readonly id = "claude";
  readonly label = "Claude";
  readonly capabilities: Capabilities = {
    loadSession: true,
    steer: true,
    // Claude Code reads a message of priority "next" at its next tool boundary (patches/ lets a steer ask for it).
    deliverNext: true,
    steerAttachments: true,
  };
  readonly modes = CLAUDE_MODES;
  // Claude decides what to ask. A new Claude session starts here unless the person picks another mode.
  readonly defaultMode: Mode = "auto";
  declare options: ClaudeOptions;

  constructor(options: ClaudeOptions = {}) {
    // A first Claude Code start can take long (installing, signing in), so both waits get two minutes.
    super({ initTimeoutMs: 120000, readyTimeoutMs: 120000, ...options });
    this.usage = null;
  }

  private usage: AccountUsage | null;
  private usageAt = 0;
  // The Claude account the figures belong to: its config folder and binary.
  private usageAccount = "";
  // Concurrent reads share one. Figures Claude sends, another account and stop make a read under way stale.
  private readingUsage: Promise<AccountUsage | null | undefined> | null = null;
  private usageReads = 0;
  private waitingSteers = new Map<string, WaitingSteer>();
  // Sessions with a request to switch fast mode off still out, so a config update meanwhile sends no second one.
  private turningFastOff = new Set<string>();
  // That request. A restore waits for it, so its answer cannot paint the defaults back over the choices.
  private fastOff = new Map<string, Promise<void>>();
  // The restore under way, so the reload can wait for it.
  private restoring = new Map<string, Promise<void>>();
  // A config report applied while fast mode is switched off. It still carries the model from before
  // the switch, so it is not saved as the thread's choice.
  private skipCapture = new Set<string>();
  // The settings this start checked. Every restart of the adapter until the next start() uses them, so a
  // settings file that breaks or changes meanwhile never moves the open chats to another account.
  private runSettings: ClaudeRunSettings | null = null;
  // Task notes that wait for the reply Claude is streaming to end, by session.
  private heldNotes = new Map<string, string[]>();
  // How often each session's side history was cleared, so an answer still on its way is not saved after a clear.
  private sideClears = new Map<string, number>();
  // The command the adapter started by itself, by session, while no prompt of this app's was open.
  private ownCommands = new Map<string, string>();

  async detect(): Promise<Detected> {
    const adapter = this.options.command ? this.options.command : adapterEntry();
    if (!adapter) {
      return { installed: false, version: null, signedIn: null, message: "The Claude adapter is missing. Run npm install." };
    }
    const settings = this.settings();
    const version = this.options.command ? "test" : await commandVersion(settings.executable || "claude", ["--version"]);
    if (version === null) {
      return { installed: false, version: null, signedIn: null, message: "Claude Code is not installed. Install claude to use Claude models.", command: "curl -fsSL https://claude.ai/install.sh | bash" };
    }
    const problem = settings.problem ?? this.folderProblem(settings);
    if (problem) return { installed: true, version, signedIn: null, message: problem };
    const report = this.options.command ? null : await this.authStatus(settings);
    if (typeof report?.loggedIn === "boolean") this.signedIn = report.loggedIn;
    const plan = report?.loggedIn && report.subscriptionType ? ` (${report.subscriptionType.charAt(0).toUpperCase()}${report.subscriptionType.slice(1)})` : "";
    return {
      installed: true,
      version,
      signedIn: this.signedIn,
      account: report?.loggedIn && report.email ? `${report.email}${plan}` : null,
      message: this.signedIn === false ? this.signInMessage() : null,
      command: this.signedIn === false ? this.signInCommand() : null,
    };
  }

  // Claude Code's own answer to whether the chosen account is signed in. It reads its login itself;
  // this app keeps only the fields in AuthReport. null when that claude has no such command.
  private authStatus(settings: ClaudeRunSettings): Promise<z.output<typeof AuthReport> | null> {
    return new Promise((resolve) => {
      execFile(settings.executable || "claude", ["auth", "status", "--json"], { env: this.environment(settings), timeout: 8000 }, (_error, stdout) => {
        try {
          resolve(AuthReport.parse(JSON.parse(String(stdout))));
        } catch {
          resolve(null);
        }
      });
    });
  }

  // The settings as they are now: the settings page can change them while the host runs.
  settings(): ClaudeRunSettings {
    if (this.options.readSettings) return this.options.readSettings();
    const { configDir, executable } = this.options;
    return { ...(configDir ? { configDir } : {}), ...(executable ? { executable } : {}) };
  }

  // A config folder that is not there would give Claude a new, signed-out account, never the one chosen.
  private folderProblem(settings: ClaudeRunSettings): string | null {
    if (!settings.configDir) return null;
    try {
      if (statSync(settings.configDir).isDirectory()) return null;
    } catch {
      // Missing.
    }
    return `Claude's config folder ${collapseHome(settings.configDir)} is missing. Choose another in Settings.`;
  }

  models(): ModelCatalog {
    const cached = this.options.readModels?.() ?? null;
    // "default" is Claude's per-model default level, not a level of its own, so a new chat picks a real one.
    const named = (list: NamedChoice[]) => list.filter((effort) => effort.value !== "default");
    const general = named(cached?.efforts ?? []);
    // "default" is the adapter's alias for whatever Claude Code picks. The menu lists the real models,
    // and falls back to the alias only before Claude has ever reported them.
    const listed = (cached?.models ?? []).filter((model) => model.value !== "default");
    const models: ModelChoice[] = markOlder(listed.length ? listed : [{ value: "default", name: "Default" }]).map((model) => {
      const own = cached?.byModel?.[model.value];
      const efforts = own ? named(own) : general;
      return {
        value: model.value,
        name: model.name || model.value,
        defaultEffort: efforts.some((effort) => effort.value === "high") ? "high" : (efforts[0]?.value ?? ""),
        efforts,
        ...(model.older ? { older: true } : {}),
      };
    });
    return { defaultModel: models[0]?.value ?? "", defaultEffort: "", models };
  }

  async accountUsage() {
    const source = this.usageSource();
    if (!source) return this.usage;
    if (source.account !== this.usageAccount) {
      this.invalidateUsage();
      this.usageAccount = source.account;
    }
    if (this.usage && Date.now() - this.usageAt < SENT_USAGE_FRESH_MS) return this.usage;
    if (this.readingUsage) return this.readingUsage;
    const read = this.usageReads;
    const reading = readClaudeUsage(source.claude)
      .then((answer) => {
        if (this.usageSource()?.account !== source.account) return null;
        if (read !== this.usageReads) return this.usage;
        if (answer.kind === "unreachable") return undefined;
        this.usage = answer.kind === "answer" ? usageFromAnswer(answer.result, this.accountLabel) : null;
        this.usageAt = Date.now();
        return this.usage;
      })
      .finally(() => {
        if (this.readingUsage === reading) this.readingUsage = null;
      });
    this.readingUsage = reading;
    return reading;
  }

  // The Claude Code that answers usage reads: the chats' own while they run, else the one the settings name.
  private usageSource(): { claude: ClaudeCode; account: string } | null {
    if (this.options.claudeCode) return { claude: { executable: this.options.claudeCode, env: adapterEnvironment() }, account: this.options.claudeCode };
    if (this.options.command || this.options.connect) return null;
    const running = this.status === "connecting" || this.status === "reconnecting" || this.status === "ready";
    const settings = (running && this.runSettings) || this.settings();
    if (settings.problem || this.folderProblem(settings)) return null;
    return {
      claude: { ...(settings.executable ? { executable: settings.executable } : {}), env: this.environment(settings) },
      account: `${settings.configDir ?? ""}\0${settings.executable ?? ""}`,
    };
  }

  private invalidateUsage() {
    this.usageReads += 1;
    this.usage = null;
    this.readingUsage = null;
  }

  override async stop() {
    this.invalidateUsage();
    await super.stop();
  }

  // ---- Reaching the adapter ----

  protected override async prepare() {
    if (this.options.connect) return;
    if (!this.options.command && !adapterEntry()) throw new Error("The Claude adapter is missing. Run npm install.");
    const settings = this.settings();
    const problem = settings.problem ?? this.folderProblem(settings);
    if (problem) throw new Error(problem);
    this.runSettings = settings;
  }

  protected override async connectTransport() {
    if (this.options.connect) return this.options.connect();
    await this.agent?.stop();
    // A restart checks the folder again: one that is gone would give Claude a new, signed-out account.
    const settings = this.runSettings ?? this.settings();
    const problem = settings.problem ?? this.folderProblem(settings);
    if (problem) throw new Error(problem);
    const env = this.environment(settings);
    const agent = this.options.command ? spawnStdioAgent({ command: this.options.command, args: this.options.args ?? [], env }) : nodeStdioAgent(adapterEntry() ?? "", env);
    this.agent = agent;
    agent.exited.then(() => {
      if (this.agent === agent && !this.stopped) this.lastError = new Error(`Claude stopped${stderrTail(agent.stderrTail(), INFO_LOG)}`);
    });
    return agent.transport;
  }

  // Headless Claude Code leaves its todo tools off, and they feed the plan the shelf shows unless the host's plan tool does.
  private environment(settings = this.settings()): NodeJS.ProcessEnv {
    const env = adapterEnvironment({
      ...(settings.configDir ? { CLAUDE_CONFIG_DIR: settings.configDir } : {}),
      ...(settings.executable ? { CLAUDE_CODE_EXECUTABLE: settings.executable } : {}),
    });
    if (!this.options.hostPlans?.()) env.CLAUDE_CODE_ENABLE_TODO_TOOLS ||= "1";
    return env;
  }

  // ---- Claude's names for modes and config ----

  protected override modeToAgent(mode: Mode) {
    return TO_CLAUDE[mode];
  }

  protected override modeFromAgent(modeId: string | null): Mode | null {
    if (!modeId) return null;
    const found = (Object.keys(TO_CLAUDE) as Mode[]).find((mode) => TO_CLAUDE[mode] === modeId);
    return found ?? null;
  }

  // The adapter lists the mode as a config option too. The approval menu shows it, so the option menus do not.
  // Fast mode stays out of the composer while it is off, and shows while it is on, so a session
  // that could not be switched off says so.
  protected override configFromAgent(options: ConfigOption[]) {
    return options
      .filter((option) => option.id !== "mode" && (option.id !== "fast" || option.currentValue === "on"))
      .map((option) => {
        // "default" is the adapter's alias for whatever Claude Code picks. It stays listed only while the session is on it.
        if (option.id === "model" && option.options) {
          const models = option.options.filter((choice) => choice.value !== "default" || option.currentValue === "default");
          return { ...option, options: markOlder(models) };
        }
        return option;
      });
  }



  protected override translate(message: unknown): Translated | null {
    const translated = super.translate(message);
    if (translated?.event.type !== "tool") return translated;
    const claude = ToolName.parse(message).params.update._meta?.claudeCode;
    if (claude?.toolName) translated.event.name = claude.toolName;
    // A step a subagent took. The transcript folds it under the subagent's row.
    if (claude?.parentToolUseId) translated.event.parentId = claude.parentToolUseId;
    return translated;
  }

  protected override toolFacts(tool: ToolCall): ToolFacts {
    return claudeFacts(tool);
  }


  // Recent models send thinking with no text unless a display mode asks for it. Claude Code's
  // --thinking-display summarized sends a summary while Claude thinks, a few lines every couple of
  // seconds on a long think, so the thinking window fills as it goes. Claude Code still decides per
  // model whether and how much to think.
  // Board rules are appended to Claude Code's own system prompt, which the adapter keeps (_meta.systemPrompt).
  // The effort goes in with session/new, which saves setting it after (about 0.6 s). The adapter
  // does not take the model that way (it still reports its default), so the model is set after.
  protected override newSessionParams(options: NewSession, tools?: SessionToolGrant) {
    const rules = typeof options.rules === "string" ? options.rules.trim() : "";
    const picks = options.effort && options.effort !== "default" ? { effort: options.effort } : {};
    return this.sessionMeta(rules, tools, picks);
  }

  // A reload sends the same rules again: the adapter builds the session's query anew.
  protected override loadSessionParams(sessionId: string, tools?: SessionToolGrant) {
    return this.sessionMeta(this.sessionRules.get(sessionId) ?? "", tools);
  }

  // The host's trusted tools run without a permission card: Claude Code names an MCP tool mcp__<server>__<tool>.
  private sessionMeta(rules: string, tools?: SessionToolGrant, picks: { effort?: string } = {}) {
    const allowedTools = (tools?.trusted ?? []).map(({ server, tool }) => `mcp__${server}__${tool}`);
    const append = this.withToolLine(rules, tools);
    return {
      _meta: {
        ...(append ? { systemPrompt: { append } } : {}),
        claudeCode: {
          options: {
            extraArgs: { "thinking-display": "summarized" },
            ...(allowedTools.length ? { allowedTools } : {}),
            ...picks,
          },
          emitRawSDKMessages: [{ type: "command_lifecycle" }],
        },
      },
    };
  }

  // Fast mode bills usage credits outside the plan's limits, so this app keeps it off. Claude
  // can report it on from the user's saved fastMode, or turn it back on after a switch to Opus.
  protected override onAgentConfig(sessionId: string, options: ConfigOption[]) {
    this.rememberModels(options);
    this.turnFastOff(sessionId, options);
    if (this.replaying.has(sessionId)) this.restorePicks(sessionId);
  }

  private turnFastOff(sessionId: string, options: ConfigOption[]) {
    const fast = options.find((option) => option.id === "fast");
    if (fast?.currentValue !== "on" || this.turningFastOff.has(sessionId)) return;
    this.turningFastOff.add(sessionId);
    const pending = this.rpc
      .request("session/set_config_option", { sessionId, configId: "fast", value: "off" }, 30000)
      .then((result) => {
        const parsed = SetConfigResult.parse(result);
        const next = Array.isArray(parsed) ? parsed : parsed.configOptions;
        if (!Array.isArray(next) || !next.length || !this.sessionMap.has(sessionId)) return;
        this.skipCapture.add(sessionId);
        try {
          this.apply(sessionId, { type: "config", configOptions: this.configFromAgent(next) });
        } finally {
          this.skipCapture.delete(sessionId);
        }
      })
      .catch((error: unknown) => {
        if (!this.sessionMap.has(sessionId)) return;
        this.apply(sessionId, {
          type: "notice",
          text: `**Fast mode is still on:** it could not be switched off (${messageOf(error)}). It bills usage credits outside the plan. Switch it off in the fast mode menu.`,
        });
      })
      .finally(() => {
        this.turningFastOff.delete(sessionId);
        if (this.fastOff.get(sessionId) === pending) this.fastOff.delete(sessionId);
      });
    this.fastOff.set(sessionId, pending);
  }

  private restorePicks(sessionId: string) {
    if (this.restoring.has(sessionId) || !this.options.readPicks?.(sessionId)) return;
    const job = this.applyPicks(sessionId).finally(() => {
      if (this.restoring.get(sessionId) === job) this.restoring.delete(sessionId);
    });
    this.restoring.set(sessionId, job);
  }

  // Each step reads the saved choices again, so one the person makes while the restore runs wins.
  // shortcut: a pick made while the restore's own request for that step is out can still lose to it;
  // queue choice changes per session if that ever shows up.
  private async applyPicks(sessionId: string) {
    await this.fastOff.get(sessionId);
    if (!this.sessionMap.has(sessionId)) return;
    const latest = () => this.options.readPicks?.(sessionId) ?? {};
    await this.applyChoices(sessionId, { model: latest().model });
    await this.applyChoices(sessionId, { effort: latest().effort });
    const mode = latest().mode;
    await this.applyChoices(sessionId, { mode: (mode && this.modeFromAgent(mode)) || undefined });
  }

  // A choice the person makes is saved even while a reload replays.
  override async setMode(sessionId: string, mode: Mode) {
    const session = await super.setMode(sessionId, mode);
    this.rememberPicks(sessionId, { mode: TO_CLAUDE[mode] });
    return session;
  }

  override async setConfig(sessionId: string, key: string, value: unknown) {
    const session = await super.setConfig(sessionId, key, value);
    // The value Claude reports back, which can differ from an alias it accepted.
    const accepted = session?.configOptions.find((option) => option.id === key)?.currentValue;
    if ((key === "model" || key === "effort") && typeof accepted === "string" && accepted) this.rememberPicks(sessionId, { [key]: accepted });
    return session;
  }

  // A new session can open on the chosen effort already, so no change reports it.
  override async createSession(options: NewSession) {
    const session = await super.createSession(options);
    this.rememberCurrent(session.id);
    return session;
  }

  // A change Claude reports outside a reload. A reload's own report is Claude's defaults, and the
  // fast-mode answer still carries the model from before it.
  private notePicks(sessionId: string, event: ReducerEvent) {
    if (this.replaying.has(sessionId) || this.skipCapture.has(sessionId)) return;
    if (event.type === "mode" || event.type === "config") this.rememberCurrent(sessionId);
  }

  private rememberCurrent(sessionId: string) {
    const session = this.sessionMap.get(sessionId);
    if (!session) return;
    const current = (id: string) => {
      const value = session.configOptions.find((option) => option.id === id)?.currentValue;
      return typeof value === "string" && value ? value : undefined;
    };
    const model = current("model");
    const effort = current("effort");
    const mode = session.modeId in TO_CLAUDE ? TO_CLAUDE[session.modeId as Mode] : undefined;
    this.rememberPicks(sessionId, { ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(mode ? { mode } : {}) });
  }

  private rememberPicks(sessionId: string, picks: ClaudeThreadPicks) {
    const save = this.options.savePicks;
    if (!save) return;
    const previous = this.options.readPicks?.(sessionId) ?? {};
    const next: ClaudeThreadPicks = { ...previous, ...picks };
    if (previous.model === next.model && previous.effort === next.effort && previous.mode === next.mode) return;
    try {
      save(sessionId, next);
    } catch {
      // The session keeps the choices now. A later reload falls back to Claude's defaults.
    }
  }

  // A follow-up waits in the app's queue until the turn ends.
  protected override queuesPrompts() {
    return false;
  }

  // The model and effort lists, kept for the menu of the next new chat, with the current model's effort levels.
  private rememberModels(options: ConfigOption[]) {
    const choices = (id: string) =>
      (options.find((option) => option.id === id)?.options ?? []).map((choice) => ({ value: choice.value, name: choice.name || choice.value }));
    const models = choices("model");
    if (!models.length || !this.options.saveModels) return;
    const efforts = choices("effort");
    const model = options.find((option) => option.id === "model")?.currentValue;
    const byModel = { ...this.options.readModels?.()?.byModel };
    if (typeof model === "string" && model && model !== "default") byModel[model] = efforts;
    try {
      this.options.saveModels({ models, efforts, byModel });
    } catch {
      // The menu keeps the list it had.
    }
  }

  // ---- Claude's extensions ----

  // The sign-in state, notices and background tasks are the shared adapter client's.
  protected override handleNotification(message: RpcNotification) {
    if (super.handleNotification(message)) return true;
    if (message.method === "_claude/sdkMessage") {
      const { sessionId, message: frame } = CommandLifecycle.parse(message.params);
      const id = frame.command_uuid;
      const state = DELIVERY_OF_LIFECYCLE[frame.state ?? ""];
      if (!sessionId || !this.sessionMap.has(sessionId) || frame.type !== "command_lifecycle" || !id || !state) return true;
      const steered = this.waitingSteers.delete(id);
      this.apply(sessionId, { type: "delivery", id, state });
      this.noteOwnCommand(sessionId, id, frame.state, steered);
      return true;
    }
    if (message.method === "session/update") {
      const usage = UsageUpdate.parse(message).params;
      if (usage.update.sessionUpdate === "usage_update") {
        this.noteRateLimit(usage.update);
        this.noteTurnEnd(usage.sessionId, usage.update);
      }
    }
    return false;
  }

  // A side question (/btw): Claude Code's own, through the adapter's _session/btw (patched in). Claude answers
  // from the conversation without tools, also while a turn runs, and the exchange stays out of the thread.
  async sideQuestion(sessionId: string, question: string): Promise<SideAnswer> {
    this.require(sessionId);
    const text = String(question ?? "").trim();
    if (!text) throw new Error("Ask a question first");
    const clears = this.sideClears.get(sessionId);
    const reply = SideReply.parse(await this.rpc.request("_session/btw", { sessionId, question: text }, 300000));
    const answer = reply.response?.trim();
    if (!answer) throw new Error("Claude gave no answer. Ask again.");
    const entry = { id: randomUUID(), question: text, answer, askedAt: new Date().toISOString() };
    // The chat can be deleted, or its side history cleared, while Claude answers.
    if (this.sessionMap.has(sessionId) && this.sideClears.get(sessionId) === clears) this.options.saveSideAnswer?.(sessionId, entry);
    return { id: entry.id, answer };
  }

  sideHistory(sessionId: string) {
    return this.sessionMap.has(sessionId) ? (this.options.readSideHistory?.(sessionId) ?? []) : [];
  }

  clearSideHistory(sessionId: string) {
    if (!this.sessionMap.has(sessionId)) return;
    this.sideClears.set(sessionId, (this.sideClears.get(sessionId) ?? 0) + 1);
    this.options.clearSideHistory?.(sessionId);
  }

  // Claude Code keeps a finished task's <task-notification> note out of the live stream and replays it on
  // session/load. The same note goes into the thread here, so the live and the reloaded thread show one chip.
  protected override taskEnded(sessionId: string, task: BackgroundTask, summary: string) {
    // A subagent's row in the thread shows how it ended.
    if (task.kind === "local_agent") return;
    const line = summary || (task.kind === "monitor" ? `Monitor "${task.label}" stream ended` : `Background command "${task.label}" ${task.status}`);
    const text = `<task-notification>\n<task-id>${escapeXml(task.id)}</task-id>\n<status>${task.status}</status>\n<summary>${escapeXml(line)}</summary>\n</task-notification>`;
    // A note between two chunks of one reply would split it in two.
    if (this.sessionMap.get(sessionId)?.transcript.at(-1)?.streaming) {
      this.heldNotes.set(sessionId, [...(this.heldNotes.get(sessionId) ?? []), text]);
      return;
    }
    this.apply(sessionId, { type: "chunk", role: "user", text, hidden: true });
  }

  protected override apply(sessionId: string, event: ReducerEvent) {
    // A reload replays Claude Code's own notes.
    if (event.type === "reset") this.heldNotes.delete(sessionId);
    super.apply(sessionId, event);
    this.notePicks(sessionId, event);
    const notes = this.heldNotes.get(sessionId);
    if (!notes || this.sessionMap.get(sessionId)?.transcript.at(-1)?.streaming) return;
    this.heldNotes.delete(sessionId);
    for (const text of notes) super.apply(sessionId, { type: "chunk", role: "user", text, hidden: true });
  }

  override async forgetSession(sessionId: string) {
    this.heldNotes.delete(sessionId);
    this.sideClears.delete(sessionId);
    this.ownCommands.delete(sessionId);
    this.forgetSteers(sessionId);
    await super.forgetSession(sessionId);
  }

  // Claude starts a turn of its own when a background task finishes, to report on it. No prompt of
  // this app's is open then, so the turn ends on the cost Claude sends at the end of every turn.
  private noteTurnEnd(sessionId: string | undefined, update: UsageFields) {
    if (update.cost === undefined || !sessionId) return;
    const session = this.sessionMap.get(sessionId);
    if (!session || session.status !== "running" || this.ownsTurn(sessionId)) return;
    // After the usage event itself, so the context figures land on the turn first.
    queueMicrotask(() => {
      if (this.sessionMap.get(sessionId)?.status === "running" && !this.ownsTurn(sessionId)) {
        this.apply(sessionId, { type: "turn-finished", stopReason: "end_turn" });
      }
    });
  }

  // The adapter also sends Claude a command of its own, such as /compact before an idle chat's prompt cache
  // expires. That turn sends no cost, so it ends on the completed frame of the command it started with. A
  // prompt's completed frame comes after its turn has ended, so only a command started while none was open counts.
  private noteOwnCommand(sessionId: string, id: string, state: string | undefined, steered: boolean) {
    if (state === "started" && !steered && !this.ownsTurn(sessionId)) this.ownCommands.set(sessionId, id);
    if (state !== "completed" || this.ownCommands.get(sessionId) !== id) return;
    this.ownCommands.delete(sessionId);
    if (this.sessionMap.get(sessionId)?.status === "running" && !this.ownsTurn(sessionId)) {
      this.apply(sessionId, { type: "turn-finished", stopReason: "end_turn" });
    }
  }

  private noteRateLimit(update: UsageFields) {
    const usage = usageFromRateLimit(update._meta?.["_claude/rateLimit"], this.accountLabel);
    if (!usage) return;
    this.usageReads += 1;
    this.usage = usage;
    this.usageAt = Date.now();
    this.usageAccount = this.usageSource()?.account ?? this.usageAccount;
  }

  // A message typed during a turn joins it (the SDK's streaming input, via the adapter's _session/steering).
  // At "now" it interrupts the current step, at "next" Claude reads it at its next tool boundary, or right
  // after its last step within the same turn. The uuid names the message in Claude's command_lifecycle frames.
  // When the turn has just ended, the adapter says so instead of starting a turn this app would not
  // see end, and the message goes as an ordinary prompt.
  async steer(sessionId: string, text: string, { at = "now", attachments }: SteerOptions = {}) {
    this.require(sessionId);
    const composed = composePrompt(text, attachments);
    const uuid = randomUUID();
    // The bubble comes first: Claude can report it read before the steer's answer is handled.
    this.apply(sessionId, { type: "user", text: composed.text, attachments: composed.attachments, deliveryId: uuid });
    return this.deliverSteer(uuid, { sessionId, text, attachments, blocks: composed.blocks }, at);
  }

  // Sends a waiting message again as a steer at "now", which interrupts the current step for it. The
  // bubble keeps its place under the new uuid.
  async sendSteerNow(sessionId: string, id: string) {
    const steer = this.waitingSteers.get(id);
    if (!steer || !(await this.cancelSteer(sessionId, id))) return;
    const uuid = randomUUID();
    this.apply(sessionId, { type: "delivery-resent", id, newId: uuid });
    await this.deliverSteer(uuid, steer, "now");
  }

  async removeSteer(sessionId: string, id: string) {
    if (await this.cancelSteer(sessionId, id)) this.apply(sessionId, { type: "delivery-removed", id });
  }

  // Claude Code runs a waiting message right after an interrupt, so Stop takes the waiting ones out first.
  override cancel(sessionId: string) {
    const waiting = [...this.waitingSteers].filter(([, steer]) => steer.sessionId === sessionId).map(([id]) => id);
    if (waiting.length === 0) {
      super.cancel(sessionId);
      return;
    }
    // The turn can end while the waiting messages are withdrawn, and a queued follow-up then starts a new one.
    const turn = this.sessionMap.get(sessionId)?.turnIndex;
    void Promise.all(waiting.map((id) => this.cancelSteer(sessionId, id).catch(() => false))).then(() => {
      if (this.sessionMap.get(sessionId)?.turnIndex === turn) super.cancel(sessionId);
    });
  }

  // A reload rebuilds the transcript without the steered bubbles, and waits until the thread's
  // model, effort and permission mode are set again. Setting Opus can turn fast mode back on, so it
  // also waits until that is off again.
  protected override async afterReload(sessionId: string) {
    this.forgetSteers(sessionId);
    await this.restoring.get(sessionId);
    await this.fastOff.get(sessionId);
  }

  // Sends a steer whose bubble shows already. When no turn runs any more, it goes as an ordinary prompt.
  private async deliverSteer(uuid: string, steer: WaitingSteer, at: SteerTiming) {
    this.waitingSteers.set(uuid, steer);
    let result: unknown;
    try {
      result = await this.rpc.request("_session/steering", {
        sessionId: steer.sessionId,
        prompt: steer.blocks,
        _meta: { steering: { idleBehavior: "promptRequired", priority: at, uuid } },
      });
    } catch (error) {
      // The bubble stays, so the text and files of a message Claude never got can be copied and sent again.
      this.waitingSteers.delete(uuid);
      this.apply(steer.sessionId, { type: "delivery", id: uuid, state: "unread" });
      throw error;
    }
    if (isRecord(result) && result.outcome === "promptRequired") {
      this.dropSteer(uuid);
      return this.followUp(steer.sessionId, steer.text, steer.attachments);
    }
    return result;
  }

  // Takes the message out of Claude Code's queue. False once Claude has read it.
  private async cancelSteer(sessionId: string, id: string) {
    this.require(sessionId);
    const result = await this.rpc.request("_session/steering/cancel", { sessionId, uuid: id });
    const cancelled = isRecord(result) && result.cancelled === true;
    if (cancelled) this.waitingSteers.delete(id);
    return cancelled;
  }

  private dropSteer(id: string) {
    const steer = this.waitingSteers.get(id);
    this.waitingSteers.delete(id);
    if (steer) this.apply(steer.sessionId, { type: "delivery-removed", id });
  }

  private forgetSteers(sessionId: string) {
    for (const [id, steer] of this.waitingSteers) if (steer.sessionId === sessionId) this.waitingSteers.delete(id);
  }

  // Deletes Claude's stored copy. The patched adapter removes the transcript once Claude Code has exited.
  // Call this before forgetSession.
  async deleteSession(sessionId: string) {
    this.assertReady();
    await this.rpc.request("session/delete", { sessionId }, 30000);
  }

  protected override explainError(error: unknown) {
    const text = messageOf(error);
    if (/auth/i.test(text) && /required|expired|not logged|failed to authenticate/i.test(text)) {
      this.signedIn = false;
      return this.signInMessage();
    }
    return this.adapterError("Claude", error);
  }

  protected override stoppedMessage(name: string) {
    return `${name} stopped${stderrTail(this.agent?.stderrTail() ?? "", INFO_LOG)}`;
  }

  // lastError is the old adapter's exit, with its stderr. By now this.agent is the new one.
  protected override restartMessage() {
    const reason = messageOf(this.lastError);
    return `${reason || "Claude stopped"}. It was started again.`;
  }

  // Login stays in Claude Code. The app only says where to sign in.
  private signInMessage() {
    const folder = this.settings().configDir;
    return folder
      ? `Claude is not signed in. Sign in with claude in a terminal: run CLAUDE_CONFIG_DIR=${collapseHome(folder)} claude and sign in there, then try again.`
      : "Claude is not signed in. Sign in with claude in a terminal, then try again.";
  }

  private signInCommand() {
    return signInCommand(this.settings().configDir);
  }
}

// The command that signs in to the account in folder, quoted for a shell. A leading ~/ stays outside the
// quotes, so the shell still expands it.
export function signInCommand(folder?: string): string {
  if (!folder) return "claude";
  const shown = collapseHome(folder);
  const home = shown === "~" ? "~" : shown.startsWith("~/") ? "~/" : "";
  const rest = shown.slice(home.length);
  const quoted = /^[\w@%+=:,./-]*$/.test(rest) ? rest : `'${rest.replaceAll("'", "'\\''")}'`;
  return `CLAUDE_CONFIG_DIR=${home}${quoted} claude`;
}

// The adapter's entry script inside node_modules, run with node.
function adapterEntry(): string | null {
  return entryOf("@agentclientprotocol/claude-agent-acp");
}

function escapeXml(text: string): string {
  return text.replace(/[&<>]/g, (char) => (char === "&" ? "&amp;" : char === "<" ? "&lt;" : "&gt;"));
}
