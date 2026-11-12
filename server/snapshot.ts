// The object publish() in app.ts sends over /api/events: whole when a page connects, then only the
// fields that changed. The page bundles REMOTE_OFF from here, so its imports stay type-only.

import type { AccountUsage, Capabilities, ModeChoice, ProviderStatus } from "../bridge/provider.ts";
import type { PresentedSession } from "./present.ts";
import type { TaskSuggestion } from "./board/taskSuggestions.ts";
import type { BrowserView } from "./browser/browser.ts";
import type { DeviceFocus } from "./devices/devices.ts";
import type { ShellView } from "./terminal/terminal.ts";
import type { GoneFolder } from "./folder/goneFolder.ts";
import type { RoutinesView } from "./routines/routineScheduler.ts";
import type { Wait } from "./needs/needsYou.ts";

export type { AccountUsage };

export interface Snapshot {
  // The last failure worth showing, or null once things work again.
  error: string | null;
  cwd: string;
  platform: NodeJS.Platform;
  open: OpenSession[];
  sessions: SessionListRow[];
  projects: SidebarProject[];
  chats: SidebarSession[];
  tickets: TicketLinks;
  surface: Surface;
  working: string[];
  attention: string[];
  unread: string[];
  // Every request a chat waits on the person for, the longest wait first. Chats off the desk are in it too.
  needsYou: Wait[];
  // Plan usage per provider that reports it.
  usage: ProviderUsage[];
  notices: ServiceNotice[];
  composer: ComposerCatalog;
  providers: ProviderView[];
  // The browser pane's tabs, when the Electron app is connected.
  browser: BrowserView;
  deviceFocus: DeviceFocus;
  // The terminal's shells by session, in the order they opened.
  terminals: Record<string, ShellView[]>;
  remote: RemoteState;
  routines: RoutinesView;
  // Settings of the app that the host acts on. desktop is false in a browser tab's host, which has no app to keep
  // the Mac awake.
  app: { desktop: boolean; keepAwake: boolean; planTool: boolean };
  // A session every page should show, as a click on its notification asks. The nonce changes with every ask, and a
  // page that opens later than a few seconds after `at` leaves it.
  reveal: { sessionId: string; cwd: string; chat: boolean; nonce: number; at: number } | null;
}

// One remote access tunnel for the sidebar's dot. ngrok is available once an authtoken is saved, the local
// network always.
export interface RemoteLinkState {
  available: boolean;
  enabled: boolean;
  state: "off" | "starting" | "on" | "failed";
  url: string;
  error: string;
}

export interface RemoteState {
  ngrok: RemoteLinkState;
  local: RemoteLinkState;
}

const LINK_OFF: RemoteLinkState = { available: false, enabled: false, state: "off", url: "", error: "" };
export const REMOTE_OFF: RemoteState = { ngrok: LINK_OFF, local: LINK_OFF };

// What the page knows about a provider: its controls follow the capabilities, its approval menu the modes.
// defaultMode is the one a new session starts in, as the settings page chose it.
export interface ProviderView {
  id: string;
  label: string;
  // Off in Settings: it never starts and its models are not offered.
  enabled: boolean;
  status: ProviderStatus;
  error: string | null;
  // btw: side questions that do not join the conversation.
  capabilities: Capabilities & { btw: boolean };
  modes: ModeChoice[];
  defaultMode: ModeChoice["id"];
}

export type ProviderUsage = AccountUsage & { provider: string; label: string };

// An open session with the title the catalog knows for it, the provider that runs it, and the follow-up
// tasks its agent suggested.
export type OpenSession = PresentedSession & { title: string | null; provider: string; suggestions: TaskSuggestion[]; folderGone?: GoneFolder };

export type { BrowserView, DeviceFocus, ShellView, TaskSuggestion };
export type { RoutinesView, Wait };
export type { RoutineView, RoutineRunView, RunState } from "./routines/routineScheduler.ts";

export type Surface = "builder" | "chat";

// A recent session in the current folder (chat/sessions.ts listSessions, titles from sidebar.json).
export interface SessionListRow {
  id: string;
  title: string;
  updatedAt: string | null;
  modelId: string | null;
}

// One session row in the sidebar (chat/sessions.ts sessionIndex, arranged by sidebar/sidebar.ts).
export interface SidebarSession {
  id: string;
  cwd: string;
  title: string;
  updatedAt: string;
  // The folder the session was started from, when that is not its cwd.
  source?: string;
  worktreeLabel?: string;
  worktree?: string;
  archived?: true;
  pinned?: true;
  folder?: string;
  provider?: string;
  // Its folder no longer exists.
  gone?: true;
  // The only chat in a worktree this app added, which deleting the chat can remove too.
  ownWorktree?: true;
  // The providers a switched chat ran on before, oldest first.
  earlierProviders?: string[];
  // On project rows: the time the sidebar ranks by, the last prompt this app
  // recorded, else when the row was first seen, else the session's updatedAt.
  rankedAt?: string;
}

export interface SidebarProject {
  cwd: string;
  name: string;
  // Missing on a project found in this pass that sidebar.json does not store yet.
  collapsed?: boolean;
  sessions: SidebarSession[];
  folders?: SidebarFolder[];
}

export interface SidebarFolder {
  id: string;
  name: string;
  collapsed: boolean;
}

export interface TicketLinks {
  // Folders bound to a board.
  boards: string[];
  bySession: Record<string, TicketLink[]>;
  // Counts the board writes through this host.
  changes?: number;
}

export interface TicketLink {
  // A positive integer, or a 24-character hex id.
  taskId: number | string;
  projectId: number;
  title: string;
  reference: number | null;
  status: string | null;
  // The color of the ticket's column on its board, when the host knows one.
  color?: string;
  // The ticket moved from Review to Done, so the chat offers to archive itself.
  cleanup?: true;
}


export interface ServiceNotice {
  id: string;
  severity: "critical" | "warning" | "error";
  title: string;
  message: string;
  url: string;
  link: string;
}

// The models of every provider that is on, for a new chat. value is "<provider>:<model>", so two providers
// can offer the same model id. The default provider's default model is the default.
export interface ComposerCatalog {
  defaultModel: string;
  defaultEffort: string;
  models: ComposerModel[];
}

export interface ComposerModel {
  value: string;
  name: string;
  defaultEffort: string;
  efforts: { value: string; name: string }[];
  // The provider that runs a session started on this model, and the model id it knows.
  provider: string;
  model: string;
  // The provider's label, which the menu groups models under.
  group: string;
  // An older model, folded under "More models".
  older?: boolean;
}
