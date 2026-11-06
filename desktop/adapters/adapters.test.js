import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { nodeStdioAgent } from "../../bridge/stdio.ts";
import { createAdapterRelay, processTree } from "./adapters.js";

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "x-bench-relay-")));
const entry = path.join(dir, "node_modules", "echo-acp", "dist", "index.js");
fs.mkdirSync(path.dirname(entry), { recursive: true });
fs.writeFileSync(entry, `
process.stderr.write("echo started\\n");
let pending = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  pending += chunk;
  for (let at = pending.indexOf("\\n"); at >= 0; at = pending.indexOf("\\n")) {
    process.stdout.write(JSON.stringify({ echo: JSON.parse(pending.slice(0, at)), cwd: process.cwd() }) + "\\n");
    pending = pending.slice(at + 1);
  }
});
`);

// An adapter that ignores SIGTERM, with a child in its own process group that ignores it too.
const stubborn = path.join(dir, "node_modules", "stubborn-acp", "dist", "index.js");
fs.mkdirSync(path.dirname(stubborn), { recursive: true });
fs.writeFileSync(stubborn, `
const { spawn } = require("node:child_process");
process.on("SIGTERM", () => {});
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
process.stderr.write("child " + child.pid + "\\n");
setInterval(() => {}, 1000);
`);

// An adapter that ignores SIGTERM, whose child exits on it and leaves a grandchild that ignores it.
const orphaning = path.join(dir, "node_modules", "orphaning-acp", "dist", "index.js");
fs.mkdirSync(path.dirname(orphaning), { recursive: true });
fs.writeFileSync(orphaning, `
const { spawn } = require("node:child_process");
process.on("SIGTERM", () => {});
const grandchild = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)";
const middle = "const c = require('node:child_process').spawn(process.execPath, ['-e', " + JSON.stringify(grandchild) + "], { stdio: 'ignore' }); process.stderr.write('child ' + c.pid + '\\\\n'); setInterval(() => {}, 1000)";
spawn(process.execPath, ["-e", middle], { stdio: ["ignore", "ignore", "inherit"] });
setInterval(() => {}, 1000);
`);

// utilityProcess.fork's shape over a plain node child: stdin arrives as { stdin } messages, as adapterProcess.js reads it.
function fork(_shim, [script], { env, cwd }) {
  const child = spawn(process.execPath, [script], { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
  const utility = new EventEmitter();
  Object.assign(utility, {
    pid: child.pid,
    stdout: child.stdout,
    stderr: child.stderr,
    kill: () => child.kill(),
    postMessage: ({ stdin }) => (stdin === null ? child.stdin.end() : child.stdin.write(stdin)),
  });
  child.on("exit", (code) => utility.emit("exit", code ?? 1));
  return utility;
}

let toHost = () => {};
const relay = createAdapterRelay({ fork, root: dir, send: (data) => setImmediate(() => toHost({ data })) });
Reflect.set(process, "parentPort", {
  postMessage: (message) => setImmediate(() => relay.handle(message)),
  on: (_event, listener) => {
    toHost = listener;
  },
});

function connect(agent) {
  const lines = [];
  let closed = false;
  agent.transport.setHandlers({ onMessage: (line) => lines.push(JSON.parse(line)), onClose: () => (closed = true) });
  return { lines, closed: () => closed };
}

async function until(check) {
  for (let tries = 0; !check(); tries += 1) {
    if (tries > 500) throw new Error("timed out");
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

test("an adapter the main process runs answers over the relay and stops", async () => {
  const agent = nodeStdioAgent(entry, process.env);
  const seen = connect(agent);
  agent.transport.send({ jsonrpc: "2.0", id: 1, method: "initialize" });
  agent.transport.send({ jsonrpc: "2.0", id: 2, method: "session/new" });
  await until(() => seen.lines.length === 2);
  assert.deepEqual(seen.lines.map((line) => line.echo.id), [1, 2]);
  assert.equal(seen.lines[0].cwd, process.cwd());
  await until(() => agent.stderrTail().includes("echo started"));
  await agent.stop();
  await until(seen.closed);
});

test("the main process starts only scripts inside the app", async () => {
  const outside = path.join(os.tmpdir(), "elsewhere.js");
  const agent = nodeStdioAgent(outside, process.env);
  const seen = connect(agent);
  await until(seen.closed);
  assert.match(agent.stderrTail(), /is not an adapter of this app/);
  assert.equal((await agent.exited).code, 1);
});

test("adapters still running when their host exits are stopped", async () => {
  const agent = nodeStdioAgent(entry, process.env);
  const seen = connect(agent);
  agent.transport.send({ jsonrpc: "2.0", id: 3 });
  await until(() => seen.lines.length === 1);
  relay.stopAll();
  await until(seen.closed);
});

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stubbornChild(agent) {
  connect(agent);
  await until(() => /child \d+/.test(agent.stderrTail()));
  return Number(/child (\d+)/.exec(agent.stderrTail())[1]);
}

test("a stop ends the adapter's own children, also when both ignore SIGTERM", async () => {
  const agent = nodeStdioAgent(stubborn, process.env);
  const child = await stubbornChild(agent);
  await agent.stop();
  await until(() => !alive(child));
});

test("a forced stop also ends a child that moved to launchd after the first stop", async () => {
  const agent = nodeStdioAgent(orphaning, process.env);
  const child = await stubbornChild(agent);
  await agent.stop();
  await until(() => !alive(child));
});

test("adapters left when their host exits are killed with their children", async () => {
  const agent = nodeStdioAgent(stubborn, process.env);
  const child = await stubbornChild(agent);
  relay.stopAll();
  await agent.exited;
  await until(() => !alive(child));
});

test("a process tree holds the pid and everything under it", () => {
  assert.deepEqual(processTree(10, [[10, 1], [11, 10], [12, 11], [13, 1], [14, 10]]), [10, 11, 14, 12]);
});
