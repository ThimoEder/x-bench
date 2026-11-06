import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const adapterShim = fileURLToPath(new URL("./adapterProcess.js", import.meta.url));
const killDelay = 2000;

export function createAdapterRelay({ fork, root, send }) {
  const running = new Map();
  const found = new WeakMap();

  function start({ id, entry, env, cwd }) {
    const relative = typeof entry === "string" && path.isAbsolute(entry) ? path.relative(root, entry) : "..";
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      send({ type: "adapter-exit", id, code: null, error: `${entry} is not an adapter of this app` });
      return;
    }
    let child;
    try {
      child = fork(adapterShim, [entry], { serviceName: path.basename(path.dirname(path.dirname(entry))), stdio: "pipe", env: strings(env), cwd: typeof cwd === "string" ? cwd : undefined });
    } catch (error) {
      send({ type: "adapter-exit", id, code: null, error: error?.message ?? String(error) });
      return;
    }
    running.set(id, child);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (data) => send({ type: "adapter-stdout", id, data }));
    child.stderr?.on("data", (data) => send({ type: "adapter-stderr", id, data }));
    let exited = false;
    child.on("exit", (code) => {
      running.delete(id);
      // The adapter's last reply may still be in its stdout pipe when it exits.
      const done = () => {
        if (exited) return;
        exited = true;
        send({ type: "adapter-exit", id, code });
      };
      if (!child.stdout || child.stdout.readableEnded) return done();
      child.stdout.once("end", done);
      setTimeout(done, 1000).unref?.();
    });
  }

  function handle(message) {
    if (typeof message !== "object" || message === null || !Number.isInteger(message.id)) return false;
    const child = running.get(message.id);
    if (message.type === "adapter-start") start(message);
    else if (message.type === "adapter-stdin") child?.postMessage({ stdin: typeof message.data === "string" ? message.data : null });
    else if (message.type === "adapter-stop") stop(child, message.force === true);
    else return false;
    return true;
  }

  // The adapter's children are found while it lives and kept for the forced stop, since a process whose parent exits moves to launchd.
  function stop(child, force) {
    if (!child) return [];
    if (!child.pid) {
      child.kill();
      return [];
    }
    const tree = [...new Set([...(found.get(child) ?? []), ...processTree(child.pid)])];
    found.set(child, tree);
    signal(tree, force ? "SIGKILL" : "SIGTERM");
    return tree;
  }

  return {
    handle,
    // When the host is gone, nothing asks for the forced stop, so it follows here.
    stopAll() {
      const trees = [...running.values()].flatMap((child) => stop(child, false));
      running.clear();
      if (trees.length) setTimeout(() => signal(trees, "SIGKILL"), killDelay);
    },
  };
}

export function processTree(pid, table = processTable()) {
  const children = new Map();
  for (const [each, parent] of table) children.set(parent, [...(children.get(parent) ?? []), each]);
  const tree = [pid];
  for (let index = 0; index < tree.length; index += 1) tree.push(...(children.get(tree[index]) ?? []));
  return tree;
}

function processTable() {
  try {
    return execFileSync("/bin/ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" })
      .trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+/).map(Number));
  } catch {
    return [];
  }
}

function signal(pids, name) {
  for (const pid of pids) {
    try {
      process.kill(pid, name);
    } catch {
      // It has exited already.
    }
  }
}

function strings(env) {
  if (typeof env !== "object" || env === null) return {};
  return Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value === "string"));
}
