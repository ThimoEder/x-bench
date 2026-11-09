// The SAK server this host starts. When Setup has SAK on and nothing answers at
// the saved address, the host starts SAK against the database sak.json names,
// and stops it again when Setup turns SAK off or the host quits. A SAK that
// something else started is left alone. The database is never inside the app
// bundle.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { messageOf } from "../../http.ts";
import { isParentPort, sakMessage } from "../../parentPort.ts";
import { readConnection, sakError, writeConnection, type SakConnection } from "./sakClient.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const probeTimeout = 1000;

export interface SakLocations {
  binary: string;
  assets: string;
}

export interface SakCommand {
  binary: string;
  args: string[];
}

// The packaged app passes the binary under Contents/Resources/sak with SAK_BINARY, and
// SAK_ASSETS names a folder the bundle leaves out, so the website comes from sak.json.
// `npm run dev` uses SAK_ROOT, the SAK checkout next to this repo once it holds a built
// binary, or the copy in vendor/sak.
export function sakLocations(root: string, env: NodeJS.ProcessEnv = process.env): SakLocations {
  if (env.SAK_BINARY && env.SAK_ASSETS) return { binary: env.SAK_BINARY, assets: env.SAK_ASSETS };
  const sak = env.SAK_ROOT || path.resolve(root, "..", "sak");
  if (env.SAK_ROOT || existsSync(path.join(sak, "sak"))) return { binary: path.join(sak, "sak"), assets: path.join(sak, "web", "dist") };
  const vendored = path.join(root, "vendor", "sak");
  return { binary: path.join(vendored, "sak"), assets: path.join(vendored, "assets") };
}

// `sak serve` for the saved connection, or null when the database or the SAK
// binary is missing. Without its website SAK serves only its API. Never the
// token: SAK reads it from the database.
export function serveCommand(connection: SakConnection, locations: SakLocations): SakCommand | null {
  const port = Number(URL.parse(connection.baseUrl)?.port);
  if (!port || !connection.database || !existsSync(connection.database)) return null;
  if (!existsSync(locations.binary)) return null;
  const assets = connection.website || locations.assets;
  const site = existsSync(path.join(assets, "index.html")) ? ["--assets", assets] : [];
  return {
    binary: locations.binary,
    args: ["serve", "--db", connection.database, "--bind", "127.0.0.1", "--port", String(port), ...site, "--log-level", "quiet"],
  };
}

export type RunSak = (binary: string, args: string[]) => Promise<{ stdout: string }>;

// A SAK board of this host's own: sak.db next to sak.json, with a token minted into it.
// An existing sak.db there keeps its projects and gets one more token.
export async function setUpLocalSak(connectionFile: string, locations: SakLocations, run: RunSak): Promise<void> {
  if (!existsSync(locations.binary)) throw sakError(503, "The local board is not installed with this app");
  const database = path.join(path.dirname(connectionFile), "sak.db");
  mkdirSync(path.dirname(database), { recursive: true });
  const { stdout } = await run(locations.binary, ["token", "create", "--db", database, "--name", "X Bench"]);
  const token = /sak_[0-9a-f]+/.exec(stdout)?.[0];
  if (!token) throw sakError(502, "The local board did not create a token");
  const { baseUrl, website } = readConnection(connectionFile);
  writeConnection({ baseUrl, token, enabled: true, database, website }, connectionFile);
}

// True when anything answers at the saved address, including a refusal: a
// second server must not start on that port.
export async function sakIsUp(connection: SakConnection, probe: typeof fetch = globalThis.fetch): Promise<boolean> {
  const headers: Record<string, string> = connection.token ? { Authorization: `Bearer ${connection.token}` } : {};
  try {
    const response = await probe(`${connection.baseUrl.replace(/\/$/, "")}/api/health`, {
      headers,
      signal: AbortSignal.timeout(probeTimeout),
    });
    return typeof response?.status === "number";
  } catch {
    return false;
  }
}

export interface SakServeOptions {
  connection: () => SakConnection;
  command: (connection: SakConnection) => SakCommand | null;
  launch: (command: SakCommand) => ChildProcess;
  isUp: (connection: SakConnection) => Promise<boolean>;
  // Told each SAK pid this host starts, and again once it has exited.
  onProcess?: (pid: number, running: boolean) => void;
  log?: (text: string) => void;
  startTimeout?: number;
  stopTimeout?: number;
}

export function createSakServe({
  connection,
  command,
  launch,
  isUp,
  onProcess = () => {},
  log = (text) => console.error(text),
  startTimeout = 5_000,
  stopTimeout = 2_000,
}: SakServeOptions) {
  let child: ChildProcess | null = null;
  let closed = false;
  let tail: Promise<void> = Promise.resolve();

  // One check at a time, so a save while SAK starts cannot start a second one. Never rejects.
  function sync(): Promise<void> {
    const run = tail.then(apply).catch((error: unknown) => log(`SAK was not started (${messageOf(error)}).`));
    tail = run;
    return run;
  }

  async function apply() {
    if (closed) return;
    const saved = connection();
    if (!saved.enabled) return stopChild();
    if (child || (await isUp(saved)) || closed) return;
    const next = command(saved);
    if (!next) {
      log("SAK was not started: sak.json names no database file, or the SAK binary is missing.");
      return;
    }
    const started = launch(next);
    child = started;
    const pid = started.pid;
    if (pid) onProcess(pid, true);
    started.stdout?.on("data", (chunk: Buffer) => process.stdout.write(chunk));
    started.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    started.on("error", (error: Error) => {
      log(`SAK did not start (${error.message}).`);
      if (child === started) child = null;
    });
    started.on("exit", (code) => {
      if (pid) onProcess(pid, false);
      if (child !== started) return;
      child = null;
      if (code) log(`SAK stopped (exit code ${code}).`);
    });
    // Setup gets its status after this, so wait until the new SAK answers.
    const deadline = Date.now() + startTimeout;
    while (child === started && Date.now() < deadline && !(await isUp(saved))) await delay(100);
  }

  // SAK runs as a group leader, so the whole group gets SIGTERM and then SIGKILL.
  function stopChild(): Promise<void> {
    const current = child;
    child = null;
    if (!current?.pid || current.exitCode !== null || current.signalCode !== null) return Promise.resolve();
    const pid = current.pid;
    return new Promise((resolve) => {
      const kill = setTimeout(() => {
        signal(pid, "SIGKILL");
        resolve();
      }, stopTimeout);
      current.once("exit", () => {
        clearTimeout(kill);
        resolve();
      });
      if (!signal(pid, "SIGTERM")) {
        clearTimeout(kill);
        resolve();
      }
    });
  }

  return {
    sync,
    // Not queued behind a running check: that check sees closed and starts nothing.
    close() {
      closed = true;
      return stopChild();
    },
  };
}

function signal(pid: number, name: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, name);
    return true;
  } catch {
    return false;
  }
}

export type SakServe = ReturnType<typeof createSakServe> & { setUp?: (baseUrl: string) => Promise<void> };

// This host's SAK. The Electron app stops a SAK group the host leaves behind
// when it crashes, the same way it stops Grok. Call sync when the host starts
// and after Setup saves the connection, and setUp when Setup turns SAK on with no token.
export function createHostSak(connectionFile: string): SakServe {
  const locations = sakLocations(repoRoot);
  const run = promisify(execFile);
  const serve = createSakServe({
    connection: () => readConnection(connectionFile),
    command: (saved) => serveCommand(saved, locations),
    launch: ({ binary, args }) => spawn(binary, args, { detached: true, stdio: ["ignore", "pipe", "pipe"] }),
    isUp: (saved) => sakIsUp(saved),
    onProcess(pid, running) {
      const desktop: unknown = Reflect.get(process, "parentPort");
      if (isParentPort(desktop)) desktop.postMessage(sakMessage(pid, running));
    },
  });
  return {
    ...serve,
    async setUp(baseUrl: string) {
      if (await sakIsUp({ ...readConnection(connectionFile), baseUrl, token: "" })) throw sakError(400, "A local board already runs at this address. Add its token");
      await setUpLocalSak(connectionFile, locations, run);
    },
  };
}
