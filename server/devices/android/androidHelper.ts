// xbench-android, X Bench's helper that reads an Android device's screen (desktop/devices/android-helper), one
// long-running process per device under `adb shell`. Requests go in and replies come back as JSON lines.
// A helper that fails to start for a device is left alone for a minute, and androidDriver.ts falls back to
// uiautomator and screencap.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pushFile } from "../devicePush.ts";
import { runProcess, type RunCommand } from "../../runProcess.ts";

export interface AndroidDisplay {
  width: number;
  height: number;
  rotation: number;
  density: number;
}

export interface AndroidHelper {
  call(op: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
  display(): Promise<AndroidDisplay>;
  alive(): boolean;
  close(): void;
}

export interface AndroidHelpers {
  // The helper's jar, or null when this build has none.
  path(): string | null;
  // The running helper for a device, started when needed. Rejects when it cannot start.
  get(serial: string): Promise<AndroidHelper>;
  close(): void;
}

export type StartAndroidHelper = (adb: string, serial: string) => ChildProcessWithoutNullStreams;

export interface AndroidHelpersOptions {
  adb: string;
  jar?: string | null;
  run?: RunCommand;
  start?: StartAndroidHelper;
  now?: () => number;
  idleMs?: number;
}

const DEVICE_JAR = "/data/local/tmp/xbench-android.jar";
const RETRY_MS = 60_000;
const READY_MS = 15_000;
const IDLE_MS = 15 * 60_000;

export function createAndroidHelpers(options: AndroidHelpersOptions): AndroidHelpers {
  const { adb } = options;
  const jar = options.jar !== undefined ? options.jar : defaultJar();
  const run = options.run ?? runProcess;
  const start = options.start ?? ((file, serial) => spawn(file, ["-s", serial, "shell", `CLASSPATH=${DEVICE_JAR} exec app_process / xbench.Helper`], { stdio: ["pipe", "pipe", "pipe"] }));
  const now = options.now ?? Date.now;
  const idleMs = options.idleMs ?? IDLE_MS;
  const running = new Map<string, Promise<AndroidHelper>>();
  const failedAt = new Map<string, { at: number; reason: string }>();

  function get(serial: string): Promise<AndroidHelper> {
    if (!jar) return Promise.reject(new Error("This build has no Android helper."));
    const failed = failedAt.get(serial);
    if (failed && now() - failed.at < RETRY_MS) return Promise.reject(new Error(failed.reason));
    const existing = running.get(serial);
    if (existing) return existing;
    const job = launch(jar, serial).catch((error: unknown) => {
      running.delete(serial);
      failedAt.set(serial, { at: now(), reason: error instanceof Error ? error.message : String(error) });
      throw error;
    });
    running.set(serial, job);
    return job;
  }

  async function launch(file: string, serial: string): Promise<AndroidHelper> {
    await pushFile((command, args) => run(command, args, { timeoutMs: 30_000 }), adb, serial, file, DEVICE_JAR);
    return new Promise((resolve, reject) => {
      const child = start(adb, serial);
      const waiting = new Map<number, { resolve(value: Record<string, unknown>): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
      let next = 1;
      let pending = "";
      let stderr = "";
      let exited = false;
      let idle: NodeJS.Timeout | null = null;
      const readyTimer = setTimeout(() => {
        reject(new Error("The Android helper did not start in time."));
        child.kill("SIGKILL");
      }, READY_MS);

      function rest() {
        if (idle) clearTimeout(idle);
        idle = setTimeout(() => {
          if (!waiting.size) helper.close();
        }, idleMs);
        idle.unref();
      }

      const helper: AndroidHelper = {
        call(op, args = {}, timeoutMs = 20_000) {
          if (exited) return Promise.reject(new Error("The Android helper stopped."));
          rest();
          const id = next++;
          return new Promise((done, fail) => {
            const timer = setTimeout(() => {
              waiting.delete(id);
              fail(new Error(`The Android helper did not answer ${op} in ${Math.round(timeoutMs / 1000)} seconds.`));
            }, timeoutMs);
            waiting.set(id, { resolve: done, reject: fail, timer });
            child.stdin.write(`${JSON.stringify({ ...args, id, op })}\n`);
          });
        },
        async display() {
          const reply = await helper.call("display");
          const number = (key: string) => (typeof reply[key] === "number" ? (reply[key] as number) : 0);
          return { width: number("width"), height: number("height"), rotation: number("rotation"), density: number("density") };
        },
        alive: () => !exited,
        close() {
          child.stdin.end();
          setTimeout(() => {
            if (!exited) child.kill("SIGTERM");
          }, 2000).unref();
        },
      };

      // A write after the process died fails here, which would otherwise take the host down.
      child.stdin.on("error", () => {});
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-2000);
      });
      // Decoded as a stream, so a character split between two chunks stays whole.
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        pending += chunk;
        for (let at = pending.indexOf("\n"); at >= 0; at = pending.indexOf("\n")) {
          const line = pending.slice(0, at);
          pending = pending.slice(at + 1);
          let message: Record<string, unknown>;
          try {
            message = JSON.parse(line);
          } catch {
            continue;
          }
          if (message.event === "ready") {
            clearTimeout(readyTimer);
            rest();
            resolve(helper);
            continue;
          }
          const waiter = waiting.get(Number(message.id));
          if (!waiter) continue;
          waiting.delete(Number(message.id));
          clearTimeout(waiter.timer);
          if (message.ok === true) waiter.resolve(message);
          else waiter.reject(new Error(String(message.error || "The Android helper failed.")));
        }
      });
      child.on("error", (error) => {
        clearTimeout(readyTimer);
        reject(error);
      });
      child.on("exit", () => {
        exited = true;
        clearTimeout(readyTimer);
        if (idle) clearTimeout(idle);
        if (running.get(serial)) running.delete(serial);
        const reason = lastLine(stderr) || "The Android helper stopped.";
        reject(new Error(reason));
        for (const waiter of waiting.values()) {
          clearTimeout(waiter.timer);
          waiter.reject(new Error(reason));
        }
        waiting.clear();
      });
    });
  }

  function close() {
    for (const job of running.values()) void job.then((helper) => helper.close()).catch(() => {});
    running.clear();
  }

  return { path: () => jar, get, close };
}

function lastLine(text: string): string {
  return (
    text
      .trim()
      .split("\n")
      .filter((line) => /exception|error/i.test(line))
      .pop()
      ?.trim() ?? ""
  );
}

// X_BENCH_ANDROID_HELPER in the packaged app, else the build in this checkout.
function defaultJar(): string | null {
  const given = process.env.X_BENCH_ANDROID_HELPER;
  if (given) return existsSync(given) ? given : null;
  const local = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "desktop", "devices", "android-helper", "build", "xbench-android.jar");
  return existsSync(local) ? local : null;
}
