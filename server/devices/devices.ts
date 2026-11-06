// The Device tab's list of running simulators and connected Android devices, and the device it should show.

import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { findDevice, parseAdbDevices, parseSimctl, type Device } from "./deviceMath.ts";
import { runProcess, type RunCommand } from "../runProcess.ts";
import type { SimDevice } from "./simulator.ts";

export interface DevicesOptions {
  run?: RunCommand;
  adb?: string;
  xcrun?: string;
  now?: () => number;
}

export interface DeviceList {
  devices: Device[];
}

export type DeviceError = Error & { status: number };

// count goes up whenever an agent launches an app or starts a device, so the page brings the Device tab up
// for that chat with the device shown.
export interface DeviceFocus {
  count: number;
  owner: string | null;
  device: string | null;
}

export type Devices = ReturnType<typeof createDevices>;

export function createDevices(options: DevicesOptions = {}) {
  const run = options.run || runProcess;
  const adb = options.adb || defaultAdb();
  const xcrun = options.xcrun || defaultXcrun();
  const now = options.now || Date.now;
  let cache: { at: number; value: DeviceList } | null = null;
  let loading: Promise<DeviceList> | null = null;
  let didReconnect = false;
  let focused: DeviceFocus = { count: 0, owner: null, device: null };
  // Each running emulator's AVD name. adb hands a serial to the next emulator, so a name is asked again after a while.
  const avdNames = new Map<string, { name: string; at: number }>();
  const listeners = new Set<() => void>();

  async function list(): Promise<DeviceList> {
    if (cache && now() - cache.at < 1000) return cache.value;
    if (loading) return loading;
    loading = load()
      .then((value) => {
        cache = { at: now(), value };
        return value;
      })
      .finally(() => {
        loading = null;
      });
    return loading;
  }

  async function load(): Promise<DeviceList> {
    const [ios, android] = await Promise.all([readIos(), readAndroid()]);
    let rows = android;
    if (rows.some((device) => device.state === "unauthorized") && !didReconnect) {
      didReconnect = true;
      try {
        await run(adb, ["reconnect"]);
        rows = await readAndroid();
      } catch {
        // Keep the unauthorized row so the dock can say what is wrong.
      }
    }
    return { devices: [...ios, ...rows] };
  }

  async function readIos(): Promise<Device[]> {
    try {
      const { stdout } = await run(xcrun, ["simctl", "list", "devices", "booted", "-j"]);
      const json: unknown = JSON.parse(stdout.toString("utf8"));
      return parseSimctl(json);
    } catch {
      return [];
    }
  }

  async function readAndroid(): Promise<Device[]> {
    let rows: Device[];
    try {
      const { stdout } = await run(adb, ["devices", "-l"]);
      rows = parseAdbDevices(stdout.toString("utf8"));
    } catch {
      return [];
    }
    await Promise.all(
      rows.map(async (row) => {
        if (!row.id.startsWith("emulator-") || row.state !== "device") return;
        const name = await avdName(row.id);
        if (name) row.name = name;
      }),
    );
    return rows;
  }

  async function avdName(serial: string): Promise<string> {
    const known = avdNames.get(serial);
    if (known && now() - known.at < 30_000) return known.name;
    try {
      const { stdout } = await run(adb, ["-s", serial, "emu", "avd", "name"], { timeoutMs: 5000 });
      const line = stdout.toString("utf8").split("\n")[0]?.trim() ?? "";
      const name = line && line !== "OK" ? line.replaceAll("_", " ") : "";
      avdNames.set(serial, { name, at: now() });
      return name;
    } catch {
      return known?.name ?? "";
    }
  }

  // A listed device that is running, for the Device tab's picture, touches and live view.
  async function ready(id: string): Promise<SimDevice> {
    const { devices } = await list();
    const device = findDevice(devices, id);
    if (!device) throw fail("Device is not available", 404);
    if (device.state === "unauthorized") throw fail("Allow USB debugging on the emulator", 404);
    if (device.state !== "booted" && device.state !== "device") throw fail("Device is not available", 404);
    return { ...device, os: "", booted: true };
  }

  function focus(owner: string, device: string) {
    focused = { count: focused.count + 1, owner, device };
    for (const listener of listeners) listener();
  }

  function onChange(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return { list, ready, focus, focused: () => focused, onChange };
}

function fail(message: string, status: number): DeviceError {
  return Object.assign(new Error(message), { status });
}

export function defaultAdb(): string {
  const sdk = path.join(os.homedir(), "Library/Android/sdk/platform-tools/adb");
  return existsSync(sdk) ? sdk : "adb";
}

export function defaultXcrun(): string {
  return existsSync("/usr/bin/xcrun") ? "/usr/bin/xcrun" : "xcrun";
}
