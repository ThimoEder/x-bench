// The host without a port: createApp builds the state and the /api request handler.
// index.ts wires it to http, Vite, the WebSocket upgrades and the timers.

import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { Duplex } from "node:stream";
import type { Provider } from "../bridge/provider.ts";
import type { FuzzyMatch } from "../bridge/protocol.ts";
import { waitsOnPerson, type SessionState } from "../bridge/reducer.ts";
import type { BoardTicket } from "./board/sharedRules.ts";
import { REMOTE_OFF, type ComposerCatalog, type OpenSession, type ProviderUsage, type ProviderView, type SessionListRow, type Snapshot } from "./snapshot.ts";
import type { Desk } from "./desk.ts";
import { presentFrozen, presentSession, type PresentedSession } from "./present.ts";
import { createProjectLocator, readGitWorktree, type ProjectPlace } from "./folder/projectHome.ts";
import { canonicalCwd, isDirectory, listSessions, sessionIndex, type SessionIndexRow } from "./chat/sessions.ts";
import { goneFolder, goneWorktree, type GoneFolder } from "./folder/goneFolder.ts";
import { addFolder, applyTitles, arrangeChats, arrangeSidebar, folderNamed, moveToFolder, noteChat, currentSidebar, readSidebar, rowsWithCatalog, writeSidebar, type SidebarState } from "./sidebar/sidebar.ts";
import { folderTools, type ChatFolders } from "./sidebar/folderTools.ts";
import { rulesForBoard } from "./board/boardRules.ts";
import { readSettings } from "./board/boardSettingsFile.ts";
import { createSurfaces, type Surfaces } from "./surface.ts";
import { boundFolder, presentTickets, readTickets } from "./board/tickets.ts";
import { sameMarks, updateUnread } from "./chat/unread.ts";
import { planTools, type PlanHost } from "./chat/planTool.ts";
import { chatsToClose, isBusy } from "./chat/idleChats.ts";
import { contextWindows } from "./chat/context.ts";
import { readServiceNotices } from "./chat/announcements.ts";
import { durableNotices } from "./jsonFile.ts";
import { afterResets, createUsageStore, type UsageStore } from "./providers/usageCache.ts";
import type { Providers } from "./providers/providers.ts";
import type { Voice } from "./voice/voice.ts";
import { createQuietVolume, type QuietVolume } from "./voice/quietVolume.ts";
import type { Devices } from "./devices/devices.ts";
import { messageOf, sendJson, statusOf } from "./http.ts";
import { createHarnessWorktree, type CreatedWorktree, type WorktreeOptions } from "./git/worktree.ts";
import { refuseRequest } from "./apiGuard.ts";
import type { XBenchPaths } from "./paths.ts";
import { createHostSak, type SakServe } from "./board/sak/sakServe.ts";
import { dispatch, type Route } from "./router.ts";
import { sessionRoutes } from "./chat/routes.ts";
import { reviewRoutes } from "./git/routes.ts";
import { folderRoutes } from "./folder/routes.ts";
import { sidebarRoutes } from "./sidebar/routes.ts";
import { boardRoutes } from "./board/routes.ts";
import { deviceRoutes, openDeviceStream } from "./devices/routes.ts";
import { openTerminalStream, terminalRoutes } from "./terminal/routes.ts";
import { voiceRoutes } from "./voice/routes.ts";
import { providerRoutes } from "./providers/routes.ts";
import { suggestionRoutes } from "./board/suggestionRoutes.ts";
import { mcpRoutes } from "./mcp/routes.ts";
import { browserRoutes, openBrowserLink } from "./browser/routes.ts";
import { remoteRoutes } from "./remote/routes.ts";
import type { Remote } from "./remote/remote.ts";
import { createTaskSuggestions, suggestTools, type TaskSuggestions } from "./board/taskSuggestions.ts";
import { chatIdTools } from "./board/ticketLinks.ts";
import { createBrowser, type Browser } from "./browser/browser.ts";
import type { HostPrompt } from "./chat/prompts.ts";
import { browserTools } from "./browser/browserTools.ts";
import { createHostTools, type HostTools } from "./mcp/mcp.ts";
import { pullRequestTools } from "./git/pullRequest.ts";
import { createSimulator, type Simulator } from "./devices/simulator.ts";
import { simulatorTools } from "./devices/ios/simulatorTools.ts";
import { createBuilds, type Builds } from "./devices/ios/xcodeBuild.ts";
import type { PresentedPermission } from "./present.ts";
import { createTerminals, type Terminals } from "./terminal/terminal.ts";
import type { ChatRecords, FrozenStretch } from "./chat/chatRecords.ts";
import type { Switching } from "./chat/switchChat.ts";
import { stripHandoff, withoutSummaryTurns } from "./chat/handoff.ts";
import { createHarnessCommands, type HarnessCommandsStore } from "./chat/harnessCommands.ts";
import { routineRoutes } from "./routines/routes.ts";
import { createRoutineStore, type RoutineStore } from "./routines/routines.ts";
import { createRoutineEdits, type RoutineEdits } from "./routines/routineEdits.ts";
import { routineTools, type RoutineToolHost } from "./routines/routineTools.ts";
import { createRoutineRunStore, type RoutineRunStore } from "./routines/routineRuns.ts";
import { createRoutineScheduler, runMode, type RoutineNote, type RoutineScheduler } from "./routines/routineScheduler.ts";
import { fileLock, type SchedulerLock } from "./routines/routineLock.ts";
import { createAppSettings, type AppSettingsStore } from "./settings/appSettings.ts";
import { appSettingRoutes } from "./settings/routes.ts";

// A provider's own figures can trail its reset time by a little.
const USAGE_RESET_GRACE_MS = 60_000;
const USAGE_FRESH_MS = 60_000;
// setTimeout's longest wait. A monthly window is read again on the way.
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

export interface AppOptions {
  providers: Providers;
  desk: Desk;
  voice: Voice;
  // Turns the Mac's volume down while the user dictates.
  quietVolume?: QuietVolume;
  devices: Devices;
  // The port the page and the board rules use to reach this host.
  port: number;
  // The per-launch token every /api request and WebSocket upgrade must carry.
  token: string;
  paths: XBenchPaths;
  // The usage meters of the last run.
  savedUsage?: UsageStore;
  // The same instance index.ts hands to the providers, so both share one cache.
  harnessCommands?: HarnessCommandsStore;
  sak?: SakServe;
  // The folder the page starts in.
  cwd: string;
  suggestions?: TaskSuggestions;
  browser?: Browser;
  simulator?: Simulator;
  builds?: Builds;
  // The same instance whose sessionTools the providers got, so MCP keys resolve here.
  hostTools?: HostTools;
  // The terminal's shells. index.ts keeps them, to end them on shutdown.
  terminals?: Terminals;
  // Remote access through ngrok and the local network. Without it the settings page has no Remote routes.
  remote?: Remote;
  routines?: RoutineOptions;
  appSettings?: AppSettingsStore;
  // Desktop only: holds the Mac awake while on.
  keepAwake?: (on: boolean) => void;
}

export interface RoutineOptions {
  store?: RoutineStore;
  runs?: RoutineRunStore;
  // Off unless set.
  schedule?: boolean;
  lock?: SchedulerLock;
  now?: () => Date;
  notify?: (note: RoutineNote) => void;
}

// A chat moving to another provider, from the moment it is confirmed until the new model is ready.
export interface SwitchRun {
  view: Switching;
  // The transcript's length when the switch began. What comes after, the summary turn, stays off screen.
  at: number;
  cancelled: boolean;
  held: { text: unknown; attachments: unknown }[];
  // The chat has moved or stayed, and only the held messages are still going out.
  settled?: boolean;
  // Settles once the held messages are out.
  done?: Promise<void>;
}

// The host's mutable state. createApp owns one.
export interface Store {
  // snapshot.cwd is the folder a new session starts in. Each open session keeps its own folder.
  snapshot: Snapshot;
  switching: Map<string, SwitchRun>;
  sidebarState: SidebarState;
  starting: Map<string, Promise<void>>;
  clients: Set<{ write(chunk: string): unknown; changes?: boolean }>;
  catalogTimer: NodeJS.Timeout | undefined;
  deletedIds: Set<string>;
  unreadIds: Set<string>;
  runningIds: Set<string>;
  // Sessions whose stored log shows a turn running (Provider.openTurns), read once a second.
  diskWorking: string[];
  projectStamp: string;
  titleTick: number;
  // The @ file matches each open session's composer shows, and the number of its latest search.
  mentions: Map<string, FuzzyMatch[]>;
  mentionSearch: Map<string, number>;
  usage: Map<string, ProviderUsage>;
  // Open chats whose folder is gone. Each is loaded in a stand-in folder and takes no prompt until it moves.
  goneFolders: Map<string, GoneFolder>;
  // New sessions opened off the desk because the page had moved on. Each takes its first prompt there.
  unsent: Set<string>;
  // Idle chats the host is closing. Loading one waits for its close.
  closing: Map<string, Promise<void>>;
  boardChanges: number;
}

export interface App {
  store: Store;
  // Answers one /api request. A thrown error becomes a 500 unless a reply has started.
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  refreshNotices(): void;
  refreshDiskWorking(): void;
  pollUsage(): void;
  // Opens the device mirror for an upgrade request, or ends the socket with 403 when the guard refuses it.
  openDeviceStream(address: URL, req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void>;
  // Takes the Electron app's browser link, or ends the socket with 403 when the guard refuses it.
  openBrowserLink(address: URL, req: IncomingMessage, socket: Duplex, head: Buffer): void;
  // Opens a shell's stream for an upgrade request, or ends the socket with 403 when the guard refuses it.
  openTerminalStream(address: URL, req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void>;
  chatFolders: ChatFolders;
  routines: RoutineScheduler;
  routineTools: RoutineToolHost;
  // Asks every page to show a session, as a click on its notification does.
  revealSession(sessionId: string): void;
}

// What the route modules use from the app.
export interface Host {
  providers: Providers;
  desk: Desk;
  surfaces: Surfaces;
  voice: Voice;
  quietVolume: QuietVolume;
  devices: Devices;
  store: Store;
  suggestions: TaskSuggestions;
  browser: Browser;
  simulator: Simulator;
  hostTools: HostTools;
  terminals: Terminals;
  remote: Remote | null;
  chatRecords: ChatRecords;
  routines: RoutineScheduler;
  routineEdits: RoutineEdits;
  appSettings: AppSettingsStore;
  // Applies settings.json: holds the Mac awake or lets it sleep, and publishes the change.
  followAppSettings(): void;
  port: number;
  paths: XBenchPaths;
  harnessCommands: HarnessCommandsStore;
  sak: SakServe;
  publish(partial: Partial<Snapshot>): void;
  // Shows a provider's failure in the banner. Only that provider's own traffic clears it again.
  providerError(provider: Provider, error: unknown): void;
  sessionError(sessionId: string, source?: Provider): (error: unknown) => void;
  clearSessionError(sessionId: string): void;
  // { error: null } unless the banner shows another provider's failure.
  clearedBy(provider: Provider): Pick<Snapshot, "error"> | Record<string, never>;
  presentedOpen(): OpenSession[];
  // A chat as the page shows it, for a copy that is not on the desk.
  presentedStored(session: SessionState, provider: Provider): OpenSession;
  activity(): Pick<Snapshot, "working" | "attention" | "unread">;
  catalogSnapshot(): Pick<Snapshot, "projects" | "chats" | "tickets" | "notices">;
  // Every chat the sidebar knows, also in hidden projects, without the deleted ones.
  chatRows(): SessionIndexRow[];
  safeSessions(folder: string): SessionListRow[];
  // Starts the provider if it is not running, and publishes its status.
  ensureProvider(provider: Provider): Promise<void>;
  sessionRules(folder: string, ticket?: BoardTicket | null): string;
  sidebarHome(folder: string): string;
  checkoutOf(folder: string): string;
  goneFolderOf(sessionId: string, folder: string): Promise<GoneFolder>;
  changeSidebar(change: (state: SidebarState) => SidebarState): void;
  followOpenSessions(): boolean;
  refreshUsage(provider: Provider): void;
  // Reads every enabled provider's usage while a page is open, except one read within the last minute.
  pollUsage(): void;
  createWorktree(folder: string, gitRef: string, providerId: string, options?: Pick<WorktreeOptions, "name" | "branch">): Promise<CreatedWorktree>;
}

export function createApp({ providers, desk, voice, quietVolume = createQuietVolume(), devices, port, token, paths, savedUsage = createUsageStore(paths.usage), harnessCommands = createHarnessCommands(paths.harnessCommands), sak = createHostSak(paths.sak), cwd, suggestions = createTaskSuggestions(paths.suggestions), browser = createBrowser(paths.browserPages), simulator = createSimulator({ logDir: paths.simulatorLogs }), builds = createBuilds({ dir: paths.simulatorBuilds }), hostTools = createHostTools(hostToolGroups({ sessionOf: (id) => providers.getSession(id), setPlan: (id, entries) => providers.forSession(id).setPlan(id, entries), planTool: () => appSettings.read().planTool, suggestions, browser, simulator, builds, devices }), { builder: builderFolder(paths.chatHome) }), terminals = createTerminals(), remote, routines: routineOptions = {}, appSettings = createAppSettings(paths.appSettings), keepAwake }: AppOptions): App {
  const chatRecords: ChatRecords = providers.records;
  const surfaces = createSurfaces(desk, { alive: (id) => Boolean(providers.getSession(id)) });
  const locateProject = createProjectLocator();
  const store: Store = {
    // The session lists are filled below, once the helpers can read the store.
    snapshot: {
      error: null,
      cwd,
      platform: process.platform,
      open: [],
      sessions: [],
      projects: [],
      chats: [],
      tickets: { boards: [], bySession: {} },
      surface: "builder",
      working: [],
      attention: [],
      unread: [],
      usage: [],
      notices: readServiceNotices(),
      composer: composerCatalog(),
      providers: [],
      browser: browser.view(),
      deviceFocus: devices.focused(),
      terminals: {},
      remote: remote ? remote.state() : REMOTE_OFF,
      routines: { scheduler: { here: false, takesPart: false, port: null }, desktop: false, list: [] },
      app: { desktop: Boolean(keepAwake), keepAwake: false, planTool: false },
      reveal: null,
    },
    sidebarState: readSidebar(paths.sidebar),
    starting: new Map(),
    clients: new Set(),
    catalogTimer: undefined,
    deletedIds: new Set<string>(),
    unreadIds: new Set<string>(),
    runningIds: new Set<string>(),
    diskWorking: [],
    projectStamp: "",
    titleTick: 0,
    mentions: new Map(),
    mentionSearch: new Map(),
    usage: new Map(),
    goneFolders: new Map(),
    switching: new Map(),
    unsent: new Set<string>(),
    closing: new Map(),
    boardChanges: 0,
  };
  // Before the first catalog, which leaves routine runs out of the sidebar.
  const routineRuns = routineOptions.runs ?? createRoutineRunStore(paths.routineRuns);
  // The meters of the last run show at once. The reads when a page opens replace them.
  for (const saved of savedUsage.read()) {
    const provider = providers.list().find((each) => each.id === saved.provider);
    if (provider && providers.isEnabled(provider)) setUsage(provider, afterResets(saved));
  }
  store.snapshot = { ...store.snapshot, sessions: safeSessions(cwd), providers: providerViews(), usage: [...store.usage.values()], ...catalogSnapshot() };

  const routineStore = routineOptions.store ?? createRoutineStore(paths.routines);
  const routines = createRoutineScheduler({
    host: { providers, store, desk, surfaces, paths, browser, ensureProvider, createWorktree, sessionRules, sidebarHome, changeSidebar, publish, safeSessions, catalogSnapshot, activity, sessionError, chatRows },
    routines: routineStore,
    runs: routineRuns,
    schedule: Boolean(routineOptions.schedule),
    lock: routineOptions.lock ?? fileLock(port, paths.routinesLock),
    publish: (view) => publish({ routines: view }),
    ...(routineOptions.now ? { now: routineOptions.now } : {}),
    ...(routineOptions.notify ? { notify: routineOptions.notify } : {}),
  });
  store.snapshot = { ...store.snapshot, routines: routines.view() };
  routineStore.onChange(() => routines.refresh());
  const routineEdits = createRoutineEdits({ providers, store: routineStore, scheduler: routines, chatHome: paths.chatHome });
  let revealNonce = 0;
  // What keepAwake was last told, so a repeated setting sends nothing.
  let keptAwake: boolean | null = null;

  function holdAwake(on: boolean) {
    if (!keepAwake || keptAwake === on) return;
    keptAwake = on;
    keepAwake(on);
  }

  function followAppSettings() {
    const settings = appSettings.read();
    holdAwake(settings.keepAwake);
    const shown = store.snapshot.app;
    if (settings.keepAwake !== shown.keepAwake || settings.planTool !== shown.planTool) publish({ app: { desktop: Boolean(keepAwake), ...settings } });
  }

  store.snapshot = { ...store.snapshot, app: { desktop: Boolean(keepAwake), ...appSettings.read() } };
  holdAwake(store.snapshot.app.keepAwake);

  // A running turn changes its session with every streamed chunk, and each publish presents every open
  // session again and sends the whole open list, whole transcripts included. While a turn runs, its changes
  // go out at most once per OPEN_FRAME_MS: the first at once, the rest together at the end of the frame.
  // A change to a session that is not running goes out at once, so the end of a turn is never late.
  const OPEN_FRAME_MS = 33;
  // Whether a change waiting for the frame clears the banner. Decided when the change arrives, as an
  // immediate publish would, and dropped when a newer error is published before the frame ends.
  let openClears = false;
  let openTimer: ReturnType<typeof setTimeout> | undefined;
  let openPublishedAt = 0;
  // The JSON of each snapshot field as the pages last got it.
  const sentFields = new Map<string, string>();
  const usageRefreshes = new Map<string, number>();
  const usageResets = new Map<string, ReturnType<typeof setTimeout>>();
  const usageReadAt = new Map<string, number>();

  function publishOpenSoon() {
    if (openTimer) return;
    const wait = openPublishedAt + OPEN_FRAME_MS - Date.now();
    if (wait <= 0) publishOpen();
    else openTimer = setTimeout(publishOpen, wait);
  }

  function publishOpen() {
    clearTimeout(openTimer);
    openTimer = undefined;
    openPublishedAt = Date.now();
    const cleared = openClears;
    openClears = false;
    publish({ open: presentedOpen(), ...activity(), ...(cleared ? { error: null } : {}) });
  }

  providers.onStatus((status, provider) => {
    if (status === "idle") return;
    if (status === "failed") providerError(provider, provider.lastError ?? new Error(`${provider.label} failed to start`));
    else publish(clearedBy(provider));
    if (status === "ready") {
      refreshUsage(provider);
      refreshNotices();
    }
  });

  const sessionErrors = new Map<string, { message: string; provider: string; source: string; turnIndex: SessionState["turnIndex"] }>();
  // Each list a session reports is saved once, for a new chat's slash menu.
  const savedCommands = new WeakSet<object>();
  providers.onSession((session, provider) => {
    const failure = sessionErrors.get(session.id);
    if (failure) {
      if (failure.provider !== provider.id || (provider.status === "ready" && failure.turnIndex !== session.turnIndex)) sessionErrors.delete(session.id);
      else failure.turnIndex = session.turnIndex;
    }
    if (session.commands.length && !savedCommands.has(session.commands)) {
      savedCommands.add(session.commands);
      const commands = session.commands.flatMap((command) => (command.name ? [{ name: command.name, description: command.description }] : []));
      try {
        harnessCommands.save(provider.id, session.cwd, commands);
      } catch {
        // The open session's menu still has them. Only a new chat goes without.
      }
    }
    routines.sessionChanged(session);
    const wasRunning = noteActivity(session);
    const becameIdle = wasRunning && session.status === "idle";
    if (becameIdle) refreshUsage(provider);
    if (!desk.has(session.id)) {
      const marks = activity();
      if (!sameMarks(store.snapshot, marks)) publish(marks);
      return;
    }
    if ("error" in clearedBy(provider)) openClears = true;
    if (session.status === "running") publishOpenSoon();
    else publishOpen();
    if (becameIdle) {
      providers.remember(session, provider);
      publish({ sessions: safeSessions(store.snapshot.cwd), ...catalogSnapshot() });
    }
  });

  providers.onUsageChange(refreshUsage);

  providers.onCatalog((entry, provider) => {
    // A harness that names its sessions (Claude's session_info_update) renames the sidebar row.
    // A switched chat keeps the title it had: the new harness names its session after the handoff it read.
    const row = entry.sessionId ? providers.index.get(entry.sessionId) : null;
    if (entry.sessionId && entry.title && row && !chatRecords.get(entry.sessionId)) {
      try {
        providers.index.record({ id: entry.sessionId, provider: provider.id, title: entry.title });
      } catch {
        // The title still shows from the live catalog.
      }
    }
    clearTimeout(store.catalogTimer);
    store.catalogTimer = setTimeout(() => {
      publish({ open: presentedOpen(), ...catalogSnapshot() });
    }, 200);
  });

  suggestions.onChange(() => publish({ open: presentedOpen() }));
  // Tabs change with every load and title, and several times per agent action, so their publishes share a frame.
  let browserTimer: ReturnType<typeof setTimeout> | undefined;
  let promptsChanged = false;
  browser.onChange((prompts) => {
    if (prompts) routines.promptsChanged();
    promptsChanged ||= prompts;
    if (browserTimer) return;
    browserTimer = setTimeout(() => {
      browserTimer = undefined;
      const prompts = promptsChanged;
      promptsChanged = false;
      publish({ browser: browser.view(), ...(prompts ? { open: presentedOpen(), ...activity() } : {}) });
    }, OPEN_FRAME_MS);
  });
  devices.onChange(() => publish({ deviceFocus: devices.focused() }));
  remote?.onChange(() => publish({ remote: remote.state() }));
  terminals.onChange(() => publish({ terminals: terminals.views() }));

  function followSuggestions() {
    if (suggestions.changedOnDisk()) publish({ open: presentedOpen() });
  }

  function refreshUsage(provider: Provider) {
    if (!provider.accountUsage || !providers.isEnabled(provider)) return;
    const refresh = (usageRefreshes.get(provider.id) ?? 0) + 1;
    usageRefreshes.set(provider.id, refresh);
    provider
      .accountUsage()
      .then((usage) => {
        if (usageRefreshes.get(provider.id) !== refresh || !providers.isEnabled(provider) || usage === undefined) return;
        usageReadAt.set(provider.id, Date.now());
        const next: ProviderUsage | null = usage ? { ...usage, provider: provider.id, label: provider.label } : null;
        followReset(provider, next);
        if (!next) {
          if (store.usage.delete(provider.id)) publish({ usage: [...store.usage.values()] });
          return;
        }
        if (JSON.stringify(store.usage.get(provider.id)) === JSON.stringify(next)) return;
        setUsage(provider, next);
        publish({ usage: [...store.usage.values()] });
      })
      .catch(() => {});
  }

  // Meters keep the providers' order, whichever read lands first.
  function setUsage(provider: Provider, usage: ProviderUsage) {
    store.usage.set(provider.id, usage);
    const order = providers.list().map((each) => each.id);
    store.usage = new Map([...store.usage].sort(([a], [b]) => order.indexOf(a) - order.indexOf(b)));
  }

  function pollUsage() {
    if (!store.clients.size) return;
    for (const provider of providers.list()) {
      if (Date.now() - (usageReadAt.get(provider.id) ?? 0) >= USAGE_FRESH_MS) refreshUsage(provider);
    }
  }

  // A meter is read again a minute after the first of its windows resets.
  function followReset(provider: Provider, usage: ProviderUsage | null) {
    clearTimeout(usageResets.get(provider.id));
    usageResets.delete(provider.id);
    const readAt = [usage?.resetsAt, ...(usage?.windows ?? []).map((window) => window.resetsAt)]
      .map((time) => Date.parse(time ?? "") + USAGE_RESET_GRACE_MS)
      .filter((time) => time > Date.now());
    if (!readAt.length) return;
    const timer = setTimeout(() => {
      usageResets.delete(provider.id);
      if (store.usage.has(provider.id)) refreshUsage(provider);
    }, Math.min(Math.min(...readAt) - Date.now(), MAX_TIMEOUT_MS));
    timer.unref();
    usageResets.set(provider.id, timer);
  }

  function shownNotices() {
    return [...readServiceNotices(), ...durableNotices()];
  }

  function refreshNotices() {
    const notices = shownNotices();
    if (JSON.stringify(notices) === JSON.stringify(store.snapshot.notices)) return;
    publish({ notices });
  }

  function sessionRules(folder: string, ticket?: BoardTicket | null) {
    const state = readTickets(paths.tickets);
    const bound = boundFolder(state, folder, checkoutOf);
    return rulesForBoard(state, bound, `http://127.0.0.1:${port}`, ticket, paths.launchToken(port), readSettings(paths.tickets, bound));
  }

  // A provider restarts an agent that exits. If it gives up, the next call here starts it again.
  // A provider the settings page turned off never starts.
  async function ensureProvider(provider: Provider) {
    if (!providers.isEnabled(provider)) throw Object.assign(new Error(`${provider.label} is off. Turn it on in Settings.`), { status: 409 });
    if (provider.status === "ready") return;
    let starting = store.starting.get(provider.id);
    if (!starting) {
      if (provider.status === "idle" || provider.status === "failed") publish(clearedBy(provider));
      starting = provider.start().then(
        () => {
          store.starting.delete(provider.id);
        },
        (error: unknown) => {
          store.starting.delete(provider.id);
          // A first start can time out while the loop keeps trying; that fails this call, not the provider.
          if (provider.status === "failed") providerError(provider, error);
          throw error;
        },
      );
      store.starting.set(provider.id, starting);
    }
    await starting;
  }

  // Tracks running and unread for one session change. Answers whether the session was running before it.
  function noteActivity(session: SessionState): boolean {
    const wasRunning = store.runningIds.has(session.id);
    if (session.status === "running") store.runningIds.add(session.id);
    else store.runningIds.delete(session.id);
    const next = updateUnread(store.unreadIds, {
      id: session.id,
      wasRunning,
      status: session.status,
      open: desk.has(session.id),
      pending: waitsOnPerson(session),
    });
    store.unreadIds.clear();
    for (const id of next) store.unreadIds.add(id);
    return wasRunning;
  }

  function refreshDiskWorking() {
    let next: string[];
    try {
      next = providers.list().flatMap((provider) => provider.openTurns?.() ?? []).sort();
    } catch {
      next = [];
    }
    const workingChanged = !sameIds(next, store.diskWorking);
    if (workingChanged) store.diskWorking = next;
    const followed = followOpenSessions();
    if (store.titleTick++ % 2 === 0) {
      refreshTitles();
      followGoneFolders();
    }
    if (workingChanged && !followed) publish(activity());
    followProviderSettings();
    followSuggestions();
    followRoutines();
    closeIdleChats();
  }

  function followRoutines() {
    const edited = routineStore.changedOnDisk();
    const ran = routineRuns.changedOnDisk();
    if (edited || ran) routines.refresh();
    if (ran) publish({ ...catalogSnapshot() });
    if (appSettings.changedOnDisk()) followAppSettings();
  }

  // providers.json as this host last published it. Another host on the same home (the app next to
  // npm run dev) can change it.
  let settingsStamp = JSON.stringify(providers.settings.read());

  // Follows providers.json: a provider turned off stops once no turn of it runs, and keeps its chats
  // open. Sends to them are refused until it is on again. The page gets the new menus and switches.
  function followProviderSettings() {
    for (const provider of providers.list()) {
      if (providers.isEnabled(provider)) continue;
      store.usage.delete(provider.id);
      if (provider.status === "idle" || provider.status === "stopped") continue;
      if (provider.sessions().some((session) => session.status === "running")) continue;
      provider.stop().catch(() => {});
    }
    const stamp = JSON.stringify(providers.settings.read());
    if (stamp === settingsStamp) return;
    settingsStamp = stamp;
    publish({ usage: [...store.usage.values()] });
  }

  // An open chat whose turn another process of its harness runs follows that turn.
  function followOpenSessions() {
    let followed = false;
    for (const id of desk.ids()) {
      if (providers.forSession(id).followTurn?.(id, store.diskWorking.includes(id))) followed = true;
    }
    return followed;
  }

  // An open chat whose folder is removed under it turns read-only at once. A running turn still ends by itself.
  const checkingGone = new Set<string>();
  function followGoneFolders() {
    for (const id of desk.ids()) {
      if (store.goneFolders.has(id) || checkingGone.has(id)) continue;
      const session = providers.forSession(id).getSession(id);
      if (!session?.cwd || isDirectory(session.cwd)) continue;
      checkingGone.add(id);
      goneFolderOf(id, session.cwd)
        .then((gone) => {
          if (!desk.has(id) || isDirectory(session.cwd)) return;
          store.goneFolders.set(id, gone);
          publish({ open: presentedOpen(), ...catalogSnapshot() });
        })
        .catch(() => {})
        .finally(() => checkingGone.delete(id));
    }
  }

  function refreshTitles() {
    const catalog = catalogSnapshot();
    const stamp = [
      catalog.projects.map((project) => project.sessions.map((session) => `${session.id}\0${session.title}\0${session.worktree || ""}\0${session.gone ? 1 : 0}`).join("\n")).join("\n"),
      catalog.chats.map((session) => `${session.id}\0${session.title}\0${session.gone ? 1 : 0}`).join("\n"),
    ].join("\n");
    if (stamp === store.projectStamp) return;
    store.projectStamp = stamp;
    publish({ ...catalog, open: presentedOpen() });
  }

  // Each loaded chat's last time on screen, or its first time seen loaded.
  const lastShown = new Map<string, number>();

  function closeIdleChats() {
    const now = Date.now();
    // The shown surface keeps its old parked list, which panes opened since have replaced.
    const hidden = surfaces.surface() === "builder" ? "chat" : "builder";
    for (const id of [...desk.ids(), ...surfaces.parked(hidden)]) lastShown.set(id, now);
    const held = heldChats();
    const loaded = new Set<string>();
    for (const provider of providers.list()) {
      const chats = provider
        .sessions()
        .filter((session) => !store.closing.has(session.id))
        .map((session) => {
          loaded.add(session.id);
          if (!lastShown.has(session.id)) lastShown.set(session.id, now);
          return { id: session.id, busy: isBusy(session, held) };
        });
      for (const id of chatsToClose(chats, lastShown, now)) closeChat(provider, id);
    }
    for (const id of lastShown.keys()) if (!loaded.has(id)) lastShown.delete(id);
  }

  // Chats kept loaded for reasons outside their session: a prompt in flight, a host prompt, a provider switch.
  function heldChats() {
    const marks = providers.activityMarks();
    return new Set([...marks.working, ...marks.attention, ...browser.waitingSessions(), ...store.diskWorking, ...store.switching.keys(), ...store.unsent]);
  }

  function closeChat(provider: Provider, id: string) {
    store.mentions.delete(id);
    const closed = provider
      .forgetSession(id)
      .catch(() => {})
      .finally(() => store.closing.delete(id));
    store.closing.set(id, closed);
  }

  function sameIds(left: readonly string[], right: readonly string[]) {
    if (left.length !== right.length) return false;
    return left.every((id, index) => id === right[index]);
  }

  function activity(): Pick<Snapshot, "working" | "attention" | "unread"> {
    for (const id of desk.ids()) store.unreadIds.delete(id);
    const marks = providers.activityMarks();
    const working = [...new Set([...marks.working, ...store.diskWorking])];
    for (const id of working) store.unreadIds.delete(id);
    const attention = [...new Set([...marks.attention, ...browser.waitingSessions()])];
    for (const id of attention) store.unreadIds.delete(id);
    return { working, attention, unread: [...store.unreadIds] };
  }

  function presentedOpen(): OpenSession[] {
    const windows = contextWindows();
    return desk
      .ids()
      .map((id) => {
        const provider = providers.forSession(id);
        const raw = provider.getSession(id);
        if (!raw) return null;
        const presented = withStretches(id, presentSession(raw, windows, store.mentions.get(id)));
        const prompt = presented.pendingPermission ? null : browser.prompt(id);
        if (prompt) presented.pendingPermission = presentPrompt(prompt);
        const gone = store.goneFolders.get(id);
        // A routine run is in no sidebar list, so its name from sidebar.json comes along here.
        const title = store.sidebarState.titles[id] || providers.catalogTitle(id);
        return { ...presented, title, provider: provider.id, suggestions: suggestions.list(id), ...(gone ? { folderGone: gone } : {}) };
      })
      .filter((view): view is OpenSession => Boolean(view));
  }

  // A switched chat shows its earlier stretches above the one running now. The live session's own replay of an
  // earlier stretch is left out, and a message shows only the person's words of the handoff it carried.
  function withStretches(id: string, presented: PresentedSession): PresentedSession {
    const failure = sessionErrors.get(id);
    if (failure) {
      presented.error = failure.message;
      presented.errorProvider = failure.source;
    }
    const record = chatRecords.get(id);
    // A settled run only delivers its held messages: the chat shows its new session again.
    const found = store.switching.get(id);
    const run = found?.settled ? null : found;
    // While a switch runs, the chat shows as it was when the switch began, and it takes no turn of its own.
    const shown = run ? presented.transcript.slice(0, run.at) : presented.transcript;
    const transcript = withoutSummaryTurns(record?.skip ? shown.slice(record.skip) : shown).map(ownWords);
    const busy = run
      ? { switching: { ...run.view, held: run.held.map((held) => String(held.text ?? "")) }, status: "idle" as const, activity: null, pendingPermission: null, queue: [] }
      : { queue: presented.queue.map((entry) => ({ ...entry, text: stripHandoff(entry.text) })) };
    if (!record) return { ...presented, ...busy, transcript };
    return { ...presented, ...busy, transcript, stretches: record.stretches.map((stretch) => ({ ...stretch, items: presentFrozen(stretch.items) })), start: record.start };
  }

  function ownWords<T extends PresentedSession["transcript"][number]>(item: T): T {
    return item.type === "user" && item.text.startsWith("<") ? { ...item, text: stripHandoff(item.text) } : item;
  }

  function presentedStored(session: SessionState, provider: Provider): OpenSession {
    return { ...withStretches(session.id, presentSession(session, contextWindows())), title: providers.catalogTitle(session.id), provider: provider.id, suggestions: [] };
  }

  function providerViews(): ProviderView[] {
    return providers.list().map((provider) => ({
      id: provider.id,
      label: provider.label,
      enabled: providers.isEnabled(provider),
      status: provider.status,
      error: provider.status === "failed" ? messageOf(provider.lastError) || null : null,
      capabilities: { ...provider.capabilities, btw: Boolean(provider.sideQuestion) },
      modes: [...provider.modes],
      defaultMode: providers.defaultMode(provider),
    }));
  }

  // The models of every provider that is on, for a new chat, the default provider's first.
  function composerCatalog(): ComposerCatalog {
    const models: ComposerCatalog["models"] = [];
    let defaultModel = "";
    let defaultEffort = "";
    // No provider on offers no models.
    const on = providers.enabled();
    const first = providers.defaultProvider();
    for (const provider of on.includes(first) ? [first, ...on.filter((other) => other !== first)] : on) {
      let catalog;
      try {
        catalog = provider.models();
      } catch {
        continue;
      }
      for (const model of catalog.models) {
        models.push({ ...model, value: `${provider.id}:${model.value}`, provider: provider.id, model: model.value, group: provider.label });
      }
      if (!defaultModel && catalog.models.length) {
        const chosen = catalog.models.find((model) => model.value === catalog.defaultModel) ?? catalog.models[0];
        defaultModel = chosen ? `${provider.id}:${chosen.value}` : "";
        defaultEffort = catalog.defaultEffort;
      }
    }
    return { defaultModel, defaultEffort, models };
  }

  // The same folder in the checkout a worktree was added from, so a worktree of mono/app finds mono/app's board.
  function checkoutOf(folder: string): string {
    const place = readGitWorktree(folder);
    if (place?.root) return path.join(place.home, path.relative(place.root, canonicalCwd(folder)));
    return sidebarHome(folder);
  }

  // A removed worktree has no .git file left to name its checkout, so its path names it.
  function placeProject(cwd: string | null | undefined): ProjectPlace {
    const found = locateProject(cwd);
    if (found.worktree || !found.home || isDirectory(found.home)) return found;
    const gone = goneWorktree(found.home, store.sidebarState.projects.map((project) => project.cwd), paths.worktrees);
    return gone ? { home: gone.project, worktree: gone.worktree } : found;
  }

  // Where a chat whose folder is gone can continue: the checkout its worktree came from, if the sidebar knows it.
  function goneFolderOf(sessionId: string, folder: string): Promise<GoneFolder> {
    const found = goneWorktree(folder, store.sidebarState.projects.map((project) => project.cwd), paths.worktrees);
    const listed = store.snapshot.projects.find((project) => project.sessions.some((session) => session.id === sessionId && session.worktree));
    const home = found?.folder ?? (listed && isDirectory(listed.cwd) ? listed.cwd : null);
    return goneFolder(folder, home);
  }

  function sidebarHome(folder: string): string {
    const located = placeProject(folder);
    return located.home || canonicalCwd(folder);
  }

  // Applies a change to the sidebar as sidebar.json has it now, and saves it.
  function changeSidebar(change: (state: SidebarState) => SidebarState) {
    store.sidebarState = change(currentSidebar(store.sidebarState, paths.sidebar));
    writeSidebar(store.sidebarState, paths.sidebar);
  }

  const chatFolders: ChatFolders = {
    projectOf: (sessionId) => store.snapshot.projects.find((project) => project.sessions.some((session) => session.id === sessionId)) ?? null,
    move(cwd, sessionIds, name) {
      let made = false;
      changeSidebar((state) => {
        const found = folderNamed(state, cwd, name);
        if (found) return moveToFolder(state, sessionIds, found.id);
        made = true;
        const id = randomBytes(6).toString("hex");
        return moveToFolder(addFolder(state, cwd, name, id), sessionIds, id);
      });
      publish({ ...catalogSnapshot() });
      return made;
    },
  };

  function earlierOf(id: string): Pick<SessionIndexRow, "earlierProviders"> {
    const stretches: FrozenStretch[] = chatRecords.get(id)?.stretches ?? [];
    return stretches.length ? { earlierProviders: stretches.map((stretch) => stretch.provider) } : {};
  }

  // The sessions in the app's index, with their session folder's summary where the harness keeps one. A chat that switched
  // provider is one row under its own id, on the provider it runs on now.
  function sidebarRows(): { rows: SessionIndexRow[]; subagentIds: string[] } {
    const indexed = sessionIndex();
    const summaries = new Map(indexed.rows.map((row) => [row.id, row]));
    // A switched chat's row comes from the index, which follows its folder. The summary keeps the first one.
    const switched = (id: string) => Boolean(chatRecords.get(id) && providers.index.get(id)?.cwd);
    const rows: SessionIndexRow[] = [];
    for (const entry of providers.index.all()) {
      const summary = switched(entry.id) ? undefined : summaries.get(entry.id);
      if (summary) rows.push({ ...summary, provider: entry.provider, ...earlierOf(entry.id) });
      else if (entry.cwd) rows.push({ id: entry.id, cwd: canonicalCwd(entry.cwd), title: entry.title || "New session", updatedAt: entry.updatedAt, provider: entry.provider, ...earlierOf(entry.id) });
    }
    const present = new Map<string, boolean>();
    const exists = (cwd: string) => {
      if (!present.has(cwd)) present.set(cwd, isDirectory(cwd));
      return present.get(cwd);
    };
    const marked = rows.map((row): SessionIndexRow => (row.cwd && !exists(row.cwd) ? { ...row, gone: true } : row));
    return { rows: marked, subagentIds: indexed.subagentIds };
  }

  function chatRows(): SessionIndexRow[] {
    // A switched chat keeps its own title, which the harness it runs on now does not know.
    const catalog = providers.catalog().filter((entry) => entry.sessionId === undefined || (providers.index.get(entry.sessionId) && !store.deletedIds.has(entry.sessionId) && !chatRecords.get(entry.sessionId)));
    const indexed = sidebarRows();
    return rowsWithCatalog(indexed.rows, catalog, indexed.subagentIds).filter((row) => !store.deletedIds.has(row.id));
  }

  function catalogSnapshot(): Pick<Snapshot, "projects" | "chats" | "tickets" | "notices"> {
    const home = paths.chatHome;
    store.sidebarState = currentSidebar(store.sidebarState, paths.sidebar);
    const before = store.sidebarState.chatIds.length;
    if (surfaces.surface() === "chat") {
      for (const id of desk.ids()) store.sidebarState = noteChat(store.sidebarState, id);
    }
    // Routine runs live on the Routines page, and stay in chatRows so their worktree counts as in use.
    const runs = routineRuns.sessionIds();
    const rows = chatRows().filter((row) => !runs.has(row.id));
    const worktreeRoot = canonicalCwd(paths.worktrees);
    const arranged = arrangeSidebar(rows, store.sidebarState, home, placeProject, worktreeRoot);
    store.sidebarState = arranged.state;
    if (arranged.changed || store.sidebarState.chatIds.length !== before) writeSidebar(store.sidebarState, paths.sidebar);
    return {
      projects: arranged.projects,
      chats: arrangeChats(rows, store.sidebarState, home, placeProject, worktreeRoot),
      tickets: { ...presentTickets(readTickets(paths.tickets)), changes: store.boardChanges },
      notices: shownNotices(),
    };
  }

  function safeSessions(folder: string): SessionListRow[] {
    try {
      return applyTitles(listSessions(folder).filter((row) => providers.index.get(row.id) && !store.deletedIds.has(row.id)).slice(0, 30), store.sidebarState);
    } catch {
      return [];
    }
  }

  // The provider whose failure the banner shows, or "" for any other error. Background traffic of
  // another provider (a streaming turn, a start) leaves that failure alone. A user action that
  // clears the banner clears it for every provider.
  let errorOwner = "";

  function providerError(provider: Provider, error: unknown) {
    publish({ error: messageOf(error) || `${provider.label} failed` });
    errorOwner = provider.id;
  }

  function sessionError(sessionId: string, source = providers.forSession(sessionId)) {
    const provider = providers.forSession(sessionId);
    const turnIndex = provider.getSession(sessionId)?.turnIndex;
    return (error: unknown) => {
      const session = provider.getSession(sessionId);
      if (!session || providers.forSession(sessionId).id !== provider.id || session.turnIndex !== turnIndex) return;
      sessionErrors.set(sessionId, { message: messageOf(error) || "The chat failed", provider: provider.id, source: source.id, turnIndex });
      publish({ open: presentedOpen(), ...activity() });
    };
  }

  // The banner reset for background traffic of this provider.
  function clearedBy(provider: Provider): Pick<Snapshot, "error"> | Record<string, never> {
    return errorOwner && errorOwner !== provider.id ? {} : { error: null };
  }

  function publish(partial: Partial<Snapshot>) {
    if ("error" in partial) errorOwner = "";
    // A change that waits for the frame arrived before this error, so it must not clear it.
    if (partial.error) openClears = false;
    store.snapshot = { ...store.snapshot, ...partial, composer: composerCatalog(), providers: providerViews() };
    if (partial.usage) {
      try {
        savedUsage.save(partial.usage);
      } catch {
        // The next launch then waits for its reads.
      }
    }
    // Pages hold the whole snapshot from connecting, so each event carries only the fields whose JSON changed.
    // A page that did not ask for changes still gets the whole snapshot.
    const changed: string[] = [];
    for (const [key, value] of Object.entries(store.snapshot)) {
      const json = JSON.stringify(value);
      if (sentFields.get(key) === json) continue;
      sentFields.set(key, json);
      changed.push(`${JSON.stringify(key)}:${json}`);
    }
    if (!changed.length) return;
    const payload = `data: {${changed.join(",")}}\n\n`;
    let whole = "";
    for (const client of store.clients) {
      if (client.changes) client.write(payload);
      else client.write((whole ||= `data: {${[...sentFields].map(([key, json]) => `${JSON.stringify(key)}:${json}`).join(",")}}\n\n`));
    }
  }

  function createWorktree(folder: string, gitRef: string, providerId: string, options: Pick<WorktreeOptions, "name" | "branch"> = {}) {
    return createHarnessWorktree(providerId, folder, gitRef, { ...options, root: paths.worktrees });
  }

  const host: Host = {
    providers,
    desk,
    surfaces,
    voice,
    quietVolume,
    devices,
    store,
    suggestions,
    browser,
    simulator,
    hostTools,
    terminals,
    remote: remote ?? null,
    chatRecords,
    routines,
    routineEdits,
    appSettings,
    followAppSettings,
    port,
    paths,
    harnessCommands,
    sak,
    publish,
    presentedOpen,
    presentedStored,
    activity,
    catalogSnapshot,
    chatRows,
    safeSessions,
    ensureProvider,
    providerError,
    sessionError,
    clearSessionError: (sessionId) => sessionErrors.delete(sessionId),
    clearedBy,
    sessionRules,
    sidebarHome,
    checkoutOf,
    goneFolderOf,
    changeSidebar,
    followOpenSessions,
    refreshUsage,
    pollUsage,
    createWorktree,
  };
  const routes: Route[] = [
    ...sessionRoutes(host),
    ...reviewRoutes(host),
    ...folderRoutes(host),
    ...sidebarRoutes(host),
    ...boardRoutes(host),
    ...deviceRoutes(host),
    ...terminalRoutes(host),
    ...voiceRoutes(host),
    ...providerRoutes(host),
    ...suggestionRoutes(host),
    ...mcpRoutes(host),
    ...browserRoutes(host),
    ...remoteRoutes(host),
    ...routineRoutes(host),
    ...appSettingRoutes(host),
  ];

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const refused = refuseRequest(req, url, { port, token });
    if (refused) {
      sendJson(res, refused.status, { error: refused.error });
      return;
    }
    try {
      await dispatch(routes, req, res, url);
    } catch (error) {
      if (res.headersSent) return;
      sendJson(res, statusOf(error, 500), { error: messageOf(error) });
    }
  }

  async function guardedDeviceStream(address: URL, req: IncomingMessage, socket: Duplex, head: Buffer) {
    if (refuseRequest(req, address, { port, token })) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    await openDeviceStream(host, address, req, socket, head);
  }

  function guardedBrowserLink(address: URL, req: IncomingMessage, socket: Duplex, head: Buffer) {
    if (refuseRequest(req, address, { port, token })) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    openBrowserLink(host, req, socket, head);
  }

  async function guardedTerminalStream(address: URL, req: IncomingMessage, socket: Duplex, head: Buffer) {
    if (refuseRequest(req, address, { port, token })) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    openTerminalStream(host, address, req, socket, head);
  }

  return {
    store,
    handle,
    refreshNotices,
    refreshDiskWorking,
    pollUsage,
    openDeviceStream: guardedDeviceStream,
    openBrowserLink: guardedBrowserLink,
    openTerminalStream: guardedTerminalStream,
    chatFolders,
    routines,
    routineTools: {
      edits: routineEdits,
      defaults: (sessionId) => ({
        cwd: chatFolders.projectOf(sessionId)?.cwd || providers.getSession(sessionId)?.cwd || "",
        provider: providers.forSession(sessionId).id,
      }),
      providers: () => providers.enabled(),
      runMode: (routine) => {
        const provider = providers.get(routine.provider);
        return provider ? runMode(provider, routine.mode, providers.defaultMode(provider)) : routine.mode;
      },
    },
    revealSession(sessionId) {
      const cwd = providers.getSession(sessionId)?.cwd || routines.runOf(sessionId)?.run.cwd || "";
      if (!sessionId || !cwd) return;
      revealNonce += 1;
      const chat = canonicalCwd(cwd) === canonicalCwd(paths.chatHome);
      publish({ reveal: { sessionId, cwd, chat, nonce: revealNonce, at: Date.now() } });
    },
  };
}

export function builderFolder(chatHome: string) {
  return (cwd: string) => canonicalCwd(cwd) !== canonicalCwd(chatHome);
}

// The host's MCP tool groups: the plan, task suggestions, the chat id, the browser pane, the simulators, pr_status,
// chat folders and routines.
export function hostToolGroups({ sessionOf, setPlan, planTool, suggestions, browser, simulator, builds, devices, folders, routines }: { sessionOf: (id: string) => SessionState | null | undefined; setPlan: PlanHost["setPlan"]; planTool: () => boolean; suggestions: TaskSuggestions; browser: Browser; simulator: Simulator; builds: Builds; devices: Devices; folders?: ChatFolders; routines?: () => RoutineToolHost }) {
  const modeOf = (id: string) => sessionOf(id)?.modeId ?? null;
  return [
    { ...planTools({ sessionOf, setPlan }), enabled: planTool },
    suggestTools(suggestions),
    chatIdTools(),
    browserTools(browser, { modeOf }),
    simulatorTools(simulator, builds, browser, {
      modeOf,
      cwdOf: (id) => sessionOf(id)?.cwd ?? null,
      saveThumb: (data) => browser.saveThumb(data),
      focus: (owner, device) => devices.focus(owner, device),
    }),
    pullRequestTools((id) => sessionOf(id)?.cwd ?? null),
    ...(folders ? [folderTools(folders)] : []),
    ...(routines ? [routineTools(routines, browser, { modeOf })] : []),
  ];
}

// A browser, simulator or routine action waiting for the person, shown as the session's permission card.
function presentPrompt(prompt: HostPrompt): PresentedPermission {
  return { toolCallId: null, title: prompt.title, name: prompt.kind, kind: prompt.kind, rawInput: prompt.detail, role: "other", options: prompt.options };
}
