export type DevicePlatform = "ios" | "android";

// state is "booted" for simulators and the adb state for Android.
export interface Device {
  id: string;
  platform: DevicePlatform;
  name: string;
  state: string;
}

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface ContainedPointInput {
  containerWidth: number;
  containerHeight: number;
  imageWidth: number;
  imageHeight: number;
  clientX: number;
  clientY: number;
}

// The booted simulators in `xcrun simctl list devices -j` output, for the Device tab.
export function parseSimctl(json: unknown): Device[] {
  return parseSimctlAll(json)
    .filter((device) => device.state === "booted")
    .map((device) => ({ id: device.id, platform: "ios" as const, name: device.os ? `${device.name} · ${device.os}` : device.name, state: "booted" }));
}

export const BUTTONS = ["home", "lock", "side", "siri", "back", "app_switch", "volume_up", "volume_down", "enter", "delete", "tab", "escape"] as const;
export type Button = (typeof BUTTONS)[number];

// Android key codes for the buttons the Device tab and the simulator tools press.
export const ANDROID_KEYCODES: Record<string, number | undefined> = { home: 3, back: 4, lock: 26, side: 26, app_switch: 187, volume_up: 24, volume_down: 25, enter: 66, delete: 67, tab: 61, escape: 111 };

// A straight finger path from one point to another over seconds, sampled every 16 ms, at most 120 times.
export function line(from: Point, to: Point, seconds: number): { x: number; y: number; dt: number }[] {
  const steps = Math.max(2, Math.min(120, Math.round((seconds * 1000) / 16)));
  const dt = (seconds * 1000) / steps;
  return Array.from({ length: steps + 1 }, (_, index) => ({ x: from.x + ((to.x - from.x) * index) / steps, y: from.y + ((to.y - from.y) * index) / steps, dt: index ? dt : 0 }));
}

// Every available simulator in `xcrun simctl list devices available -j`, booted or not. state is
// simctl's own state in lower case ("booted", "shutdown", "booting").
export interface SimctlDevice {
  id: string;
  name: string;
  os: string;
  state: string;
  typeId: string;
}

export function parseSimctlAll(json: unknown): SimctlDevice[] {
  const devices: SimctlDevice[] = [];
  const raw = isObject(json) && "devices" in json ? json.devices : undefined;
  const groups: [string, unknown][] = Object.entries(raw && typeof raw === "object" ? raw : {});
  for (const [runtime, list] of groups) {
    if (!Array.isArray(list)) continue;
    const version = /\.(iOS|watchOS|tvOS|xrOS|visionOS)-(\d+)-(\d+)/.exec(runtime);
    const items: unknown[] = list;
    for (const item of items) {
      if (!isObject(item)) continue;
      const record = item as Record<string, unknown>;
      if (record.isAvailable === false || !UUID.test(String(record.udid || ""))) continue;
      devices.push({
        id: String(record.udid),
        name: typeof record.name === "string" && record.name ? record.name : "Simulator",
        os: version ? `${version[1]} ${version[2]}.${version[3]}` : "",
        state: typeof record.state === "string" ? record.state.toLowerCase() : "",
        typeId: typeof record.deviceTypeIdentifier === "string" ? record.deviceTypeIdentifier : "",
      });
    }
  }
  return devices;
}

export function parseAdbDevices(text: unknown): Device[] {
  const devices: Device[] = [];
  for (const line of String(text).split("\n")) {
    const match = /^(\S+)\s+(device|unauthorized|offline|authorizing)(?:\s+(.*))?$/.exec(line.trim());
    if (!match) continue;
    const id = match[1] ?? "";
    if (!ANDROID_ID.test(id)) continue;
    const model = /(?:^|\s)model:(\S+)/.exec(match[3] || "")?.[1];
    devices.push({
      id,
      platform: "android",
      name: androidName(id, model),
      state: match[2] ?? "",
    });
  }
  return devices;
}

export function findDevice<T extends { id: unknown }>(devices: readonly T[], id: unknown): T | null {
  if (typeof id !== "string" || !id) return null;
  return devices.find((device) => device.id === id) || null;
}

export function pngSize(buffer: unknown): Size | null {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;
  if (buffer.readUInt32BE(12) !== 0x49484452) return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!width || !height) return null;
  return { width, height };
}

// The size in a JPEG's start-of-frame marker.
export function jpegSize(buffer: unknown): Size | null {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let at = 2;
  while (at + 9 < buffer.length) {
    if (buffer[at] !== 0xff) return null;
    const marker = buffer[at + 1] ?? 0;
    const length = buffer.readUInt16BE(at + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = buffer.readUInt16BE(at + 5);
      const width = buffer.readUInt16BE(at + 7);
      return width && height ? { width, height } : null;
    }
    at += 2 + length;
  }
  return null;
}

// object-fit: contain. clientX/clientY are relative to the element box.
export function containedPoint({ containerWidth, containerHeight, imageWidth, imageHeight, clientX, clientY }: ContainedPointInput): Point | null {
  if (!(containerWidth > 0) || !(containerHeight > 0) || !(imageWidth > 0) || !(imageHeight > 0)) return null;
  const scale = Math.min(containerWidth / imageWidth, containerHeight / imageHeight);
  const offsetX = (containerWidth - imageWidth * scale) / 2;
  const offsetY = (containerHeight - imageHeight * scale) / 2;
  const x = (clientX - offsetX) / scale;
  const y = (clientY - offsetY) / scale;
  if (x < 0 || y < 0 || x >= imageWidth || y >= imageHeight) return null;
  return {
    x: Math.min(imageWidth - 1, Math.round(x)),
    y: Math.min(imageHeight - 1, Math.round(y)),
  };
}

export function devicePoint(point: Point | null | undefined, image: Partial<Size> | null | undefined, screen: Partial<Size> | null | undefined): Point | null {
  if (!point) return null;
  if (!screen?.width || !screen.height || !image?.width || !image.height) return point;
  return {
    x: Math.min(screen.width - 1, Math.round((point.x * screen.width) / image.width)),
    y: Math.min(screen.height - 1, Math.round((point.y * screen.height) / image.height)),
  };
}

function androidName(id: string, model: string | undefined): string {
  if (id.startsWith("emulator-")) return `Android emulator ${id.slice("emulator-".length)}`;
  if (model) return model.replaceAll("_", " ");
  return id;
}

// Anything a property read on parsed JSON can find a key on.
function isObject(value: unknown): value is object {
  return (typeof value === "object" || typeof value === "function") && value !== null;
}

const UUID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
const ANDROID_ID = /^[\w.:-]{1,80}$/;
