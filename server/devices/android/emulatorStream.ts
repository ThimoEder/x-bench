// The live view of an Android emulator in the Device tab, the way Android Studio shows one: the emulator's
// gRPC endpoint (emulatorGrpc.ts) hands over raw frames at its own size whenever the screen changes,
// xbench-encode turns them into H.264 on the Mac's hardware encoder, and videoFanout.ts sends them to the
// page. Touches, pinches and keys go back over gRPC.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { fields } from "../../../bridge/lenient.ts";
import type { Size } from "../deviceMath.ts";
import { connectEmulator, findEmulator, type EmulatorClient, type EmulatorEndpoint, type EmulatorFrame, type EmulatorTouch } from "./emulatorGrpc.ts";
import { createDeviceHubs, type DeviceHub } from "../deviceHubs.ts";
import { createVideoFanout } from "../videoFanout.ts";
import type { WebSocketConnection } from "../../websocket.ts";

const BITRATE = 16_000_000;
const KEYS: Record<string, string> = { home: "GoHome", back: "GoBack", app_switch: "AppSwitch" };

const Message = fields({
  type: z.unknown().optional(),
  key: z.unknown().optional(),
  action: z.unknown().optional(),
  x: z.unknown().optional(),
  y: z.unknown().optional(),
  width: z.unknown().optional(),
  height: z.unknown().optional(),
  pinch: z.unknown().optional(),
});

export interface EmulatorStreamOptions {
  // xbench-encode's path, or null when this build has none.
  encoder?: string | null;
  find?: (serial: string) => EmulatorEndpoint | null;
  connect?: (endpoint: EmulatorEndpoint) => EmulatorClient;
  startEncoder?: (file: string) => ChildProcessWithoutNullStreams;
}

export interface EmulatorStream {
  // Whether the serial is an emulator this view can show.
  available(serial: string): boolean;
  watch(serial: string, viewer: WebSocketConnection): () => void;
  close(): void;
}

export function createEmulatorStream(options: EmulatorStreamOptions = {}): EmulatorStream {
  const encoder = options.encoder !== undefined ? options.encoder : defaultEncoder();
  const find = options.find ?? ((serial: string) => findEmulator(serial));
  const connect = options.connect ?? connectEmulator;
  const startEncoder = options.startEncoder ?? ((file: string) => spawn(file, ["--bitrate", String(BITRATE)], { stdio: ["pipe", "pipe", "pipe"] }));
  const hubs = createDeviceHubs<DeviceHub>();

  function available(serial: string): boolean {
    return Boolean(encoder) && Boolean(find(serial));
  }

  function watch(serial: string, viewer: WebSocketConnection): () => void {
    return hubs.watch(serial, viewer, (dead) => {
      const endpoint = find(serial);
      if (!encoder || !endpoint) {
        viewer.sendText(JSON.stringify({ type: "error", message: "The emulator's screen is not available." }));
        viewer.close();
        return null;
      }
      return createHub(connect(endpoint), startEncoder(encoder), dead);
    });
  }

  return { available, watch, close: hubs.close };
}

function createHub(client: EmulatorClient, encoder: ChildProcessWithoutNullStreams, onDead: () => void): DeviceHub {
  const fanout = createVideoFanout(() => wantKey());
  // The last frame from the emulator, sent again as a key frame when a viewer needs one on a still screen.
  let last: EmulatorFrame | null = null;
  // A frame that waits while the encoder catches up. Only the newest one is kept.
  let queued: { frame: EmulatorFrame; key: boolean } | null = null;
  let keyTimer: NodeJS.Timeout | null = null;
  let size: Size | null = null;
  // Each viewer's fingers while they are down, in pixels.
  const held = new Map<WebSocketConnection, EmulatorTouch[]>();
  let pending: Buffer = Buffer.alloc(0);
  let stderr = "";
  let stopped = false;
  let first = true;
  // Touches and keys go to the emulator one at a time, in order, since each is its own gRPC call. A move
  // waiting behind another move replaces it.
  const outbox: { job: () => Promise<void>; move: boolean }[] = [];
  let sending = false;

  encoder.stdin.on("error", () => {});
  encoder.stdin.on("drain", () => {
    const next = queued;
    queued = null;
    if (next) write(next.frame, next.key);
  });
  encoder.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-1000);
  });
  encoder.stdout.on("data", (chunk: Buffer) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= 5) {
      const length = pending.readUInt32BE(1);
      if (pending.length < 5 + length) break;
      const body = pending.subarray(5, 5 + length);
      pending = pending.subarray(5 + length);
      if (size && body.length) fanout.frame(body, size);
    }
  });
  encoder.on("error", (error) => fail(error.message));
  encoder.on("exit", () => fail(stderr.trim().split("\n").pop()?.replace(/^xbench-encode: /, "") || "The emulator's video encoder stopped."));

  const stopStream = client.stream(
    (frame) => {
      if (last && last.width === frame.width && last.height === frame.height && last.pixels.equals(frame.pixels)) return;
      last = frame;
      const key = first;
      first = false;
      if (encoder.stdin.writableNeedDrain) queued = { frame, key: key || Boolean(queued?.key) };
      else write(frame, key);
    },
    (error) => fail(error ? `The emulator stream stopped: ${error.message}` : "The emulator stream stopped."),
  );

  function write(frame: EmulatorFrame, key: boolean) {
    if (stopped) return;
    size = { width: frame.width, height: frame.height };
    const head = Buffer.alloc(9);
    head[0] = key ? 1 : 0;
    head.writeUInt32BE(frame.width, 1);
    head.writeUInt32BE(frame.height, 5);
    encoder.stdin.write(head);
    encoder.stdin.write(frame.pixels);
  }

  function wantKey() {
    if (keyTimer || stopped) return;
    keyTimer = setTimeout(() => {
      keyTimer = null;
      if (stopped || !last) return;
      if (encoder.stdin.writableNeedDrain) queued = { frame: queued?.frame ?? last, key: true };
      else write(last, true);
    }, 100);
  }

  function add(viewer: WebSocketConnection) {
    fanout.add(viewer);
    viewer.onMessage((payload, text) => {
      if (!text) return;
      try {
        act(viewer, JSON.parse(payload.toString("utf8")));
      } catch {
        // Not a message this view sends.
      }
    });
    if (last) wantKey();
  }

  // Positions arrive in the page's picture of the screen, width by height, and go to the emulator in pixels.
  function act(viewer: WebSocketConnection, raw: unknown) {
    const message = Message.parse(raw);
    if (message.type === "key") {
      const name = KEYS[String(message.key)];
      if (name) queue(() => client.key(name), false);
      return;
    }
    if (message.type !== "touch" || !size) return;
    const width = Number(message.width);
    const height = Number(message.height);
    const x = Number(message.x);
    const y = Number(message.y);
    if (!(width > 0) || !(height > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const at = { x: (x * size.width) / width, y: (y * size.height) / height };
    const down = message.action !== "up";
    const touches = [{ ...at, id: 0, down }];
    if (message.pinch === true) touches.push({ x: size.width - at.x, y: size.height - at.y, id: 1, down });
    if (down) held.set(viewer, touches);
    else held.delete(viewer);
    queue(() => client.touch(touches), message.action === "move");
  }

  function queue(job: () => Promise<void>, move: boolean) {
    const last = outbox[outbox.length - 1];
    if (move && last?.move) outbox[outbox.length - 1] = { job, move };
    else outbox.push({ job, move });
    void drain();
  }

  async function drain() {
    if (sending) return;
    sending = true;
    for (let next = outbox.shift(); next; next = outbox.shift()) await next.job().catch(() => {});
    sending = false;
  }

  // A viewer that leaves mid-touch lifts its fingers, so the emulator is not left pressed.
  function remove(viewer: WebSocketConnection) {
    const fingers = held.get(viewer);
    if (fingers) queue(() => client.touch(fingers.map((finger) => ({ ...finger, down: false }))), false);
    held.delete(viewer);
    fanout.remove(viewer);
  }

  function fail(reason: string) {
    if (stopped) return;
    stop();
    fanout.end(reason);
    onDead();
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (keyTimer) clearTimeout(keyTimer);
    stopStream();
    client.close();
    encoder.stdin.end();
    setTimeout(() => {
      if (encoder.exitCode === null) encoder.kill("SIGTERM");
    }, 1000).unref();
  }

  return { viewers: fanout.viewers, add, remove, stop };
}

// X_BENCH_ANDROID_ENCODER in the packaged app, else the build in this checkout.
function defaultEncoder(): string | null {
  const given = process.env.X_BENCH_ANDROID_ENCODER;
  if (given) return existsSync(given) ? given : null;
  const local = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "desktop", "devices", "android-helper", "build", "xbench-encode");
  return existsSync(local) ? local : null;
}
