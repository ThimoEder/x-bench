// The Unity view's rules that need no Electron: which running Unity Editor a chat's folder belongs to, and
// which keys and finger the game holds down.
import fs from "node:fs";
import path from "node:path";

const DESCRIPTOR = path.join("Library", "Pipeline", ".unity-pipeline-port");
const SERVER_PREFIX = "X Bench Game View: ";
// How deep under the chat's folder a Unity project may sit, as in repo/game/UnityProject.
const DEPTH = 2;
const SKIPPED = new Set(["node_modules", "Library", "Temp", "Logs", "obj", "Build", "Builds"]);

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// The Syphon server X Bench's Unity package publishes for a project, named after the project's path as
// Unity reports it, so the view shows the game whose Editor takes the input.
export function serverFor(project) {
  return SERVER_PREFIX + project;
}

// The Editor's Pipeline server in a project folder, from the descriptor the Pipeline package writes there,
// while that Editor still runs. project is the path as Unity reports it.
export function readPipeline(project, { read = fs.readFileSync, isAlive = alive } = {}) {
  try {
    const descriptor = JSON.parse(read(path.join(project, DESCRIPTOR), "utf8"));
    const { port, evalToken, pid, projectPath } = descriptor;
    if (!Number.isInteger(port) || typeof evalToken !== "string" || !Number.isInteger(pid) || !isAlive(pid)) return null;
    return { project: typeof projectPath === "string" ? projectPath : project, url: `http://127.0.0.1:${port}/api/exec`, token: evalToken };
  } catch {
    return null;
  }
}

// The running Editor whose project is the chat's folder or sits up to two folders under it, nearest first.
export function findPipeline(folder, { read = fs.readFileSync, list = listFolders, isAlive = alive } = {}) {
  if (typeof folder !== "string" || !path.isAbsolute(folder)) return null;
  let level = [folder];
  for (let depth = 0; depth <= DEPTH && level.length; depth++) {
    for (const candidate of level) {
      const found = readPipeline(candidate, { read, isAlive });
      if (found) return found;
    }
    level = level.flatMap((parent) => list(parent).map((name) => path.join(parent, name)));
  }
  return null;
}

function listFolders(parent) {
  try {
    return fs
      .readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !SKIPPED.has(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

// The keys and the finger the game holds down, from the input the main process sent, so they can be let go
// when the page goes away without saying so.
export function createHeldInput() {
  const keys = new Set();
  let touch = null;
  return {
    sent(command, parameters) {
      if (command === "simulate_key") {
        if (parameters.action === "down") keys.add(parameters.key);
        else keys.delete(parameters.key);
      } else if (command === "xbench_touch") {
        touch = parameters.action === "up" ? null : { x: parameters.x, y: parameters.y };
      }
    },
    // A command that never arrived may still have pressed something, so whatever it names counts as held
    // until it is let go. An extra key-up or lifted finger does nothing in the game.
    lost(command, parameters) {
      if (command === "simulate_key") keys.add(parameters.key);
      else if (command === "xbench_touch") touch = { x: parameters.x, y: parameters.y };
    },
    // The commands that let go of everything, which also forget it.
    release() {
      const commands = [...keys].map((key) => ({ command: "simulate_key", parameters: { key, action: "up" } }));
      if (touch) commands.push({ command: "xbench_touch", parameters: { ...touch, action: "up" } });
      keys.clear();
      touch = null;
      return commands;
    },
  };
}

// Touches and keys go to the Editors one at a time, since the Pipeline runs one command at a time, and only
// the latest move waits. post(target, command, parameters) rejects when the Editor quit, hangs or refused the
// command; that Editor's waiting input is dropped then, and failed(target, lost) hears of it with the commands
// that never arrived. Editors are told apart by their url.
export function createInputQueue({ post, failed = () => {}, now = () => performance.now() }) {
  let queued = [];
  let sending = false;
  let ms = 0;

  async function pump() {
    if (sending) return;
    sending = true;
    while (queued.length) {
      const item = queued.shift();
      const { target, command, parameters } = item;
      const start = now();
      try {
        await post(target, command, parameters);
      } catch {
        const lost = [item, ...queued.filter((other) => other.target.url === target.url)];
        queued = queued.filter((other) => other.target.url !== target.url);
        failed(target, lost);
      }
      ms = ms ? ms * 0.8 + (now() - start) * 0.2 : now() - start;
    }
    sending = false;
  }

  return {
    push(target, command, parameters) {
      const last = queued.at(-1);
      if (parameters.action === "move" && last?.command === command && last.target.url === target.url && last.parameters.action === "move") queued.pop();
      queued.push({ target, command, parameters });
      return pump();
    },
    // The time a command takes, smoothed.
    get ms() {
      return ms;
    },
  };
}
