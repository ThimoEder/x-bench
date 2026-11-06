// Simulator builds for the simulator tools. Each build runs xcodebuild in the background under an id, with
// derived data kept per project and scheme so later builds are incremental. A status reports the compile
// errors, and on success the built .app and its bundle id.

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { defaultXcrun } from "../devices.ts";
import { runProcess } from "../../runProcess.ts";

export interface BuildRequest {
  cwd: string;
  project?: string;
  workspace?: string;
  scheme?: string;
  configuration?: string;
  // A simulator UDID. Without one the build targets any iOS simulator.
  device?: string;
}

export type BuildState = "running" | "succeeded" | "failed" | "stopped";

export interface BuildStatus {
  id: string;
  state: BuildState;
  seconds: number;
  errors: string[];
  warnings: number;
  appPath: string;
  bundleId: string;
  // The last lines of output, for a failure without compiler errors.
  tail: string[];
  log: string;
}

export interface BuildOptions {
  // xcodebuild as a command and the arguments before its own.
  command?: { file: string; prefix: string[] };
  dir: string;
}

interface Running {
  status: BuildStatus;
  started: number;
  finished: number | null;
  stop(): void;
  done: Promise<void>;
}

const KEEP = 20;
const ERROR_LIMIT = 30;

export type Builds = ReturnType<typeof createBuilds>;

export function createBuilds(options: BuildOptions) {
  const command = options.command ?? { file: defaultXcrun(), prefix: ["xcodebuild"] };
  const { dir } = options;
  const builds = new Map<string, Running>();

  function start(request: BuildRequest): BuildStatus {
    const configuration = request.configuration || "Debug";
    const derived = path.join(dir, createHash("sha1").update(JSON.stringify([request.cwd, request.project ?? "", request.workspace ?? "", request.scheme ?? ""])).digest("hex").slice(0, 12));
    fs.mkdirSync(derived, { recursive: true, mode: 0o700 });
    const args = [
      ...(request.workspace ? ["-workspace", request.workspace] : request.project ? ["-project", request.project] : []),
      ...(request.scheme ? ["-scheme", request.scheme] : []),
      "-configuration",
      configuration,
      "-destination",
      request.device ? `platform=iOS Simulator,id=${request.device}` : "generic/platform=iOS Simulator",
      "-derivedDataPath",
      derived,
      "build",
    ];
    const id = `b${randomBytes(3).toString("hex")}`;
    const log = path.join(derived, `${id}.log`);
    const out = fs.createWriteStream(log, { mode: 0o600 });
    const status: BuildStatus = { id, state: "running", seconds: 0, errors: [], warnings: 0, appPath: "", bundleId: "", tail: [], log };
    const child = spawn(command.file, [...command.prefix, ...args], { cwd: request.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stopped = false;
    let settled = false;
    let rest = "";
    // A log that cannot be written, as on a full disk, fails the build instead of the host.
    let logError: Error | null = null;
    out.on("error", (error) => {
      logError = error;
      child.kill("SIGTERM");
    });
    const read = (chunk: Buffer) => {
      if (!logError) out.write(chunk);
      const lines = (rest + chunk.toString("utf8")).split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) take(status, line);
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    const entry: Running = {
      status,
      started: Date.now(),
      finished: null,
      stop() {
        stopped = true;
        child.kill("SIGTERM");
      },
      done: new Promise<void>((resolve) => {
        const finish = async (code: number | null, failure?: Error) => {
          if (settled) return;
          settled = true;
          if (rest) take(status, rest);
          rest = "";
          if (!logError) {
            await new Promise<void>((done) => {
              out.end(done);
            });
          }
          if (failure) status.errors.push(failure.message);
          if (logError) {
            status.errors.push(`Couldn't write the build log: ${(logError as Error).message}`);
            status.state = "failed";
          } else if (stopped) status.state = "stopped";
          else if (code === 0) {
            status.appPath = await newestApp(path.join(derived, "Build", "Products", `${configuration}-iphonesimulator`));
            if (status.appPath) status.bundleId = await readBundleId(status.appPath);
            status.state = "succeeded";
          } else status.state = "failed";
          entry.finished = Date.now();
          resolve();
        };
        child.on("error", (error) => void finish(null, error));
        child.on("close", (code) => void finish(code));
      }),
    };
    builds.set(id, entry);
    prune();
    return view(entry);
  }

  function prune() {
    const finished = [...builds.entries()].filter(([, entry]) => entry.finished !== null);
    for (const [id] of finished.slice(0, Math.max(0, builds.size - KEEP))) builds.delete(id);
  }

  function view(entry: Running): BuildStatus {
    return { ...entry.status, errors: [...entry.status.errors], tail: [...entry.status.tail], seconds: Math.round(((entry.finished ?? Date.now()) - entry.started) / 1000) };
  }

  // The build's status once it ends, or after waitMs while it still runs.
  async function wait(id: string, waitMs: number, signal?: AbortSignal): Promise<BuildStatus | null> {
    const entry = builds.get(id);
    if (!entry) return null;
    if (entry.finished === null && waitMs > 0) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        entry.done,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, waitMs);
          signal?.addEventListener("abort", () => resolve(), { once: true });
        }),
      ]);
      clearTimeout(timer);
    }
    return view(entry);
  }

  function close() {
    for (const entry of builds.values()) if (entry.finished === null) entry.stop();
  }

  return { start, wait, close };
}

// A built .app's bundle id, or "" when its Info.plist does not say.
export async function readBundleId(appPath: string): Promise<string> {
  try {
    const { stdout } = await runProcess("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", path.join(appPath, "Info.plist")]);
    return stdout.toString("utf8").trim();
  } catch {
    return "";
  }
}

// Reads one line of xcodebuild output into the status.
function take(status: BuildStatus, raw: string) {
  const line = raw.trimEnd();
  if (!line) return;
  status.tail.push(line);
  if (status.tail.length > 40) status.tail.shift();
  if (/\bwarning: /.test(line)) status.warnings += 1;
  if (/\berror: /.test(line) || /^xcodebuild: error/.test(line)) {
    const text = line.trim();
    if (status.errors.length < ERROR_LIMIT && !status.errors.includes(text)) status.errors.push(text);
  }
}

async function newestApp(folder: string): Promise<string> {
  try {
    const names = (await readdir(folder)).filter((name) => name.endsWith(".app"));
    const dated = await Promise.all(names.map(async (name) => ({ name, at: (await stat(path.join(folder, name))).mtimeMs })));
    dated.sort((a, b) => b.at - a.at);
    return dated[0] ? path.join(folder, dated[0].name) : "";
  } catch {
    return "";
  }
}
