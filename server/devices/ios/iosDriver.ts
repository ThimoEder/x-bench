// The PlatformDriver for iOS simulators. `xcrun simctl` boots, installs, launches, takes screenshots, opens URLs,
// switches the appearance and reads logs. X Bench's simulator helper (simHelper.ts) does what simctl lacks:
// touches, typing, hardware buttons, the accessibility tree and the live view (simStream.ts).

import { setTimeout as sleep } from "node:timers/promises";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isRecord } from "../../../bridge/lenient.ts";
import { toJpeg } from "../../../bridge/jpeg.ts";
import { jpegSize, line, parseSimctlAll, pngSize, type Button, type Point } from "../deviceMath.ts";
import { defaultXcrun } from "../devices.ts";
import { messageOf } from "../../http.ts";
import { runProcess, type RunCommand } from "../../runProcess.ts";
import { parseDescribeUi } from "../screenTree.ts";
import type { AppLog, Launched, PathPoint, PlatformDriver, Shot, SimDevice } from "../simulator.ts";
import type { WebSocketConnection } from "../../websocket.ts";
import { createSimHelpers, type SimHelper, type SimHelpers } from "./simHelper.ts";
import { createSimStream } from "./simStream.ts";
import { readBundleId } from "./xcodeBuild.ts";

const BUTTONS = new Set<Button>(["home", "lock", "side", "siri"]);
// HID usage codes of the keys a simulator's hardware keyboard sends.
const KEYS: Partial<Record<Button, number>> = { enter: 40, delete: 42, tab: 43, escape: 41 };

export interface IosDriverOptions {
  logDir: string;
  run?: RunCommand;
  xcrun?: string;
  helpers?: SimHelpers;
}

export function createIosDriver(options: IosDriverOptions) {
  const run = options.run ?? runProcess;
  const xcrun = options.xcrun ?? defaultXcrun();
  const helpers = options.helpers ?? createSimHelpers();
  const { logDir } = options;
  const plutil = "/usr/bin/plutil";
  const scales = new Map<string, number>();
  const live = createSimStream({ press: (device, button) => press(device, button, 0) });
  const apps = createApps(run, xcrun, logDir);

  async function status() {
    const xcode = await run(xcrun, ["xcodebuild", "-version"], { timeoutMs: 15_000 }).then(({ stdout }) => stdout.toString("utf8").trim().split("\n")[0]?.trim() ?? "", () => "");
    return { xcode: { found: Boolean(xcode), version: xcode }, helper: { found: Boolean(helpers.path()) } };
  }

  async function list(): Promise<SimDevice[]> {
    try {
      const { stdout } = await run(xcrun, ["simctl", "list", "devices", "available", "-j"]);
      return parseSimctlAll(JSON.parse(stdout.toString("utf8")))
        .filter((device) => device.os.startsWith("iOS"))
        .map((device) => ({ id: device.id, platform: "ios" as const, name: device.name, os: device.os, booted: device.state === "booted", state: device.state }));
    } catch {
      return [];
    }
  }

  async function boot(device: SimDevice): Promise<SimDevice> {
    try {
      await run(xcrun, ["simctl", "boot", device.id], { timeoutMs: 120_000 });
    } catch (error) {
      if (!/current state: Booted/i.test(messageOf(error))) throw error;
    }
    await run(xcrun, ["simctl", "bootstatus", device.id, "-b"], { timeoutMs: 240_000 });
    return { ...device, booted: true, state: "booted" };
  }

  // Pixels per point.
  async function scaleOf(device: SimDevice): Promise<number> {
    const known = scales.get(device.id);
    if (known) return known;
    const scale = await readScale(device);
    scales.set(device.id, scale);
    return scale;
  }

  async function readScale(device: SimDevice): Promise<number> {
    try {
      const { stdout } = await run(xcrun, ["simctl", "list", "devices", "-j"]);
      const typeId = parseSimctlAll(JSON.parse(stdout.toString("utf8"))).find((row) => row.id === device.id)?.typeId ?? "";
      const types = await run(xcrun, ["simctl", "list", "devicetypes", "-j"]);
      const parsed: unknown = JSON.parse(types.stdout.toString("utf8"));
      const list: unknown[] = isRecord(parsed) && Array.isArray(parsed.devicetypes) ? parsed.devicetypes : [];
      const entry = list.find((item): item is { bundlePath: string } => typeof item === "object" && item !== null && "identifier" in item && item.identifier === typeId && "bundlePath" in item && typeof item.bundlePath === "string");
      if (!entry) return 3;
      const profile = path.join(entry.bundlePath, "Contents", "Resources", "profile.plist");
      const { stdout: value } = await run(plutil, ["-extract", "mainScreenScale", "raw", profile]);
      const scale = Number(value.toString("utf8").trim());
      return scale > 0 ? scale : 3;
    } catch {
      return 3;
    }
  }

  async function capture(device: SimDevice, type: "png" | "jpeg"): Promise<Buffer> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "x-bench-shot-"));
    try {
      const file = path.join(dir, `screen.${type}`);
      await run(xcrun, ["simctl", "io", device.id, "screenshot", `--type=${type}`, "--mask=black", file]);
      return await readFile(file);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async function screenshot(device: SimDevice): Promise<Shot> {
    const scale = await scaleOf(device);
    const png = await capture(device, "png");
    const size = pngSize(png);
    if (!size) throw new Error(`Couldn't read the screen of ${device.name}.`);
    const width = Math.max(1, Math.round(size.width / scale));
    const height = Math.max(1, Math.round(size.height / scale));
    return { data: await toJpeg(png, { extension: "png", quality: 70, longest: Math.max(width, height), run }), width, height };
  }

  async function frame(device: SimDevice): Promise<Shot> {
    const data = await capture(device, "jpeg");
    const size = jpegSize(data);
    if (!size) throw new Error(`Couldn't read the screen of ${device.name}.`);
    const scale = await scaleOf(device);
    return { data, width: Math.round(size.width / scale), height: Math.round(size.height / scale) };
  }

  async function stream(device: SimDevice) {
    if (!helpers.path()) return null;
    const helper = await helpers.get(device.id).catch(() => null);
    return helper ? (viewer: WebSocketConnection) => live.watch(device, viewer, helper) : null;
  }

  async function helperOf(device: SimDevice): Promise<SimHelper> {
    if (!helpers.path()) throw new Error("X Bench's simulator helper is missing from this build, so taps, typing, buttons and the screen's tree do not work on iOS. Build it with desktop/devices/sim-helper/build.sh.");
    try {
      return await helpers.get(device.id);
    } catch (error) {
      throw new Error(`X Bench's simulator helper could not start for ${device.name}: ${messageOf(error)}`);
    }
  }

  async function tree(device: SimDevice, timeoutMs: number) {
    return parseDescribeUi(await (await helperOf(device)).call("describe", {}, Math.max(1, timeoutMs)));
  }

  async function tap(device: SimDevice, point: Point, holdSeconds: number) {
    await (await helperOf(device)).call("tap", { x: point.x, y: point.y, hold: Math.min(10, holdSeconds) });
  }

  async function swipe(device: SimDevice, from: Point, to: Point, seconds: number) {
    await (await helperOf(device)).call("path", { points: line(from, to, seconds) }, 30_000);
  }

  async function touchPath(device: SimDevice, points: PathPoint[], second?: PathPoint[]) {
    const samples = (list: PathPoint[]) => list.map((point, index) => ({ x: point.x, y: point.y, dt: index ? (point.dt ?? 16) : 0 }));
    await (await helperOf(device)).call("path", { points: samples(points), ...(second ? { points2: samples(second) } : {}) }, 60_000);
  }

  async function type(device: SimDevice, text: string) {
    await (await helperOf(device)).call("type", { text }, 60_000);
  }

  async function press(device: SimDevice, button: Button, holdSeconds: number) {
    const key = KEYS[button];
    if (!BUTTONS.has(button) && key === undefined) throw new Error(`An iOS simulator has no ${button.replaceAll("_", " ")} button.`);
    const helper = await helperOf(device);
    if (key === undefined) await helper.call("button", { name: button, hold: Math.min(10, holdSeconds) || 0.1 });
    else await helper.call("key", { code: key, hold: Math.min(10, holdSeconds) || 0.02 });
  }

  async function openUrl(device: SimDevice, url: string) {
    await run(xcrun, ["simctl", "openurl", device.id, url]);
  }

  async function appearanceOf(device: SimDevice): Promise<"light" | "dark"> {
    const { stdout } = await run(xcrun, ["simctl", "ui", device.id, "appearance"]);
    return stdout.toString("utf8").trim() === "dark" ? "dark" : "light";
  }

  async function appearance(device: SimDevice, mode: "light" | "dark") {
    await run(xcrun, ["simctl", "ui", device.id, "appearance", mode]);
  }

  // A simulator shows its on-screen keyboard with its hardware keyboard disconnected, and has no way to read
  // that, so it shows unless show is false.
  async function softKeyboard(device: SimDevice, show?: boolean): Promise<boolean> {
    const next = show ?? true;
    await (await helperOf(device)).call("hardware-keyboard", { enabled: !next });
    return next;
  }

  async function shake(device: SimDevice) {
    await (await helperOf(device)).call("shake");
  }

  // HID usages: 227 is Command, and C, X and V are 6, 27 and 25.
  async function commandKey(device: SimDevice, code: number) {
    const helper = await helperOf(device);
    for (const [key, phase] of [[227, "down"], [code, "down"], [code, "up"], [227, "up"]] as const) await helper.call("key", { code: key, phase });
  }

  async function pasteboard(device: SimDevice): Promise<string> {
    return (await run(xcrun, ["simctl", "pbpaste", device.id])).stdout.toString("utf8");
  }

  async function paste(device: SimDevice, text: string) {
    await run(xcrun, ["simctl", "pbcopy", device.id], { input: text });
    await commandKey(device, 25);
  }

  async function copy(device: SimDevice, cut: boolean): Promise<string | null> {
    const before = await pasteboard(device);
    await commandKey(device, cut ? 27 : 6);
    // shortcut: a fixed wait for the app to fill the pasteboard, poll it if slow apps miss copies.
    await sleep(300);
    const after = await pasteboard(device);
    return after === before ? null : after;
  }

  return {
    title: "iOS simulators",
    unit: "points",
    settles: false,
    builds: true,
    missing: () => (helpers.path() ? "" : "X Bench's simulator helper is missing from this build, so taps, typing, buttons and the screen's tree do not work on iOS. Ask the person to check Settings → Devices."),
    status,
    list,
    boot,
    screenshot,
    frame,
    stream,
    tree,
    tap,
    swipe,
    touchPath,
    type,
    press,
    openUrl,
    ...apps,
    appearanceOf,
    appearance,
    softKeyboard,
    softKeyboardShown: async () => false,
    shake,
    paste,
    copy,
    close: () => live.close(),
  } satisfies PlatformDriver;
}

function createApps(run: RunCommand, xcrun: string, logDir: string) {
  async function install(device: SimDevice, appPath: string): Promise<string> {
    const info = await stat(appPath).catch(() => null);
    if (!info) throw new Error(`There is nothing at ${appPath}.`);
    if (!appPath.endsWith(".app")) throw new Error("Give the path of a .app built for the simulator.");
    await run(xcrun, ["simctl", "install", device.id, appPath], { timeoutMs: 180_000 });
    return readBundleId(appPath);
  }

  function logFiles(device: SimDevice, appId: string) {
    const base = path.join(logDir, `${device.id}-${appId.replace(/[^\w.-]/g, "_")}`);
    return { out: `${base}.out.log`, err: `${base}.err.log` };
  }

  async function launch(device: SimDevice, appId: string, args: string[]): Promise<Launched> {
    await mkdir(logDir, { recursive: true, mode: 0o700 });
    const files = logFiles(device, appId);
    await Promise.all([writeFile(files.out, "", { mode: 0o600 }), writeFile(files.err, "", { mode: 0o600 })]);
    // simctl hands SIMCTL_CHILD_ variables to the app. NSUnbufferedIO makes print reach the file at once.
    const { stdout } = await run(xcrun, ["simctl", "launch", "--terminate-running-process", `--stdout=${files.out}`, `--stderr=${files.err}`, device.id, appId, ...args], { timeoutMs: 60_000, env: { SIMCTL_CHILD_NSUnbufferedIO: "YES" } });
    const pid = Number(/:\s*(\d+)\s*$/.exec(stdout.toString("utf8").trim())?.[1]) || null;
    return { name: await appName(device, appId), pid };
  }

  async function appInfo(device: SimDevice, appId: string): Promise<string> {
    try {
      const { stdout } = await run(xcrun, ["simctl", "appinfo", device.id, appId]);
      return stdout.toString("utf8");
    } catch {
      return "";
    }
  }

  async function appName(device: SimDevice, appId: string): Promise<string> {
    const info = await appInfo(device, appId);
    return plistValue(info, "CFBundleDisplayName") || plistValue(info, "CFBundleName") || appId;
  }

  // Apple's frameworks log a lot from inside every app, so only lines sent from the app's bundle come without system.
  async function appLog(device: SimDevice, appId: string, seconds: number, system: boolean): Promise<AppLog> {
    const executable = plistValue(await appInfo(device, appId), "CFBundleExecutable");
    if (!executable) throw new Error(`${appId} is not installed on ${device.name}.`);
    const files = logFiles(device, appId);
    const printed = [...(await tail(files.out, "")), ...(await tail(files.err, "stderr: "))];
    const own = `process == "${executable.replaceAll('"', "")}"`;
    const bundle = system ? "" : await run(xcrun, ["simctl", "get_app_container", device.id, appId, "app"]).then(({ stdout }) => stdout.toString("utf8").trim()).catch(() => "");
    const predicate = bundle ? `${own} AND senderImagePath BEGINSWITH "${bundle.replaceAll('"', "")}/"` : own;
    const { stdout } = await run(xcrun, ["simctl", "spawn", device.id, "log", "show", "--last", `${Math.round(seconds)}s`, "--style", "compact", "--predicate", predicate], { timeoutMs: 60_000 });
    const logged = stdout
      .toString("utf8")
      .split("\n")
      .filter((line) => line.trim() && !line.startsWith("Timestamp") && !line.startsWith("Filtering the log"));
    return { printed, logged };
  }

  return { install, launch, appLog };
}

async function tail(file: string, prefix: string): Promise<string[]> {
  try {
    const text = await readFile(file, "utf8");
    return text
      .split("\n")
      .filter((line) => line.trim())
      .slice(-200)
      .map((line) => `${prefix}${line}`);
  } catch {
    return [];
  }
}

// A value in `simctl appinfo`'s old-style plist text.
function plistValue(text: string, key: string): string {
  const match = new RegExp(`\\b${key}\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|([^;\\s]+))\\s*;`).exec(text);
  return (match?.[1] ?? match?.[2] ?? "").replace(/\\(.)/g, "$1");
}
