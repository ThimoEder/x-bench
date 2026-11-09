// The contract between the host and one agent harness (Grok, Claude, ChatGPT).
//
// The app owns the session shape the page renders: SessionState from reducer.ts. Each
// provider translates its harness into that shape, so the host and the page never learn
// ACP, _x.ai or any other protocol. The harness keeps its login, tools, permissions,
// session storage and skills.

import type { CatalogEntry } from "./protocol.ts";
import type { SessionState } from "./reducer.ts";

export type ProviderStatus = "idle" | "connecting" | "reconnecting" | "ready" | "failed" | "stopped";

// What a provider's harness can do that its methods alone do not tell. The page hides
// the controls for anything a provider says no to.
export interface Capabilities {
  // Reopen a session this harness stored earlier.
  loadSession: boolean;
  // Add to the running turn instead of waiting for it.
  steer: boolean;
  // A message sent during a turn can wait for the agent's next step (steer at "next").
  deliverNext: boolean;
  // A steered message can carry attachments.
  steerAttachments: boolean;
}

// The approval modes, named the same for every provider. Each provider maps them to its own ids.
export const MODES = ["ask", "acceptEdits", "plan", "auto", "full"] as const;
export type Mode = (typeof MODES)[number];

export function isMode(value: unknown): value is Mode {
  return typeof value === "string" && (MODES as readonly string[]).includes(value);
}

export interface ModeChoice {
  id: Mode;
  name: string;
}

export interface ModelChoice {
  value: string;
  name: string;
  defaultEffort: string;
  efforts: { value: string; name: string }[];
  // An older model. The menu folds these under "More models".
  older?: boolean;
}

// The models a new session can start with, before any session of this provider exists.
export interface ModelCatalog {
  defaultModel: string;
  defaultEffort: string;
  models: ModelChoice[];
}

// Whether the harness is there and signed in. Login stays in the harness: a provider never
// collects a token, it only reports what the harness says.
export interface Detected {
  installed: boolean;
  version: string | null;
  // null until the harness has said.
  signedIn: boolean | null;
  // The signed-in account as the harness names it (an email and plan), when it says.
  account?: string | null;
  // What the page shows when the provider cannot run.
  message: string | null;
  // The terminal command that gets it running: its install while it is missing, its sign-in while signed out.
  command?: string | null;
}

// One side question and its answer. Neither joins the conversation.
export interface SideEntry {
  id: string;
  question: string;
  answer: string;
  askedAt: string | null;
}

export interface SideAnswer {
  id: string | null;
  answer: string;
}

export type UsagePeriod = "monthly" | "weekly" | "five-hour" | "";

export interface UsageWindow {
  period: UsagePeriod;
  percent: number;
  resetsAt: string | null;
}

// The account's plan usage for the usage meter: its fullest window, and every window when the plan has more than one.
export interface AccountUsage extends UsageWindow {
  tier: string;
  windows?: UsageWindow[];
}

// When a steered message reaches the agent: at once, interrupting the current step, or at its next step.
export type SteerTiming = "now" | "next";

export interface SteerOptions {
  at?: SteerTiming;
  attachments?: unknown;
}

export interface NewSession {
  cwd: string;
  model?: string;
  effort?: string;
  mode?: Mode;
  // Board rules for a builder session. Harnesses without a rules field ignore them.
  rules?: string;
}

// An MCP server the host serves, as ACP's session/new and session/load take it.
export interface HttpMcpServer {
  type: "http";
  name: string;
  url: string;
  headers: { name: string; value: string }[];
}

// The host's MCP servers for one session/new or session/load.
export interface SessionToolGrant {
  servers: HttpMcpServer[];
  // Tools the harness may run without asking, because they only record something for the person.
  trusted: { server: string; tool: string }[];
  // A line for the session's system prompt, since harnesses hide MCP tools until the agent searches for them.
  instructions: string;
  // session/new answered: the servers now belong to this session.
  bind(sessionId: string): void;
}

// The tools the host gives a session, which depend on its folder. sessionId is null for a new session,
// whose id is not known until session/new answers.
export interface SessionTools {
  grant(sessionId: string | null, cwd: string): SessionToolGrant;
}

export interface Provider {
  readonly id: string;
  // The name the model menu groups this provider's models under.
  readonly label: string;
  readonly capabilities: Capabilities;
  readonly modes: readonly ModeChoice[];
  readonly defaultMode: Mode;
  readonly status: ProviderStatus;
  readonly lastError: unknown;
  // Titles and folders the harness reported for its sessions.
  readonly catalog: ReadonlyMap<string, CatalogEntry>;

  detect(): Promise<Detected>;
  models(): ModelCatalog;

  // Its plan usage and service notices come only from a running agent, so it starts when a page opens.
  readonly startsWithPage?: boolean;
  // Starts with the page when startsWithPage, else when a session needs it. start() is safe to call again.
  start(): Promise<void>;
  stop(): Promise<void>;

  onSession(listener: (session: SessionState) => void): () => void;
  onStatus(listener: (status: ProviderStatus) => void): () => void;
  onCatalog(listener: (entry: CatalogEntry) => void): () => void;

  getSession(sessionId: string): SessionState | null;
  sessions(): SessionState[];
  // Sessions waiting on a person, and sessions with a turn running.
  activityMarks(): { working: string[]; attention: string[] };
  // True while a prompt this app sent is still open on the session.
  ownsTurn(sessionId: string): boolean;

  createSession(options: NewSession): Promise<SessionState>;
  // rules are the board rules of a builder session, for a harness that needs them again on every load.
  loadSession(sessionId: string, cwd: string, options?: { rules?: string }): Promise<SessionState | undefined>;
  forgetSession(sessionId: string): Promise<void>;
  // New board rules for an open builder session, sent with its next prompt. Empty rules drop ones not sent yet.
  updateRules?(sessionId: string, rules: string): void;

  prompt(sessionId: string, text: unknown, attachments?: unknown): Promise<SessionState | undefined>;
  // A message sent while a turn runs. A provider without a queue sends it once the turn ends.
  followUp(sessionId: string, text: unknown, attachments?: unknown): Promise<SessionState | undefined>;
  cancel(sessionId: string): void;
  answerPermission(sessionId: string, optionId: string): void;
  cancelPermission(sessionId: string): void;
  // action is accept, decline, cancel, or one of the question's own actions. content is the filled-in form.
  answerElicitation(sessionId: string, action: string, content?: unknown): void;
  setMode(sessionId: string, mode: Mode): Promise<SessionState | undefined>;
  setConfig(sessionId: string, key: string, value: unknown): Promise<SessionState | undefined>;

  // The host moved the session's folder.
  setSessionCwd(sessionId: string, cwd: unknown): string;

  // The follow-ups waiting behind the running turn.
  editQueued(sessionId: string, id: string, text: string, version: number): void;
  removeQueued(sessionId: string, id: string, version: number): void;
  sendQueuedNow(sessionId: string, id: string): Promise<void>;

  // Present when the provider has the feature.
  // Removes the harness's stored copy of the session, where the harness keeps one this app cannot delete itself.
  deleteSession?(sessionId: string): Promise<void>;
  // A stored session as the harness's own log has it, to show while loadSession runs. Null when there is none.
  previewStoredSession?(sessionId: string, cwd: string): Promise<SessionState | null>;
  // Opens a stored session to be read, for a chat whose folder cwd is gone. Without it the host loads the session in a stand-in folder.
  showStoredSession?(sessionId: string, cwd: string): Promise<SessionState | null>;
  // Files the harness's stored copy under another folder, before loadSession opens it there.
  moveSession?(sessionId: string, cwd: string): void;
  // Sessions whose stored log shows a turn running, in this app or in another process of the harness.
  openTurns?(): string[];
  // Catches an open session up with the turn another process runs on it, while open says openTurns lists the session.
  // Otherwise it lets go of the log, so the next catch-up reads it from the start. Answers whether the session changed.
  followTurn?(sessionId: string, open: boolean): boolean;
  steer?(sessionId: string, text: string, options?: SteerOptions): Promise<unknown>;
  // A steered message the agent has not read yet, by its delivery id (capabilities.deliverNext). Both do
  // nothing once the agent has read it.
  sendSteerNow?(sessionId: string, id: string): Promise<void>;
  removeSteer?(sessionId: string, id: string): Promise<void>;
  sideQuestion?(sessionId: string, question: string): Promise<SideAnswer>;
  sideHistory?(sessionId: string): SideEntry[];
  clearSideHistory?(sessionId: string): void;
  answerPlan?(sessionId: string, outcome: string): void;
  // Stops one background task (an entry of the session's backgroundTasks) without cancelling the turn.
  stopTask?(sessionId: string, taskId: string): Promise<void>;
  // null when there are no figures. undefined when they could not be read this time, and the meter keeps what it shows.
  accountUsage?(): Promise<AccountUsage | null | undefined>;
  // The figures accountUsage reads may have changed outside a turn, after a sign-in or a sign-out.
  onUsageChange?(listener: () => void): () => void;
}
