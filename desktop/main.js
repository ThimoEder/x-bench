// The Electron main process. It runs the X Bench host in a utilityProcess,
// so a slow or crashing host cannot freeze the window, and shows a launch
// page until the host listens. X_BENCH_URL instead points the
// window at a host that is already running, such as `npm run dev`. Run from a
// checkout it is X Bench Dev, with a port and profile per checkout and the
// branch's feature label, and `--watch` restarts its host on a change.
import { app, BaseWindow, ipcMain, Menu, nativeTheme, Notification, powerSaveBlocker, safeStorage, session, shell, utilityProcess, WebContentsView } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appPageUrl, registerAppScheme, serveAppPages } from "./appPages.js";
import { branchLabel, devAppName, gitBranch, groupUpdate, hostNote, hostOrigin, importGraph, keepAwakeOf, keepTail, labelArg, listeningPort, logFile, envCommand, envFromShell, hostShellEnv, loginShellEnv, route, watchedFolders } from "./host.js";
import { createBrowserPane } from "./browser/browser.js";
import { createUnityView } from "./unity/unityView.js";
import { createRailTip } from "./railTip.js";
import { handleScreenshots } from "./screenshot/screenshot.js";
import { createUpdater } from "./updater/updater.js";
import { secretKey } from "./secrets/secretKey.js";
import { createAdapterRelay } from "./adapters/adapters.js";
import { openLicensesWindow } from "./licenses/licensesWindow.js";

// Apart from `npm run dev` on 8787. The installed app has 8797, and each X
// Bench Dev takes the first free port from 8798. A packaged copy sets
// X_BENCH_APP_NAME, X_BENCH_PORT and X_BENCH_HOME in its Info.plist.
const copyName = app.isPackaged ? process.env.X_BENCH_APP_NAME?.trim() || "" : "";
// macOS ignores HOME in an Info.plist, so a copy's home arrives as X_BENCH_HOME. Only the host gets it as HOME,
// since the main process needs the real one to find the login Keychain.
const home = (copyName && process.env.X_BENCH_HOME) || os.homedir();
const basePort = copyName ? Number(process.env.X_BENCH_PORT) : app.isPackaged ? 8797 : 8798;
const portTries = 50;
const startTimeout = 30_000;
const stopTimeout = 5_000;
// As bridge/grok/runtime.ts stop() gives Grok's group before SIGKILL.
const groupStopTimeout = 2_000;
// Editors and agents save several files in a row.
const watchDelay = 300;
const userAgentMark = "X Bench Desktop";
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
// In dev the host runs from server/ with Vite. The packaged app runs the
// bundle from desktop/bundle-host.js on the page `vite build` wrote.
const hostEntry = fileURLToPath(new URL(app.isPackaged ? "../dist/host/index.mjs" : "../server/index.ts", import.meta.url));
const builtUi = fileURLToPath(new URL("../dist/ui", import.meta.url));
const errorPageUrl = appPageUrl("error.html");
// The packaged app's icon comes from electron-builder. From a checkout the Dock
// shows the icon with an amber corner.
const devIcon = fileURLToPath(new URL("build/icon-dev.png", import.meta.url));
const preload = fileURLToPath(new URL("preload.cjs", import.meta.url));

const attached = Boolean(process.env.X_BENCH_URL);
const watching = !app.isPackaged && !attached && process.argv.includes("--watch");
// What X Bench Dev is testing, shown in its window: `--label`, else the branch.
const label = app.isPackaged || attached ? "" : (labelArg(process.argv) ?? branchLabel(gitBranch(repoRoot))).trim();
const appName = app.isPackaged ? copyName || "X Bench" : devAppName(label);
// X Bench Dev runs work in progress, so it leaves the routine schedule to the installed app unless started with
// --routines. Run now works in it either way.
const routineEnv = app.isPackaged || process.argv.includes("--routines") ? {} : { X_BENCH_ROUTINES: "off" };
let appPort = basePort;
let origin = attached ? hostOrigin(process.env.X_BENCH_URL) : `http://127.0.0.1:${appPort}`;
if (!origin) {
  console.error(`X_BENCH_URL must be http://127.0.0.1:<port>, got ${process.env.X_BENCH_URL}`);
  process.exit(1);
}

function sameOrigin(value) {
  return route(value, origin) === "inside";
}

// The host process, whether it listens yet, why it stopped, and its last
// output for the error page.
let host = null;
let listening = false;
let failure = null;
let output = "";
let stopping = null;
let loginEnv = null;
let envShell = null;
let quitting = false;
// Grok groups the app is stopping after their host exited.
const reaping = new Set();
// The browser pane, created once the app is ready.
let pane = null;
let unityView = null;
let railTip = null;
let updater = null;
// Each window's page. The page is a view of its own, so the browser pane's tabs can sit beneath it.
const pages = new WeakMap();
// A transparent window has no corner of its own, so the page is rounded to this one. --window-corner in
// ui/styles.css must match it.
const WINDOW_CORNER = 26;
// The power save blocker the keep-awake setting holds, and the notifications on screen, kept so their clicks still fire.
let awakeBlocker = null;
const notes = new Set();
// X Bench Dev has no Developer ID signature, so it gets no key and its host keeps secrets in plaintext.
let sealKey;

app.setName(appName);
const log = logFile(path.join(app.getPath("logs"), "output.log"));
for (const stream of [process.stdout, process.stderr]) {
  const write = stream.write.bind(stream);
  stream.write = (chunk, ...rest) => {
    log(chunk);
    return write(chunk, ...rest);
  };
}
process.on("uncaughtExceptionMonitor", (error) => console.error(error));
app.on("child-process-gone", (_event, { type, name, reason }) => {
  console.error(`${name || type} process gone (${reason}).`);
});
console.log(`${appName} ${app.getVersion()} starts from ${app.getAppPath()} on macOS ${process.getSystemVersion()} (${process.arch}).`);
// One profile per checkout, which also gives each its own single-instance
// lock, so dev apps from several worktrees run at once.
if (!app.isPackaged) {
  const profile = path.join(app.getPath("appData"), "X Bench Dev", path.basename(repoRoot));
  fs.mkdirSync(profile, { recursive: true });
  app.setPath("userData", profile);
} else if (copyName) {
  const profile = path.join(app.getPath("appData"), copyName);
  fs.mkdirSync(profile, { recursive: true });
  app.setPath("userData", profile);
}
// The agent keeps working in the browser pane while another window covers the app, so covered windows keep
// drawing.
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
registerAppScheme();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const window = mainWindow();
    if (!window) {
      createWindow();
      return;
    }
    if (window.isMinimized()) window.restore();
    window.show();
    app.focus({ steal: true });
  });

  app.whenReady().then(async () => {
    app.userAgentFallback = `${app.userAgentFallback} ${userAgentMark}`;
    if (!app.isPackaged) app.dock?.setIcon(devIcon);
    serveAppPages();
    guardSession();
    keepTheme();
    handleScreenshots(sameOrigin);
    pane = createBrowserPane({ origin, home });
    unityView = createUnityView({ origin: () => origin });
    railTip = createRailTip({ origin: () => origin });
    updater = createUpdater({ origin: () => origin });
    // The app's own host links once it listens, since X Bench Dev may move to another port first.
    if (attached) pane.connect();
    if (attached) {
      createWindow();
      return;
    }
    loginEnv = readLoginEnv();
    if (!app.isPackaged) {
      appPort = await freePort(basePort);
      origin = `http://127.0.0.1:${appPort}`;
    }
    show();
    startHost();
    if (watching) watchHost();
  });

  // macOS keeps the app running with no window. The Dock icon brings it back.
  app.on("activate", () => {
    if (!mainWindow()) createWindow();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  // Quitting asks the host to run its own shutdown, which stops Grok (it runs
  // detached), the device mirror and Vite. A Grok group the app is stopping
  // itself gets its SIGKILL before the app exits.
  app.on("before-quit", (event) => {
    quitting = true;
    pane?.stop();
    unityView?.stop();
    // A login shell still printing its environment runs in its own session and
    // would outlive the app.
    if (envShell) killGroup(envShell.pid);
    if (!host && !reaping.size) return;
    event.preventDefault();
    (host ? stopHost() : Promise.resolve()).then(() => Promise.all(reaping)).then(() => app.quit());
  });

  // Ctrl+C on `npm run app` quits the same way.
  process.on("SIGINT", () => app.quit());
  process.on("SIGTERM", () => app.quit());
}

async function movePort() {
  appPort = await freePort(appPort + 1);
  origin = `http://127.0.0.1:${appPort}`;
  startHost();
}

async function freePort(from) {
  for (let port = from; port < from + portTries; port += 1) {
    if (await portFree(port)) return port;
  }
  return from;
}

function portFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

// An app opened from Finder lacks the shell profile's environment. Profiles can wait on stdin or leave subshells
// running, and an interactive shell ignores SIGTERM, so stdin is empty and the shell's whole group gets SIGKILL
// once the environment is printed or after 5 seconds. The environment holds the user's secrets and is never logged.
function readLoginEnv() {
  return new Promise((resolve) => {
    let output = "";
    let done = false;
    const shell = spawn(process.env.SHELL || "/bin/zsh", ["-ilc", envCommand()], {
      stdio: ["ignore", "pipe", "ignore"],
      detached: true,
      env: loginShellEnv(process.env),
    });
    envShell = shell;
    const finish = (env) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      envShell = null;
      killGroup(shell.pid);
      resolve(env);
    };
    const timer = setTimeout(() => finish(null), 5000);
    shell.stdout.on("data", (chunk) => {
      output += chunk;
      const env = envFromShell(output);
      if (env) finish(env);
    });
    shell.on("error", () => finish(null));
    shell.on("close", () => finish(envFromShell(output)));
  });
}

async function startHost() {
  listening = false;
  failure = null;
  output = "";
  const shellEnv = await loginEnv;
  if (quitting) return;
  const built = app.isPackaged ? { X_BENCH_UI: "dist", X_BENCH_UI_DIR: builtUi } : {};
  // The host starts and stops SAK, because Setup talks to the host. The
  // packaged app has only the binary under Contents/Resources/sak, so SAK_ASSETS
  // names a missing folder and the website comes from sak.json.
  // From a checkout the host looks in SAK_ROOT, next to this repo, or in
  // vendor/sak. Paths already in the environment win.
  const sak = app.isPackaged
    ? { SAK_BINARY: path.join(process.resourcesPath, "sak", "sak"), SAK_ASSETS: path.join(process.resourcesPath, "sak", "assets") }
    : {};
  // The iOS simulator helper sits under Contents/Resources/sim-helper and the Android helpers under
  // Contents/Resources/android-helper. From a checkout the host finds desktop/devices/sim-helper/build and
  // desktop/devices/android-helper/build.
  const simHelper = app.isPackaged
    ? {
        X_BENCH_SIM_HELPER: path.join(process.resourcesPath, "sim-helper", "xbench-sim"),
        X_BENCH_ANDROID_HELPER: path.join(process.resourcesPath, "android-helper", "xbench-android.jar"),
        X_BENCH_ANDROID_ENCODER: path.join(process.resourcesPath, "android-helper", "xbench-encode"),
        X_BENCH_SCRCPY_SERVER: path.join(process.resourcesPath, "android-helper", "scrcpy-server"),
      }
    : {};
  const child = utilityProcess.fork(hostEntry, [], {
    serviceName: "X Bench host",
    // New sessions start in this folder.
    cwd: app.isPackaged ? home : repoRoot,
    stdio: "pipe",
    env: { ...sak, ...simHelper, ...routineEnv, ...process.env, ...built, ...hostShellEnv(shellEnv, process.env), HOME: home, PORT: String(appPort), VITE_X_BENCH_LABEL: label },
  });
  host = child;
  if (sealKey === undefined) sealKey = app.isPackaged ? secretKey(path.join(home, ".x-bench", "secret-key"), safeStorage) : null;
  child.postMessage({ type: "start", key: sealKey, dev: !app.isPackaged, shellEnv });
  const adapters = createAdapterRelay({
    fork: (...args) => utilityProcess.fork(...args),
    root: repoRoot,
    send: (message) => {
      if (child.pid) child.postMessage(message);
    },
  });
  child.stdout?.on("data", (chunk) => {
    process.stdout.write(chunk);
    output = keepTail(output, String(chunk));
  });
  child.stderr?.on("data", (chunk) => {
    process.stderr.write(chunk);
    output = keepTail(output, String(chunk));
  });

  // A slow start is often macOS waiting on a privacy prompt, for example for
  // the Documents folder, so the host keeps running. The window says so and
  // switches to the app if it still starts.
  const timer = setTimeout(() => {
    if (host !== child || listening) return;
    fail(`The X Bench server has not started after ${startTimeout / 1000} seconds. If macOS asks for access to a folder, allow it and the app opens. Restart starts the server again.`, "X Bench is still starting");
  }, startTimeout);

  // The Groks and the SAK this host started that have not exited. They stay
  // this host's even after Restart replaced it.
  const groups = new Set();
  child.on("message", (message) => {
    if (adapters.handle(message)) return;
    const group = groupUpdate(message);
    if (group) {
      if (group.running) groups.add(group.pid);
      else groups.delete(group.pid);
      return;
    }
    if (host !== child) return;
    const note = hostNote(message);
    if (note) {
      notify(child, note);
      return;
    }
    const awake = keepAwakeOf(message);
    if (awake !== null) {
      keepAwake(awake);
      return;
    }
    if (listeningPort(message) !== appPort) return;
    clearTimeout(timer);
    listening = true;
    pane?.relink(origin);
    show();
  });

  child.on("exit", (code) => {
    clearTimeout(timer);
    adapters.stopAll();
    if (host === child) keepAwake(false);
    // Only the host's shutdown() stops Grok and SAK, and it misses a crash, a
    // force quit, the stop timeout and a Grok that is still starting. After a
    // clean shutdown the host has reported their exit and nothing is left here.
    for (const pid of groups) stopGroup(pid);
    if (host !== child) return;
    const started = listening;
    host = null;
    listening = false;
    if (stopping) return;
    // Another X Bench Dev can take the port between the probe and the bind.
    if (!started && !app.isPackaged && output.includes("EADDRINUSE") && appPort < basePort + portTries) {
      void movePort();
      return;
    }
    fail(`The X Bench server stopped (exit code ${code}).`);
  });
}

function stopHost() {
  if (stopping) return stopping;
  const child = host;
  stopping = new Promise((resolve) => {
    const killTimer = setTimeout(() => kill(child), stopTimeout);
    // Quitting must never hang. A child that has no pid yet (Cmd+Q right
    // after fork) cannot be killed, so after one more second the app stops
    // waiting for its exit and lets it go.
    const giveUp = setTimeout(done, stopTimeout + 1000);
    function done() {
      clearTimeout(killTimer);
      clearTimeout(giveUp);
      if (host === child) host = null;
      resolve();
    }
    child.once("exit", done);
    // Before it listens, the host has no stop handler yet, and SIGTERM ends it.
    if (listening) child.postMessage({ type: "stop" });
    else child.kill();
  });
  return stopping;
}

// Restarts the host when a file it loads changes. The window reloads once the
// new host listens, and a turn running in this app ends.
function watchHost() {
  const read = (file) => fs.readFileSync(file, "utf8");
  const stamp = (file) => {
    try {
      const stat = fs.statSync(file);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return "";
    }
  };
  let files = importGraph(hostEntry, read);
  // macOS reports a file as changed when another tool clones it, so only a new mtime or size restarts the host.
  let stamps = new Map([...files].map((file) => [file, stamp(file)]));
  let timer = null;
  let restarts = Promise.resolve();
  const watchers = new Map();
  // A new import can reach a folder the host did not load from before.
  const watchFolders = () => {
    for (const folder of watchedFolders(files, repoRoot)) {
      if (watchers.has(folder)) continue;
      watchers.set(folder, fs.watch(folder, { recursive: true }, (_event, name) => {
        const file = name ? path.join(folder, name) : "";
        if (!file || !files.has(file)) return;
        const now = stamp(file);
        if (stamps.get(file) === now) return;
        stamps.set(file, now);
        clearTimeout(timer);
        timer = setTimeout(() => {
          restarts = restarts.then(restart);
        }, watchDelay);
      }));
    }
  };
  const restart = async () => {
    if (quitting) return;
    console.log("A host file changed. Restarting the X Bench host.");
    if (host) await stopHost();
    stopping = null;
    files = importGraph(hostEntry, read);
    stamps = new Map([...files].map((file) => [file, stamp(file)]));
    watchFolders();
    startHost();
  };
  watchFolders();
}

function kill(child) {
  if (!child.pid) return;
  try {
    process.kill(child.pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

function killGroup(pid) {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

// Stops the process group of a Grok whose host exited, if it is still there:
// SIGTERM, then SIGKILL if anything in the group is left after 2 seconds.
// Only a pid the host reported running and not exited since gets here, never
// one found by name, because other hosts run their own Grok.
function stopGroup(pid) {
  const signal = (name) => {
    try {
      process.kill(-pid, name);
      return true;
    } catch {
      return false;
    }
  };
  if (!signal("SIGTERM")) return;
  const started = Date.now();
  const done = new Promise((resolve) => {
    const check = setInterval(() => {
      const alive = signal(0);
      if (alive && Date.now() - started < groupStopTimeout) return;
      if (alive) signal("SIGKILL");
      clearInterval(check);
      resolve();
    }, 100);
  });
  reaping.add(done);
  done.then(() => reaping.delete(done));
}

// Keeps the Mac from sleeping on its own while the keep-awake setting is on. Closing the lid still sleeps it.
function keepAwake(on) {
  if (on && awakeBlocker === null) awakeBlocker = powerSaveBlocker.start("prevent-app-suspension");
  else if (!on && awakeBlocker !== null) {
    powerSaveBlocker.stop(awakeBlocker);
    awakeBlocker = null;
  }
}

function notify(child, note) {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title: note.title, body: note.body });
  notes.add(notification);
  notification.on("close", () => notes.delete(notification));
  notification.on("click", () => {
    notes.delete(notification);
    const window = mainWindow();
    if (window) {
      if (window.isMinimized()) window.restore();
      window.show();
    } else {
      createWindow();
    }
    app.focus({ steal: true });
    if (note.sessionId && host === child && listening) child.postMessage({ type: "open-session", sessionId: note.sessionId });
  });
  notification.show();
}

function fail(reason, title = "X Bench stopped") {
  console.error(reason);
  failure = { reason, title };
  show();
}

// The app's window. The licenses windows are BaseWindows too, but have no page of the app.
function mainWindow() {
  return BaseWindow.getAllWindows().find((window) => pages.has(window));
}

// Puts the current state in the window, or opens one.
function show() {
  const window = mainWindow();
  if (window) render(window);
  else createWindow();
}

function render(window) {
  const contents = pages.get(window)?.webContents;
  if (!contents) return;
  if (attached || listening) contents.loadURL(origin);
  else if (failure) showError(contents, { ...failure, output });
  else contents.loadURL(appPageUrl("launch.html", launchTheme()));
}

function showError(contents, query) {
  pane?.hide();
  contents.loadURL(appPageUrl("error.html", query));
}

function failPage(window, reason) {
  if (window.isDestroyed()) return;
  showError(pages.get(window).webContents, { reason: `${reason} Restart loads it again.`, title: "The X Bench page stopped" });
}

// The theme the page chose, for the launch page, which shows before the page loads. None follows the system.
function themeFile() {
  return path.join(app.getPath("userData"), "launch-theme");
}

function launchTheme() {
  try {
    const theme = fs.readFileSync(themeFile(), "utf8");
    return theme === "light" || theme === "dark" ? { theme } : {};
  } catch {
    return {};
  }
}

// The page's colour until it paints: --bg in the stored appearance, or the system's. Studio and Classic share --bg.
function pageColor() {
  const theme = launchTheme().theme ?? (nativeTheme.shouldUseDarkColors ? "dark" : "light");
  return theme === "light" ? "#ffffff" : "#0a0a0a";
}

// The error page's Restart link navigates to error.html?restart.
function isRestart(value) {
  return value.startsWith(errorPageUrl) && new URL(value).searchParams.has("restart");
}

function restartHost(window) {
  // Only the page failed, so it loads again.
  if (attached || listening) {
    render(window);
    return;
  }
  pane?.hide();
  pages.get(window)?.webContents.loadURL(appPageUrl("launch.html", launchTheme()));
  const stuck = host;
  host = null;
  if (stuck) kill(stuck);
  startHost();
}

// The page gets two permissions, and only on its own origin: the microphone
// for dictation, and clipboard writes for the copy buttons (WebKit allowed
// those without asking). Everything else, the camera included, is denied.
function allowed(permission, url, mediaTypes) {
  if (!sameOrigin(url)) return false;
  if (permission === "clipboard-sanitized-write") return true;
  return permission === "media" && mediaTypes.length > 0 && mediaTypes.every((type) => type === "audio");
}

function keepTheme() {
  ipcMain.on("app:theme", (event, choice) => {
    if (!sameOrigin(event.sender.getURL())) return;
    try {
      if (choice === "light" || choice === "dark") fs.writeFileSync(themeFile(), choice);
      else if (choice === "system") fs.rmSync(themeFile(), { force: true });
    } catch {
      // The next launch page follows the system.
    }
    for (const window of BaseWindow.getAllWindows()) pages.get(window)?.setBackgroundColor(pageColor());
  });
}

function guardSession() {
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
    callback(allowed(permission, details.requestingUrl, details.mediaTypes ?? []));
  });
  session.defaultSession.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => {
    return allowed(permission, requestingOrigin, details.mediaType ? [details.mediaType] : []);
  });
}

function createWindow() {
  const window = new BaseWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    center: true,
    title: appName,
    titleBarStyle: "hiddenInset",
    // Centered 34pt from the top, the middle of the page's 52px session bar
    // under the 8pt gap around the panes, and 18pt into the sidebar's pane.
    trafficLightPosition: { x: 26, y: 27 },
    transparent: true,
    backgroundColor: "#00000000",
    acceptFirstMouse: true,
  });
  const page = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // A file dropped outside a drop zone must not replace the page.
      navigateOnDragDrop: false,
      preload,
      additionalArguments: copyName ? [`--x-bench-app-name=${copyName}`] : [],
    },
  });
  page.setBackgroundColor(pageColor());
  page.setBorderRadius(WINDOW_CORNER);
  window.contentView.addChildView(page);
  const fit = () => {
    const { width, height } = window.getContentBounds();
    page.setBounds({ x: 0, y: 0, width, height });
  };
  fit();
  window.on("resize", fit);
  // A full-screen window has square corners.
  window.on("enter-full-screen", () => page.setBorderRadius(0));
  window.on("leave-full-screen", () => page.setBorderRadius(WINDOW_CORNER));
  window.on("closed", () => page.webContents.close());
  pages.set(window, page);
  const contents = page.webContents;
  pane?.attach(window, page);
  unityView?.attach(window, page);
  railTip?.attach(window, page);
  updater?.attach(window, page);
  contents.once("did-finish-load", () => contents.focus());

  // Open Source Licenses opens in a window of its own. Every other http(s) link
  // that asks for a new window (PRs, Trello, SAK, and links to the host itself,
  // like a browser's new tab) goes to the default browser, so the app in this
  // window is never replaced.
  contents.setWindowOpenHandler(({ url }) => {
    const where = route(url, origin);
    if (where === "inside" && new URL(url).pathname === "/licenses") openLicensesWindow(url, { origin, backgroundColor: pageColor() });
    else if (where !== "deny") shell.openExternal(url);
    return { action: "deny" };
  });

  // The same for navigation in the window itself.
  contents.on("will-navigate", (event) => {
    if (isRestart(event.url)) {
      event.preventDefault();
      restartHost(window);
      return;
    }
    const where = route(event.url, origin);
    if (where === "inside") return;
    event.preventDefault();
    if (where === "outside") shell.openExternal(event.url);
  });
  contents.on("will-redirect", (event) => {
    if (!sameOrigin(event.url)) event.preventDefault();
  });

  // Electron has no right-click menu of its own, so text fields and
  // selections get a small edit menu.
  contents.on("context-menu", (_event, params) => {
    const flags = params.editFlags;
    const items = [];
    if (params.isEditable) {
      items.push({ role: "cut", enabled: flags.canCut }, { role: "copy", enabled: flags.canCopy }, { role: "paste", enabled: flags.canPaste });
      items.push({ type: "separator" }, { role: "selectAll", enabled: flags.canSelectAll });
    } else if (params.selectionText) {
      items.push({ role: "copy", enabled: flags.canCopy });
    }
    if (items.length) Menu.buildFromTemplate(items).popup({ window });
  });

  contents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3 || !sameOrigin(url)) return;
    console.error(`Could not load ${url} (${description}).`);
    failPage(window, `The page at ${url} did not load (${description}).`);
  });
  contents.on("render-process-gone", (_event, details) => {
    console.error(`The page's renderer is gone (${details.reason}).`);
    failPage(window, `The page's process ended (${details.reason}).`);
  });

  render(window);
  return window;
}
