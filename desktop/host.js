// Rules the Electron main process applies to URLs, the login shell PATH, the
// host's output and the files the dev app watches. Kept apart from main.js so
// they run without Electron.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The launch token file the host writes for its port (launchToken in server/paths.ts).
export function tokenPath(port, home = os.homedir()) {
  return path.join(home, ".x-bench", `launch-token-${port}`);
}

// X_BENCH_URL points the window at a host that is already running. Only
// http://127.0.0.1:<port> is accepted, because the host drives Grok with
// bypassPermissions and the window must never load anything else.
export function hostOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const plain = url.protocol === "http:"
    && url.hostname === "127.0.0.1"
    && url.port !== ""
    && url.username === ""
    && url.password === ""
    && url.pathname === "/"
    && url.search === ""
    && url.hash === "";
  return plain ? url.origin : null;
}

// "inside" stays in the window, "outside" opens in the default browser, and
// anything else (file:, javascript:, custom schemes) is dropped.
export function route(value, origin) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return "deny";
  }
  if (url.origin === origin) return "inside";
  if (url.protocol === "http:" || url.protocol === "https:") return "outside";
  return "deny";
}

// The host says { type: "listening", port } once it accepts requests.
export function listeningPort(message) {
  if (typeof message !== "object" || message === null || message.type !== "listening") return null;
  const { port } = message;
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

// The host says { type: "grok", pid, running } when it starts Grok and when
// that Grok exits, and { type: "sak", ... } for the SAK server it starts. When
// the host exits, the app stops the process groups of the pids still running,
// so only a real pid counts: kill(-1) would signal every process of the user,
// kill(-0) the app.
export function groupUpdate(message) {
  if (typeof message !== "object" || message === null || (message.type !== "grok" && message.type !== "sak")) return null;
  const { pid, running } = message;
  if (!Number.isInteger(pid) || pid <= 1 || typeof running !== "boolean") return null;
  return { pid, running };
}

// The host says { type: "notify", title, body, sessionId? } for a routine run that ended, waits for the person, or
// did not start.
export function hostNote(message) {
  if (typeof message !== "object" || message === null || message.type !== "notify") return null;
  const { title, body, sessionId } = message;
  if (typeof title !== "string" || !title || typeof body !== "string") return null;
  return { title: title.slice(0, 200), body: body.slice(0, 500), ...(typeof sessionId === "string" && sessionId ? { sessionId } : {}) };
}

// The host says { type: "keep-awake", on } when the routine setting to keep the Mac awake applies or stops.
export function keepAwakeOf(message) {
  if (typeof message !== "object" || message === null || message.type !== "keep-awake" || typeof message.on !== "boolean") return null;
  return message.on;
}

// An app opened from Finder gets launchd's short PATH, without Homebrew or
// the user's own tools, so grok, git, adb and sqlite3 would not be found.
// The login shell prints its PATH between two markers, because profiles can
// print their own text around it.
export const pathMarker = "__X_BENCH_PATH__";

export function pathCommand() {
  return `printf ${pathMarker}; /usr/bin/printenv PATH; printf ${pathMarker}`;
}

export function pathFromShell(output) {
  const start = output.indexOf(pathMarker);
  const end = output.indexOf(pathMarker, start + pathMarker.length);
  if (start === -1 || end === -1) return null;
  const path = output.slice(start + pathMarker.length, end).trim();
  return path.includes("/") ? path : null;
}

// The last lines the host printed, for the error page when it stops.
export function keepTail(tail, chunk, limit = 4000) {
  const next = tail + chunk;
  return next.length > limit ? next.slice(next.length - limit) : next;
}

export function logFile(file, limit = 5_000_000, stamp = () => new Date().toISOString()) {
  let fd = null;
  let size = 0;
  let lineStart = true;
  const open = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fd = fs.openSync(file, "a", 0o600);
    size = fs.fstatSync(fd).size;
  };
  return (chunk) => {
    // latin1 keeps each byte as one character, so a UTF-8 character split across two chunks stays intact.
    const text = Buffer.from(chunk).toString("latin1");
    if (!text) return;
    const time = stamp();
    const stamped = (lineStart ? `${time} ` : "") + text.replace(/\n(?=.)/g, `\n${time} `);
    lineStart = text.endsWith("\n");
    try {
      if (fd === null) open();
      if (size >= limit) {
        fs.closeSync(fd);
        fd = null;
        fs.renameSync(file, `${file}.old`);
        open();
      }
      size += fs.writeSync(fd, Buffer.from(stamped, "latin1"));
    } catch {}
  };
}

// Relative imports, static and dynamic. Package imports are left out.
const importPattern = /\b(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g;

// The files the host loads from the repo: the entry and every relative import
// reachable from it, including the page modules the host shares. A file that
// cannot be read stays in the set, so creating it counts as a change.
export function importGraph(entry, read) {
  const files = new Set();
  const pending = [entry];
  while (pending.length) {
    const file = pending.pop();
    if (files.has(file)) continue;
    files.add(file);
    let source;
    try {
      source = read(file);
    } catch {
      continue;
    }
    for (const [, spec] of source.matchAll(importPattern)) pending.push(path.resolve(path.dirname(file), spec));
  }
  return files;
}

// The top-level repo folders that hold those files, which the dev app watches.
export function watchedFolders(files, root) {
  const folders = new Set();
  for (const file of files) {
    const relative = path.relative(root, file);
    if (relative.startsWith("..") || path.isAbsolute(relative) || !relative.includes(path.sep)) continue;
    folders.add(path.join(root, relative.split(path.sep)[0]));
  }
  return [...folders];
}

// The feature label X Bench Dev shows from a branch name: the last path part,
// without the worktree's six-character suffix, in words.
// worktree/browser-support-8759d3 becomes "Browser Support". The default
// branch has none.
export function branchLabel(branch) {
  const name = String(branch || "").trim().split("/").pop() ?? "";
  if (!name || ["main", "master", "HEAD"].includes(name)) return "";
  return name
    .replace(/-[0-9a-f]{6}$/, "")
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

// `--label "Browser Support"` or `--label=Browser Support`, else null.
export function labelArg(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--label") return argv[index + 1] ?? "";
    if (arg.startsWith("--label=")) return arg.slice("--label=".length);
  }
  return null;
}

// The checkout's branch, or "" outside git.
export function gitBranch(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

// The environment X Bench Dev's Electron starts with. A shell or chat inside
// X Bench inherits the app's ELECTRON_RUN_AS_NODE, which makes Electron run as
// plain node, and its X_BENCH_UI and X_BENCH_UI_DIR, which make the host serve
// the installed app's built page in place of Vite. Its helper paths stay for
// the helpers this checkout has not built, so a fresh worktree keeps working
// simulators, and a helper the checkout builds replaces the installed one.
const appOnlyEnv = ["ELECTRON_RUN_AS_NODE", "X_BENCH_UI", "X_BENCH_UI_DIR"];
const helperBuilds = {
  X_BENCH_SIM_HELPER: "desktop/devices/sim-helper/build/xbench-sim",
  X_BENCH_ANDROID_HELPER: "desktop/devices/android-helper/build/xbench-android.jar",
  X_BENCH_ANDROID_ENCODER: "desktop/devices/android-helper/build/xbench-encode",
  X_BENCH_SCRCPY_SERVER: "desktop/devices/android-helper/scrcpy/scrcpy-server",
};

export function devAppEnv(env, repoRoot) {
  const built = (key) => key in helperBuilds && fs.existsSync(path.join(repoRoot, helperBuilds[key]));
  return Object.fromEntries(Object.entries(env).filter(([key]) => !appOnlyEnv.includes(key) && !built(key)));
}

// X Bench Dev's name in the menu bar, the Dock and Cmd+Tab: the feature label
// if there is one. Slashes and colons cannot be in a bundle's file name.
export function devAppName(label) {
  const name = String(label || "").replace(/[/:]/g, "-").trim();
  return name || "X Bench Dev";
}
