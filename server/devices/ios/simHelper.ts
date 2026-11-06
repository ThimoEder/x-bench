// xbench-sim, X Bench's own iOS simulator helper (desktop/devices/sim-helper), one long-running process per booted
// simulator. Requests go in as JSON lines; replies, events and H.264 frames come back framed on stdout. A
// helper that fails to start for a simulator is left alone for a minute.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "../../../bridge/lenient.ts";

export interface HelperInfo {
  // The screen in points and in pixels.
  width: number;
  height: number;
  widthPixels: number;
  heightPixels: number;
}

export interface SimHelper {
  info: HelperInfo;
  call<T = unknown>(op: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  // A request whose reply nobody waits for, like a live touch. Its order with other requests holds.
  post(op: string, args?: Record<string, unknown>): void;
  onFrame(listener: (data: Buffer) => void): () => void;
  // Runs once the process has gone, as when its simulator shuts down.
  onExit(listener: () => void): () => void;
  alive(): boolean;
}

export interface SimHelpers {
  // The helper binary, or null when this build has none.
  path(): string | null;
  // The running helper for a simulator, started when needed. Rejects when it cannot start.
  get(udid: string): Promise<SimHelper>;
}

export type StartHelper = (binary: string, udid: string) => ChildProcessWithoutNullStreams;

export interface SimHelpersOptions {
  binary?: string | null;
  start?: StartHelper;
  now?: () => number;
}

const RETRY_MS = 60_000;
const READY_MS = 20_000;

export function createSimHelpers(options: SimHelpersOptions = {}): SimHelpers {
  const binary = options.binary !== undefined ? options.binary : defaultHelper();
  const start = options.start ?? ((file, udid) => spawn(file, ["--udid", udid], { stdio: ["pipe", "pipe", "pipe"] }));
  const now = options.now ?? Date.now;
  const running = new Map<string, Promise<SimHelper>>();
  const failedAt = new Map<string, { at: number; reason: string }>();

  function get(udid: string): Promise<SimHelper> {
    if (!binary) return Promise.reject(new Error("This build has no simulator helper."));
    const failed = failedAt.get(udid);
    if (failed && now() - failed.at < RETRY_MS) return Promise.reject(new Error(failed.reason));
    const existing = running.get(udid);
    if (existing) return existing;
    const job = launch(binary, udid).catch((error: unknown) => {
      running.delete(udid);
      failedAt.set(udid, { at: now(), reason: error instanceof Error ? error.message : String(error) });
      throw error;
    });
    running.set(udid, job);
    return job;
  }

  function launch(file: string, udid: string): Promise<SimHelper> {
    return new Promise((resolve, reject) => {
      const child = start(file, udid);
      const waiting = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
      const frames = new Set<(data: Buffer) => void>();
      const exits = new Set<() => void>();
      let next = 1;
      let pending: Buffer = Buffer.alloc(0);
      let stderr = "";
      let exited = false;
      let helper: SimHelper | null = null;
      const readyTimer = setTimeout(() => {
        reject(new Error("The simulator helper did not start in time."));
        child.kill("SIGKILL");
      }, READY_MS);

      // A write after the process died fails here, which would otherwise take the host down.
      child.stdin.on("error", () => {});
      child.on("exit", () => {
        exited = true;
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-2000);
      });
      child.stdout.on("data", (chunk: Buffer) => {
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        while (pending.length >= 5) {
          const length = pending.readUInt32BE(1);
          if (pending.length < 5 + length) break;
          const kind = pending[0];
          const body = pending.subarray(5, 5 + length);
          pending = pending.subarray(5 + length);
          if (kind === 1) {
            for (const listener of frames) listener(body);
            continue;
          }
          let message: Record<string, unknown>;
          try {
            message = JSON.parse(body.toString("utf8"));
          } catch {
            continue;
          }
          if (message.event === "ready") {
            clearTimeout(readyTimer);
            helper = makeHelper(infoOf(message.info));
            resolve(helper);
          } else if (message.event === "failed") {
            clearTimeout(readyTimer);
            reject(new Error(String(message.error || "The simulator helper could not start.")));
          } else if (typeof message.id === "number") {
            const entry = waiting.get(message.id);
            if (!entry) continue;
            waiting.delete(message.id);
            clearTimeout(entry.timer);
            if (message.ok === true) entry.resolve(message.result);
            else entry.reject(new Error(String(message.error || "The simulator helper failed.")));
          }
        }
      });
      child.on("error", (error) => {
        clearTimeout(readyTimer);
        reject(error);
      });
      child.on("close", () => {
        exited = true;
        clearTimeout(readyTimer);
        if (running.get(udid) && helper) running.delete(udid);
        for (const entry of waiting.values()) {
          clearTimeout(entry.timer);
          entry.reject(new Error("The simulator helper stopped."));
        }
        waiting.clear();
        if (!helper) reject(new Error(lastLine(stderr) || "The simulator helper stopped while starting."));
        for (const listener of exits) listener();
        exits.clear();
      });

      function write(op: string, args: Record<string, unknown>, id: number | null) {
        if (exited) return false;
        child.stdin.write(`${JSON.stringify({ ...args, op, ...(id === null ? {} : { id }) })}\n`);
        return true;
      }

      function makeHelper(info: HelperInfo): SimHelper {
        return {
          info,
          call<T>(op: string, args: Record<string, unknown> = {}, timeoutMs = 30_000) {
            const id = next++;
            return new Promise<T>((done, fail) => {
              const timer = setTimeout(() => {
                waiting.delete(id);
                fail(new Error(`The simulator helper did not answer ${op} in ${Math.round(timeoutMs / 1000)} seconds.`));
              }, timeoutMs);
              waiting.set(id, { resolve: (value) => done(value as T), reject: fail, timer });
              if (!write(op, args, id)) {
                clearTimeout(timer);
                waiting.delete(id);
                fail(new Error("The simulator helper stopped."));
              }
            });
          },
          post(op, args = {}) {
            write(op, args, null);
          },
          onFrame(listener) {
            frames.add(listener);
            return () => frames.delete(listener);
          },
          onExit(listener) {
            if (exited) {
              listener();
              return () => {};
            }
            exits.add(listener);
            return () => exits.delete(listener);
          },
          alive: () => !exited,
        };
      }
    });
  }

  return { path: () => binary, get };
}

function infoOf(value: unknown): HelperInfo {
  const record = isRecord(value) ? value : {};
  const number = (key: string) => (typeof record[key] === "number" ? (record[key] as number) : 0);
  return { width: number("width"), height: number("height"), widthPixels: number("widthPixels"), heightPixels: number("heightPixels") };
}

function lastLine(text: string): string {
  return text.trim().split("\n").pop()?.replace(/^xbench-sim: /, "") ?? "";
}

// X_BENCH_SIM_HELPER in the packaged app, else the build in this checkout.
function defaultHelper(): string | null {
  const given = process.env.X_BENCH_SIM_HELPER;
  if (given) return existsSync(given) ? given : null;
  const local = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "desktop", "devices", "sim-helper", "build", "xbench-sim");
  return existsSync(local) ? local : null;
}
