// An agent that speaks ACP on its stdin and stdout, one JSON-RPC message per line.
// The Claude and Codex adapters run this way. The process is the connection: when it exits,
// the transport closes, and the ACP client's loop starts a new one.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { relayedChild, relayPort, type RelayedChild } from "./relay.ts";
import type { RpcHandlers, Transport } from "./rpc.ts";

const STDERR_KEEP = 8000;

export interface StdioAgent {
  transport: Transport;
  pid: number | null;
  // The end of what the agent wrote to stderr, for error messages.
  stderrTail(): string;
  stop(): Promise<void>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

export interface StdioOptions {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
}

type AgentChild = ChildProcessWithoutNullStreams | RelayedChild;

export function spawnStdioAgent({ command, args, env, cwd }: StdioOptions): StdioAgent {
  return stdioAgent(spawn(command, args, {
    env,
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  }));
}

export function nodeStdioAgent(entry: string, env: NodeJS.ProcessEnv): StdioAgent {
  const port = relayPort();
  return port ? stdioAgent(relayedChild(port, entry, env)) : spawnStdioAgent({ command: process.execPath, args: [entry], env });
}

function stdioAgent(child: AgentChild): StdioAgent {
  let stderr = "";
  let handlers: RpcHandlers | null = null;
  let pending = "";
  let closedOnce = false;
  const early: string[] = [];

  const { promise: closed, resolve: resolveClosed } = Promise.withResolvers<void>();
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });

  function close() {
    if (closedOnce) return;
    closedOnce = true;
    handlers?.onClose();
    resolveClosed();
  }

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    pending += chunk;
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (line.trim()) {
        if (handlers) handlers.onMessage(line);
        else early.push(line);
      }
      newline = pending.indexOf("\n");
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_KEEP);
  });
  // close, not exit: it fires once stdout has ended, so a reply written right before exit is still read.
  // A leftover child that holds stdout open must not delay the restart, so an exit closes within a second.
  child.on("close", close);
  child.on("exit", () => setTimeout(close, 1000).unref());
  // The group stops with the agent however it exits, since a child may ignore the end of its stdin.
  child.on("exit", () => signalGroup(child, "SIGTERM"));
  child.on("error", (error) => {
    stderr = `${stderr}\n${error.message}`.slice(-STDERR_KEEP);
    close();
  });
  // A write after the agent died must not take the host down.
  child.stdin.on("error", () => close());

  const transport: Transport = {
    send(value) {
      if (closedOnce || !child.stdin.writable) throw new Error("the agent is not running");
      child.stdin.write(`${JSON.stringify(value)}\n`);
    },
    close() {
      stopChild(child);
    },
    setHandlers(next) {
      handlers = next;
      for (const line of early.splice(0)) next.onMessage(line);
      if (closedOnce) next.onClose();
    },
    closed,
  };

  return {
    transport,
    pid: child.pid ?? null,
    stderrTail: () => stderr.trim(),
    exited,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      stopChild(child);
      const timer = setTimeout(() => stopChild(child, "SIGKILL"), 2000);
      await exited;
      clearTimeout(timer);
    },
  };
}

function stopChild(child: AgentChild, signal: NodeJS.Signals = "SIGTERM") {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (!signalGroup(child, signal)) child.kill(signal);
}

// A spawned agent leads its own process group, which holds the processes it started without a group of their own.
function signalGroup(child: AgentChild, signal: NodeJS.Signals) {
  if (!child.pid || process.platform === "win32") return false;
  try {
    return process.kill(-child.pid, signal);
  } catch {
    return false;
  }
}
