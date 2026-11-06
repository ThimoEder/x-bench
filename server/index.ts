import http, { type IncomingMessage, type ServerResponse } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { GrokProvider } from "../bridge/grok/provider.ts";
import { ClaudeProvider } from "../bridge/claude/provider.ts";
import { ChatGptProvider } from "../bridge/chatgpt/provider.ts";
import { createClaudeSettings } from "./providers/claudeSettings.ts";
import { findProgram } from "../bridge/command.ts";
import { createHarnessCommands } from "./chat/harnessCommands.ts";
import { createModelList } from "./providers/modelCache.ts";
import { createProviders } from "./providers/providers.ts";
import { createProviderSettings } from "./providers/providerSettings.ts";
import { createSessionIndex, notePreset } from "./chat/sessionIndex.ts";
import { createChatRecords } from "./chat/chatRecords.ts";
import { appendBtwHistory, clearBtwHistory, loadBtwHistory, ownBtwDir } from "./chat/btw.ts";
import { findSessionDir } from "../bridge/grok/sessionFiles.ts";
import { builderFolder, createApp, hostToolGroups } from "./app.ts";
import type { ChatFolders } from "./sidebar/folderTools.ts";
import { createDesk } from "./desk.ts";
import { createVoice, modelDir } from "./voice/voice.ts";
import { createQuietVolume } from "./voice/quietVolume.ts";
import { createDevices } from "./devices/devices.ts";
import { messageOf, sendJson } from "./http.ts";
import { grokMessage, isParentPort, isStopMessage, keepAwakeMessage, listeningMessage, notifyMessage, openSessionOf, secretKeyOf, type ParentPort } from "./parentPort.ts";
import { sealFile, setSecretKey } from "./secrets/secrets.ts";
import { contentType, createStaticUi, pagePolicy, takeUiSettings } from "./staticUi.ts";
import { refusePage } from "./apiGuard.ts";
import { createUpgradeRouter } from "./providers/upgrade.ts";
import { createLaunchToken, injectToken, removeTokenFile, writeTokenFile } from "./launchToken.ts";
import { createHostSak } from "./board/sak/sakServe.ts";
import { createTaskSuggestions } from "./board/taskSuggestions.ts";
import { createBrowser } from "./browser/browser.ts";
import { createHostTools } from "./mcp/mcp.ts";
import { createSimulator } from "./devices/simulator.ts";
import { createBuilds } from "./devices/ios/xcodeBuild.ts";
import { createTerminals } from "./terminal/terminal.ts";
import { createRemote, PUBLIC_FILES } from "./remote/remote.ts";
import { createDeviceStore } from "./devices/remoteDevices.ts";
import { createRemoteSettings, createTunnel } from "./remote/remoteTunnel.ts";
import { localForward } from "./remote/localTunnel.ts";
import { xBenchPaths } from "./paths.ts";

// A stray rejected promise is logged and the host stays up with its sessions.
process.on("unhandledRejection", (reason) => {
  console.error(`unhandled rejection: ${reason instanceof Error ? reason.stack || reason.message : String(reason)}`);
});

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const uiRoot = path.join(repoRoot, "ui");
const port = Number(process.env.PORT || 8787);
const uiSettings = takeUiSettings();
const desktop: unknown = Reflect.get(process, "parentPort");
const sealing = isParentPort(desktop) ? await secretKey(desktop) : { key: null, dev: true };
setSecretKey(sealing.key, sealing.dev);
const paths = xBenchPaths(os.homedir(), process.env, sealing.dev);
for (const [file, fields] of [[paths.sak, ["token"]], [paths.jira, ["token"]], [paths.trello, ["apiKey", "token"]], [paths.remoteSettings, ["authtoken"]]] as const) sealFile(file, fields);
// A new token each launch. The page gets it in index.html, scripts from the file.
const token = createLaunchToken();
const tokenPath = paths.launchToken(port);
const suggestions = createTaskSuggestions(paths.suggestions);
const browser = createBrowser(paths.browserPages);
const simulator = createSimulator({ logDir: paths.simulatorLogs });
const builds = createBuilds({ dir: paths.simulatorBuilds });
const devices = createDevices();
// providers and app are read only once a tool runs, after they are built below.
const folders: ChatFolders = {
  projectOf: (sessionId) => app.chatFolders.projectOf(sessionId),
  move: (cwd, sessionIds, name) => app.chatFolders.move(cwd, sessionIds, name),
};
const hostTools = createHostTools(hostToolGroups({ sessionOf: (id) => providers.getSession(id), suggestions, browser, simulator, builds, devices, folders, routines: () => app.routineTools }), { builder: builderFolder(paths.chatHome) });
const sessionTools = hostTools.sessionTools({ port, token });

const grok = new GrokProvider({
  sessionTools,
  onAgentProcess: (pid, running) => {
    if (isParentPort(desktop)) desktop.postMessage(grokMessage(pid, running));
  },
  readSideHistory: (sessionId, cwd) => loadBtwHistory(findSessionDir(cwd, sessionId)),
  clearSideHistory: (sessionId, cwd) => clearBtwHistory(findSessionDir(cwd, sessionId)),
});
const sessionIndex = createSessionIndex(paths.sessionIndex);
const claudeSettings = createClaudeSettings(paths.claudeSettings);
const claudeModels = createModelList(paths.claudeModels);
const chatgptModels = createModelList(paths.chatgptModels);
const harnessCommands = createHarnessCommands(paths.harnessCommands);
const sak = createHostSak(paths.sak);
// Claude runs through the installed claude, with the config folder ~/.x-bench/claude.json names.
// The settings page can change it while the host runs, so it is read again each time it matters.
// The index keeps each thread's model, effort and permission mode, which a load comes back without.
const claude = new ClaudeProvider({
  sessionTools,
  readSettings: () => claudeSettings.read(),
  readModels: claudeModels.read,
  saveModels: claudeModels.save,
  readPicks: (sessionId) => {
    const row = sessionIndex.get(sessionId);
    return row?.provider === "claude" ? { model: row.harnessModel, effort: row.harnessEffort, mode: row.harnessMode } : null;
  },
  savePicks: (sessionId, picks) => {
    sessionIndex.record({ id: sessionId, provider: "claude", harnessModel: picks.model, harnessEffort: picks.effort, harnessMode: picks.mode });
  },
  readSideHistory: (sessionId) => loadBtwHistory(ownBtwDir(sessionId, paths.btw)),
  saveSideAnswer: (sessionId, entry) => appendBtwHistory(ownBtwDir(sessionId, paths.btw), entry),
  clearSideHistory: (sessionId) => clearBtwHistory(ownBtwDir(sessionId, paths.btw)),
});
// ChatGPT runs through the installed codex, with the login codex keeps in its own home folder. The index keeps
// each session's preset, which Codex forgets when a session loads again.
const chatgpt = new ChatGptProvider({
  sessionTools,
  findCodex: () => findProgram("codex"),
  readModels: chatgptModels.read,
  saveModels: chatgptModels.save,
  readCommands: (cwd) => harnessCommands.read("chatgpt", cwd),
  readPreset: (sessionId) => sessionIndex.chatOf(sessionId)?.harnessMode,
  savePreset: (sessionId, preset) => notePreset(sessionIndex, sessionId, preset),
  readSideHistory: (sessionId) => loadBtwHistory(ownBtwDir(sessionId, paths.btw)),
  saveSideAnswer: (sessionId, entry) => appendBtwHistory(ownBtwDir(sessionId, paths.btw), entry),
  clearSideHistory: (sessionId) => clearBtwHistory(ownBtwDir(sessionId, paths.btw)),
});
const providers = createProviders([claude, grok, chatgpt], sessionIndex, createProviderSettings(paths.providerSettings), createChatRecords(paths.chats));
const terminals = createTerminals();
const quietVolume = createQuietVolume();
const remote = createRemote({
  port,
  token,
  devices: createDeviceStore({ file: paths.remoteDevices }),
  tunnel: createTunnel(),
  // A fixed port per host, so the phone's home-screen app keeps its address.
  local: createTunnel(localForward(port + 1000, { dir: paths.remoteCa })),
  settings: createRemoteSettings(paths.remoteSettings),
  handle: (req, res) => handle(req, res, true),
  onStop: () => void ui.stopRemote?.(),
  ...(process.env.X_BENCH_REMOTE_LOG === "1" ? { log: (line: string) => console.log(line) } : {}),
});
const app = createApp({
  providers,
  desk: createDesk(),
  voice: createVoice({ modelDir: modelDir(paths.voiceModels) }),
  quietVolume,
  devices,
  port,
  token,
  paths,
  harnessCommands,
  sak,
  // The folder new sessions start in. The packaged app starts the host in home.
  cwd: process.cwd(),
  suggestions,
  browser,
  simulator,
  builds,
  hostTools,
  terminals,
  remote,
  routines: {
    // X Bench Dev windows start their host with X_BENCH_ROUTINES=off.
    schedule: process.env.X_BENCH_ROUTINES !== "off",
    ...(isParentPort(desktop) ? { notify: (note: { title: string; body: string; sessionId?: string }) => desktop.postMessage(notifyMessage(note)) } : {}),
  },
  ...(isParentPort(desktop) ? { keepAwake: (on: boolean) => desktop.postMessage(keepAwakeMessage(on)) } : {}),
});

const server = http.createServer((req, res) => {
  handle(req, res).catch((error: unknown) => {
    if (res.headersSent) return;
    sendJson(res, 500, { error: messageOf(error) });
  });
});

// X_BENCH_UI=dist serves the page `npm run build` wrote to dist/ui, without
// Vite. Otherwise Vite serves ui/ with hot reload, as `npm run dev` always did.
// The packaged app sets X_BENCH_UI_DIR, because its bundled host does not sit
// next to dist/ui the way server/ does.
const ui = uiSettings.built ? builtUi(uiSettings.dir) : await devUi();

server.requestTimeout = 0;
server.headersTimeout = 0;
server.on("upgrade", createUpgradeRouter({ port, deviceStream: app.openDeviceStream, terminalStream: app.openTerminalStream, browserLink: app.openBrowserLink, hotReload: ui.hotReload }));

server.listen(port, "127.0.0.1", () => {
  // Written once the port is ours, so a second host that fails to bind leaves the running host's file alone.
  writeTokenFile(tokenPath, token);
  console.log(`X Bench http://127.0.0.1:${port}`);
  if (isParentPort(desktop)) desktop.postMessage(listeningMessage(port));
  void sak.sync();
  void remote.startIfEnabled();
  tick("routines", app.routines.tick);
});

// A throw inside a timer would end the host. It is logged and the next tick runs.
function tick(name: string, run: () => void) {
  try {
    run();
  } catch (error) {
    console.error(`${name} tick failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
const noticeTimer = setInterval(() => tick("notices", app.refreshNotices), 60_000);
noticeTimer.unref();
tick("turns", app.refreshDiskWorking);
const turnTimer = setInterval(() => tick("turns", app.refreshDiskWorking), 1000);
turnTimer.unref();
// Usage from elsewhere (a terminal, the web, another machine) reaches an open page within five minutes.
const usageTimer = setInterval(() => tick("usage", app.pollUsage), 5 * 60_000);
usageTimer.unref();
const routineTimer = setInterval(() => tick("routines", app.routines.tick), 30_000);
routineTimer.unref();

// remote is true for a request the remote listener checked and rewrote. Its page goes out without the launch token.
async function handle(req: IncomingMessage, res: ServerResponse, remote = false) {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const refused = refusePage(req, port);
  if (refused) {
    sendJson(res, refused.status, { error: refused.error });
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    await app.handle(req, res);
    return;
  }
  if (remote) ui.serveRemote(req, res, url);
  else ui.serve(req, res, url);
}

type Ui = {
  serve(req: IncomingMessage, res: ServerResponse, url: URL): void;
  // The page for a paired phone: always a built page, without the launch token.
  serveRemote(req: IncomingMessage, res: ServerResponse, url: URL): void;
  // Takes Vite's hot reload socket once the upgrade router has checked it.
  hotReload?: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
  // Ends what serveRemote started, once remote access is off.
  stopRemote?: () => Promise<void>;
  close(): Promise<void>;
};

function builtUi(dir = path.join(repoRoot, "dist", "ui")): Ui {
  const serve = createStaticUi(dir, token);
  return {
    serve: (req, res, url) => serve(req, res, url.pathname),
    serveRemote: (req, res, url) => serve(req, res, url.pathname, false),
    close: async () => {},
  };
}

// Vite is imported only here, so the built page never loads it.
async function devUi(): Promise<Ui> {
  const { build, createServer } = await import("vite");
  // Vite's socket listens here, not on the host's server, so an upgrade reaches it only through the upgrade
  // router's Host and Origin check. This server never binds a port, and the page connects to its own.
  const hotReload = http.createServer();
  const vite = await createServer({
    configFile: path.join(repoRoot, "vite.config.ts"),
    appType: "custom",
    // No CORS: the page is same-origin, and Vite's default would let any localhost origin read the token.
    server: { middlewareMode: true, ws: { server: hotReload }, fs: { allow: [repoRoot] }, cors: false },
  });
  // A phone over the tunnel gets a build of ui/, a handful of files to load over the internet. It starts with the
  // first remote page request and rebuilds on every change, so the phone sees the current code after a reload.
  let remotePage: Promise<ReturnType<typeof createStaticUi>> | null = null;
  let remoteBuild: { close(): Promise<void> } | null = null;
  function remoteUi() {
    remotePage ??= (async () => {
      const outDir = path.join(repoRoot, "node_modules", ".cache", "x-bench-remote-ui", String(port));
      // Emptied once here. A rebuild writes over the old files, so a page loading during it never finds the folder empty.
      fs.rmSync(outDir, { recursive: true, force: true });
      const watcher = await build({
        configFile: path.join(repoRoot, "vite.config.ts"),
        logLevel: "warn",
        build: { outDir, emptyOutDir: false, watch: {} },
      });
      if (!("on" in watcher)) return createStaticUi(outDir);
      remoteBuild = watcher;
      try {
        await new Promise<void>((resolve, reject) => {
          watcher.on("event", (event) => {
            if (event.code === "BUNDLE_END" || event.code === "ERROR") void event.result.close();
            if (event.code === "END") resolve();
            if (event.code === "ERROR") reject(event.error);
          });
        });
      } catch (error) {
        remoteBuild = null;
        await watcher.close();
        throw error;
      }
      return createStaticUi(outDir);
    })();
    remotePage.catch(() => {
      remotePage = null;
    });
    return remotePage;
  }

  return {
    hotReload: (req, socket, head) => hotReload.emit("upgrade", req, socket, head),
    serve(req, res, url) {
      vite.middlewares(req, res, async () => {
        const template = fs.readFileSync(path.join(uiRoot, "index.html"), "utf8");
        const html = injectToken(await vite.transformIndexHtml(url.pathname, template), token);
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html");
        // The token changes on every launch, so the page is never cached.
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Content-Security-Policy", pagePolicy(html));
        res.end(html);
      });
    },
    serveRemote(req, res, url) {
      if (PUBLIC_FILES.has(url.pathname)) {
        const file = path.join(uiRoot, "public", url.pathname.slice(1));
        res.writeHead(200, { "Content-Type": contentType(file), "Cache-Control": "no-cache" });
        fs.createReadStream(file).on("error", () => res.destroy()).pipe(res);
        return;
      }
      remoteUi()
        .then((serve) => serve(req, res, url.pathname, false))
        .catch((error: unknown) => {
          if (!res.headersSent) sendJson(res, 500, { error: messageOf(error) || "The page did not build" });
        });
    },
    async stopRemote() {
      const watcher = remoteBuild;
      remoteBuild = null;
      remotePage = null;
      await watcher?.close();
    },
    close: async () => {
      await remoteBuild?.close();
      await vite.close();
    },
  };
}

// A step that fails is logged and the rest still run, so a failing page close
// does not leave an agent running. The host stays up on an unhandled rejection,
// so shutdown must reach its exit itself.
async function shutdown() {
  let failed = false;
  const step = async (name: string, run: () => unknown) => {
    try {
      await run();
    } catch (error) {
      failed = true;
      console.error(`shutdown: ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  await step("quiet volume", () => quietVolume.restoreAll());
  await step("routines", () => app.routines.stop());
  await step("sak", () => sak.close());
  await step("simulator", () => simulator.close());
  await step("builds", () => builds.close());
  await step("terminals", () => terminals.stopAll());
  await step("token file", () => removeTokenFile(tokenPath, token));
  await step("server", () => server.close());
  await step("ui", () => ui.close());
  await step("providers", () => providers.stopAll());
  await step("remote access", () => remote.close());
  process.exit(failed ? 1 : 0);
}

process.on("SIGINT", () => {
  shutdown();
});
process.on("SIGTERM", () => {
  shutdown();
});
if (isParentPort(desktop)) {
  desktop.on("message", (message) => {
    if (isStopMessage(message.data)) shutdown();
    const opened = openSessionOf(message.data);
    if (opened) app.revealSession(opened);
  });
}

function secretKey(port: ParentPort): Promise<{ key: string | null; dev: boolean }> {
  return new Promise((resolve) => {
    port.on("message", ({ data }) => {
      const key = secretKeyOf(data);
      if (key !== undefined) resolve(key);
    });
  });
}
