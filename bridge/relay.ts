// The app's binary does not run as node, so inside the app the main process runs each adapter
// (desktop/adapters/adapters.js) and relays its stdio over the parent port.

import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { isRecord } from "./lenient.ts";

export interface RelayPort {
  postMessage(message: unknown): void;
  on(event: "message", listener: (message: { data: unknown }) => void): void;
}

export class RelayedChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  readonly pid = undefined;
  exitCode: number | null = null;
  readonly signalCode = null;
  readonly id: number;
  private readonly port: RelayPort;

  constructor(port: RelayPort, id: number) {
    super();
    this.port = port;
    this.id = id;
    this.stdin = new Writable({
      write: (chunk, _encoding, done) => {
        port.postMessage({ type: "adapter-stdin", id, data: String(chunk) });
        done();
      },
      final: (done) => {
        port.postMessage({ type: "adapter-stdin", id, data: null });
        done();
      },
    });
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.port.postMessage({ type: "adapter-stop", id: this.id, force: signal === "SIGKILL" });
    return true;
  }
}

export function relayPort(): RelayPort | null {
  const port: unknown = Reflect.get(process, "parentPort");
  return isRecord(port) && typeof port.postMessage === "function" && typeof port.on === "function" ? (port as unknown as RelayPort) : null;
}

const children = new Map<number, RelayedChild>();
const listening = new WeakSet<RelayPort>();
let lastId = 0;

export function relayedChild(port: RelayPort, entry: string, env: NodeJS.ProcessEnv): RelayedChild {
  if (!listening.has(port)) {
    listening.add(port);
    port.on("message", ({ data }) => deliver(data));
  }
  const child = new RelayedChild(port, ++lastId);
  children.set(child.id, child);
  port.postMessage({ type: "adapter-start", id: child.id, entry, env, cwd: process.cwd() });
  return child;
}

// adapter-exit arrives after the adapter's last stdout.
function deliver(data: unknown) {
  if (!isRecord(data) || typeof data.id !== "number") return;
  const child = children.get(data.id);
  if (!child) return;
  if (data.type === "adapter-stdout" && typeof data.data === "string") child.stdout.write(data.data);
  else if (data.type === "adapter-stderr" && typeof data.data === "string") child.stderr.write(data.data);
  else if (data.type === "adapter-exit") {
    children.delete(child.id);
    child.exitCode = typeof data.code === "number" ? data.code : 1;
    if (typeof data.error === "string") child.emit("error", new Error(data.error));
    child.stdout.end();
    child.stderr.end();
    child.emit("exit", child.exitCode, null);
    child.emit("close", child.exitCode, null);
  }
}
