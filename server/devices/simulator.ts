// Drives iOS simulators and Android devices for the simulator tools and the Device tab, through one
// PlatformDriver per platform: ios/iosDriver.ts and android/androidDriver.ts. Positions are in points on iOS
// and dp on Android, the units screenshots come back in; each driver scales them to its pixels.

import type { Button, DevicePlatform, Point } from "./deviceMath.ts";
import type { RunCommand } from "../runProcess.ts";
import type { ScreenNode } from "./screenTree.ts";
import type { WebSocketConnection } from "../websocket.ts";
import { createAndroidDriver, type AndroidDriverOptions } from "./android/androidDriver.ts";
import { createIosDriver } from "./ios/iosDriver.ts";
import type { SimHelpers } from "./ios/simHelper.ts";

// id is the simulator's UDID, the adb serial, or avd:<name> for an Android emulator that is not running.
export interface SimDevice {
  id: string;
  platform: DevicePlatform;
  name: string;
  os: string;
  booted: boolean;
  // simctl's state on iOS, adb's on Android, "stopped" for an emulator that is not running.
  state: string;
}

export interface ToolStatus {
  xcode: { found: boolean; version: string };
  // X Bench's own simulator helper, which iOS touches, typing, buttons and the screen's tree need.
  helper: { found: boolean };
  adb: { found: boolean; version: string };
  emulator: { found: boolean; path: string };
  // X Bench's Android helper, which reads the screen's tree and takes screenshots on the device.
  androidHelper: { found: boolean };
}

// A JPEG of the screen and the screen's size in points: one picture pixel per point from screenshot, and the
// screen's own pixels from frame where the platform can.
export interface Shot {
  data: Buffer;
  width: number;
  height: number;
}

export interface PathPoint extends Point {
  // Milliseconds since the previous point.
  dt?: number;
}

export interface AppLog {
  printed: string[];
  logged: string[];
}

export interface Launched {
  name: string;
  pid: number | null;
}

// One platform's devices. The simulator checks that a device is booted before it hands it to a driver.
export interface PlatformDriver {
  // simulator_list_devices's heading for the platform's devices.
  title: string;
  // What positions and screenshots count in.
  unit: string;
  // Whether the tools read the screen's tree once after an action, without waiting for two reads to agree. Set it
  // only when every tree read the driver makes waits for the screen to settle.
  settles: boolean;
  // Whether simulator_build makes apps for it.
  builds: boolean;
  // What this build lacks to drive the platform's devices, as a sentence for the agent, or "".
  missing(): string;
  status(): Promise<Partial<ToolStatus>>;
  list(): Promise<SimDevice[]>;
  boot(device: SimDevice): Promise<SimDevice>;
  screenshot(device: SimDevice): Promise<Shot>;
  frame(device: SimDevice): Promise<Shot>;
  // The live view for each viewer, or null when the device has none.
  stream(device: SimDevice): Promise<((viewer: WebSocketConnection) => () => void) | null>;
  tree(device: SimDevice, timeoutMs: number): Promise<ScreenNode[]>;
  tap(device: SimDevice, point: Point, holdSeconds: number): Promise<void>;
  swipe(device: SimDevice, from: Point, to: Point, seconds: number): Promise<void>;
  // One finger down at the first point, along the rest, and up at the last. second is a second finger's path,
  // point for point, for pinches and rotations.
  touchPath(device: SimDevice, points: PathPoint[], second?: PathPoint[]): Promise<void>;
  type(device: SimDevice, text: string): Promise<void>;
  press(device: SimDevice, button: Button, holdSeconds: number): Promise<void>;
  openUrl(device: SimDevice, url: string): Promise<void>;
  // Answers the app's bundle id when the platform reads one from the app.
  install(device: SimDevice, appPath: string): Promise<string>;
  launch(device: SimDevice, appId: string, args: string[]): Promise<Launched>;
  // What the app printed since simulator_launch started it, and its log lines from the last seconds.
  appLog(device: SimDevice, appId: string, seconds: number, system: boolean): Promise<AppLog>;
  appearanceOf(device: SimDevice): Promise<"light" | "dark">;
  appearance(device: SimDevice, mode: "light" | "dark"): Promise<void>;
  // The on-screen keyboard while a hardware keyboard is attached. Returns whether it shows now.
  softKeyboard(device: SimDevice, show?: boolean): Promise<boolean>;
  softKeyboardShown(device: SimDevice): Promise<boolean>;
  shake(device: SimDevice): Promise<void>;
  paste(device: SimDevice, text: string): Promise<void>;
  // Copies or cuts, and answers what landed on the pasteboard, or null when that stayed the same.
  copy(device: SimDevice, cut: boolean): Promise<string | null>;
  close(): void;
}

export interface SimulatorOptions {
  logDir: string;
  run?: RunCommand;
  xcrun?: string;
  helpers?: SimHelpers;
  android?: AndroidDriverOptions;
}

export type Simulator = ReturnType<typeof createSimulator>;

export function createSimulator(options: SimulatorOptions) {
  const ios = createIosDriver(options);
  const android = createAndroidDriver({ run: options.run, ...options.android });
  const drivers: Record<DevicePlatform, PlatformDriver> = { ios, android };
  const frames = new Map<string, Promise<Shot>>();

  function driverOf(device: Pick<SimDevice, "platform">): PlatformDriver {
    return drivers[device.platform];
  }

  async function status(): Promise<ToolStatus> {
    const [iosStatus, androidStatus] = await Promise.all([ios.status(), android.status()]);
    return { ...iosStatus, ...androidStatus };
  }

  async function list(): Promise<SimDevice[]> {
    return (await Promise.all(Object.values(drivers).map((driver) => driver.list()))).flat();
  }

  // A device by UDID, serial, avd:<name> or name. A name prefers a booted device.
  async function find(ref: string): Promise<SimDevice | null> {
    const devices = await list();
    const wanted = ref.trim().toLowerCase();
    const exact = devices.find((device) => device.id.toLowerCase() === wanted);
    if (exact) return exact;
    const named = devices.filter((device) => device.name.toLowerCase() === wanted || device.name.toLowerCase().startsWith(wanted));
    return named.find((device) => device.booted) ?? named[0] ?? null;
  }

  async function boot(device: SimDevice): Promise<SimDevice> {
    return device.booted ? device : driverOf(device).boot(device);
  }

  function booted(device: SimDevice): SimDevice {
    if (!device.booted) throw new Error(`${device.name} is not running. Boot it with simulator_boot first.`);
    return device;
  }

  // The Device tab's picture and its Save button. Pages asking at once share one capture.
  async function frame(device: SimDevice): Promise<Shot> {
    const ready = booted(device);
    const pending = frames.get(ready.id);
    if (pending) return pending;
    const job = driverOf(ready).frame(ready).finally(() => frames.delete(ready.id));
    frames.set(ready.id, job);
    return job;
  }

  async function touchPath(device: SimDevice, points: PathPoint[], second?: PathPoint[]) {
    const ready = booted(device);
    if (points.length < 2) throw new Error("A touch path needs at least two points.");
    if (second && second.length !== points.length) throw new Error("Both fingers need the same number of points.");
    if (points.reduce((sum, point) => sum + Math.max(0, point.dt ?? 16), 0) > 30_000) throw new Error("Keep a touch path under 30 seconds in all.");
    await driverOf(ready).touchPath(ready, points, second);
  }

  function close() {
    for (const driver of Object.values(drivers)) driver.close();
  }

  return {
    driverOf,
    status,
    list,
    find,
    boot,
    frame,
    touchPath,
    close,
    screenshot: async (device: SimDevice) => driverOf(device).screenshot(booted(device)),
    stream: async (device: SimDevice) => driverOf(device).stream(booted(device)),
    tree: async (device: SimDevice, timeoutMs = 45_000) => driverOf(device).tree(booted(device), timeoutMs),
    tap: async (device: SimDevice, point: Point, holdSeconds = 0) => driverOf(device).tap(booted(device), point, holdSeconds),
    swipe: async (device: SimDevice, from: Point, to: Point, seconds = 0.3) => driverOf(device).swipe(booted(device), from, to, Math.min(10, Math.max(0.05, seconds))),
    type: async (device: SimDevice, text: string) => driverOf(device).type(booted(device), text),
    press: async (device: SimDevice, button: Button, holdSeconds = 0) => driverOf(device).press(booted(device), button, holdSeconds),
    openUrl: async (device: SimDevice, url: string) => driverOf(device).openUrl(booted(device), url),
    install: async (device: SimDevice, appPath: string) => driverOf(device).install(booted(device), appPath),
    launch: async (device: SimDevice, appId: string, args: string[] = []) => driverOf(device).launch(booted(device), appId, args),
    appLog: async (device: SimDevice, appId: string, seconds: number, system = false) => driverOf(device).appLog(booted(device), appId, seconds, system),
    appearanceOf: async (device: SimDevice) => driverOf(device).appearanceOf(booted(device)),
    appearance: async (device: SimDevice, mode: "light" | "dark") => driverOf(device).appearance(booted(device), mode),
    softKeyboard: async (device: SimDevice, show?: boolean) => driverOf(device).softKeyboard(booted(device), show),
    softKeyboardShown: async (device: SimDevice) => driverOf(device).softKeyboardShown(booted(device)),
    shake: async (device: SimDevice) => driverOf(device).shake(booted(device)),
    paste: async (device: SimDevice, text: string) => driverOf(device).paste(booted(device), text),
    copy: async (device: SimDevice, cut = false) => driverOf(device).copy(booted(device), cut),
  };
}
