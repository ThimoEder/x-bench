import { spawn, type ChildProcessByStdio } from "node:child_process";
import net from "node:net";
import type { Readable } from "node:stream";
import type { RpcHandlers, Transport } from "../rpc.ts";
import { randomBytes } from "node:crypto";

export function randomSecret() {
  // A leading dash is parsed as a flag by `grok agent serve --secret`.
  return `s${randomBytes(18).toString("base64url")}`;
}

export function redact(text: unknown) {
  return String(text)
    .replace(/server-key=[^\s&]+/g, "server-key=***")
    .replace(/Secret:\s*\S+/g, "Secret: ***");
}

export function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export type { Transport };

type AgentChild = ChildProcessByStdio<null, null, Readable>;

export interface AgentExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export class AgentProcess {
  proc: AgentChild;
  port: number;
  secret: string;
  url: string;
  exited: AgentExit | null;
  exitPromise: Promise<AgentExit>;

  constructor(
    proc: AgentChild,
    {
      port,
      secret,
      stderr,
      exitPromise,
    }: { port: number; secret: string; stderr: { text: string }; exitPromise: Promise<AgentExit> },
  ) {
    this.proc = proc;
    this.port = port;
    this.secret = secret;
    this.url = `ws://127.0.0.1:${port}/ws?server-key=${encodeURIComponent(secret)}`;
    this.#stderr = stderr;
    this.exited = null;
    this.exitPromise = exitPromise;
  }

  #stderr: { text: string };

  stderrTail() {
    return redact(this.#stderr.text);
  }

  // onProcess gets Grok's pid as soon as it runs, before it listens, so the
  // Electron app can stop its process group if this host dies. It gets the pid
  // again with running false once Grok has exited, because the pid can then be
  // reused by an unrelated process.
  static async start({
    permissionMode = "bypassPermissions",
    command = "grok",
    onProcess,
  }: {
    permissionMode?: string;
    command?: string;
    onProcess?: (pid: number, running: boolean) => void;
  } = {}): Promise<AgentProcess> {
    const port = await freePort();
    const secret = randomSecret();
    const stderr = { text: "" };
    const proc = spawn(
      command,
      [
        "--permission-mode",
        permissionMode,
        "agent",
        "--no-leader",
        "serve",
        "--bind",
        `127.0.0.1:${port}`,
        "--secret",
        secret,
      ],
      {
        detached: true,
        stdio: ["ignore", "ignore", "pipe"],
        env: { ...process.env, GROK_DISABLE_AUTOUPDATER: "1" },
      },
    );
    const pid = proc.pid;
    if (pid) onProcess?.(pid, true);
    proc.stderr.on("data", (chunk) => {
      stderr.text = (stderr.text + chunk.toString("utf8")).slice(-8000);
    });
    const agent = new AgentProcess(proc, {
      port,
      secret,
      stderr,
      exitPromise: new Promise<AgentExit>((resolve) => {
        const exit = (code: number | null, signal: NodeJS.Signals | null) => {
          agent.exited = { code, signal };
          if (pid) onProcess?.(pid, false);
          resolve(agent.exited);
        };
        proc.on("exit", exit);
        proc.on("error", (error) => {
          stderr.text += `${error.message}\n`;
          if (!pid) exit(null, null);
        });
      }),
    });

    const ready = waitForPort(port, 15000, () => agent.exited);
    try {
      await ready;
    } catch (error) {
      await agent.stop();
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message}\n${agent.stderrTail()}`.trim(), { cause: error });
    }
    return agent;
  }

  async stop() {
    if (!this.proc.pid) return;
    if (!this.exited) {
      try {
        process.kill(-this.proc.pid, "SIGTERM");
      } catch {
        this.proc.kill("SIGTERM");
      }
      await Promise.race([this.exitPromise, delay(2000)]);
    }
    if (!this.exited) {
      try {
        process.kill(-this.proc.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
}

export function openWebSocket(url: string, { timeoutMs = 10000 } = {}): Promise<Transport> {
  if (typeof WebSocket !== "function") {
    return Promise.reject(new Error("global WebSocket is not available in this Node runtime"));
  }
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      ws.close();
      reject(new Error("websocket open timed out"));
    }, timeoutMs);

    const transport: Transport = {
      send(value) {
        ws.send(JSON.stringify(value));
      },
      close() {
        ws.close();
      },
      setHandlers({ onMessage, onClose }: RpcHandlers) {
        ws.addEventListener("message", (event) => {
          const data = event.data;
          if (typeof data === "string") onMessage(data);
          else if (typeof data?.text === "function") data.text().then(onMessage, () => {});
          else onMessage(String(data));
        });
        ws.addEventListener("close", () => onClose());
      },
      closed: new Promise<void>((resolveClosed) => {
        ws.addEventListener("close", () => resolveClosed());
      }),
    };

    ws.addEventListener("open", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(transport);
    });
    ws.addEventListener("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error("websocket connection failed"));
    });
  });
}

function waitForPort(port: number, timeoutMs: number, exited: () => AgentExit | null) {
  const started = Date.now();
  return new Promise<void>((resolve, reject) => {
    const attempt = () => {
      if (exited()) {
        reject(new Error("grok agent serve exited before listening"));
        return;
      }
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.end();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() - started > timeoutMs) reject(new Error(`grok agent serve did not listen on ${port}`));
        else setTimeout(attempt, 40);
      });
    };
    attempt();
  });
}

function delay(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
