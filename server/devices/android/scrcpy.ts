// scrcpy's server on Android devices, for two jobs. The mirror streams a device's screen to the Device tab as
// H.264 (videoFanout.ts) at the device's own frame rate and takes the page's touches, pinches and keys over
// scrcpy's control socket. Controls are control-only sessions without video, which carry the touches, keys
// and text of the simulator tools and the Device tab's screenshot view.

import { randomBytes } from "node:crypto";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import net, { type AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";
import { z } from "zod";
import { fields, isRecord, maybe } from "../../../bridge/lenient.ts";
import type { Size } from "../deviceMath.ts";
import { encodeClipboard, encodeKey, encodeTouch, FINGER, pullDeviceMessages, pullPackets, VIRTUAL_FINGER, type ScrcpyState, type VideoPacket } from "./scrcpyFormat.ts";
import { pushFile } from "../devicePush.ts";
import { createDeviceHubs, type DeviceHub } from "../deviceHubs.ts";
import { createVideoFanout } from "../videoFanout.ts";
import type { WebSocketConnection } from "../../websocket.ts";

// The version of the server X Bench ships, which the server insists the client names.
const SCRCPY_VERSION = "4.1";
// Named by version, so X Bench builds that ship different servers do not overwrite each other's on a device.
const DEVICE_JAR = `/data/local/tmp/x-bench-scrcpy-server-${SCRCPY_VERSION}.jar`;
// Emulators encode in software, which keeps 60 fps up to about this many pixels on the long side.
const EMULATOR_MAX_SIZE = 1600;
const DEVICE_BITRATE = 16_000_000;
const EMULATOR_BITRATE = 8_000_000;
const CONTROL_IDLE_MS = 15 * 60_000;
const CONNECT_MS = 20_000;
const RETRY_MS = 60_000;
const RESET_VIDEO = Buffer.from([17]);

// A touch or key sent by the page over the stream socket.
const ControlMessage = fields({
  type: z.unknown().optional(),
  key: z.unknown().optional(),
  action: maybe(z.enum(["down", "up", "move"])),
  x: z.unknown().optional(),
  y: z.unknown().optional(),
  width: z.unknown().optional(),
  height: z.unknown().optional(),
  pinch: z.unknown().optional(),
});

export type RunAdb = (command: string, args: string[]) => Promise<void>;

export interface ScrcpyOptions {
  run?: RunAdb;
  adb: string;
  jar: string;
}

interface Tools {
  run: RunAdb;
  adb: string;
  jar: string;
}

interface Session {
  // The video socket, when the session streams.
  video: net.Socket | null;
  control: net.Socket;
  // Runs once when the server process or a socket goes away.
  onEnd(listener: (reason: string) => void): void;
  stop(): void;
}

export interface Mirror {
  watch(serial: string, viewer: WebSocketConnection): () => void;
  close(): void;
}

// A control session's way into a device: scrcpy control messages, in order.
export interface ScrcpyControl {
  send(bytes: Buffer): Promise<void>;
  // Puts text on the clipboard and pastes it into the focused field, done once the device acknowledges it.
  paste(text: string): Promise<void>;
  alive(): boolean;
}

export interface ScrcpyControls {
  // The device's control session, started when needed. Rejects when scrcpy cannot start.
  get(serial: string): Promise<ScrcpyControl>;
  close(): void;
}

function toolsOf(options: ScrcpyOptions): Tools {
  return { run: options.run || exec, adb: options.adb, jar: options.jar };
}

// X_BENCH_SCRCPY_SERVER in the packaged app, else the copy in this checkout (desktop/devices/android-helper/scrcpy).
export function defaultScrcpyJar(): string {
  return process.env.X_BENCH_SCRCPY_SERVER || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "desktop", "devices", "android-helper", "scrcpy", "scrcpy-server");
}

export function createMirror(options: ScrcpyOptions): Mirror {
  const tools = toolsOf(options);
  const hubs = createDeviceHubs<DeviceHub>();

  function watch(serial: string, viewer: WebSocketConnection): () => void {
    return hubs.watch(serial, viewer, (dead) => createHub(serial, tools, dead));
  }

  return { watch, close: hubs.close };
}

export function createScrcpyControls(options: ScrcpyOptions): ScrcpyControls {
  const tools = toolsOf(options);
  const running = new Map<string, Promise<ScrcpyControl>>();
  const sessions = new Set<Session>();
  const failedAt = new Map<string, { at: number; reason: string }>();
  let closed = false;

  // A session that failed to start is left alone for a minute.
  function get(serial: string): Promise<ScrcpyControl> {
    if (closed) return Promise.reject(new Error("The host is shutting down."));
    const existing = running.get(serial);
    if (existing) return existing;
    const failed = failedAt.get(serial);
    if (failed && Date.now() - failed.at < RETRY_MS) return Promise.reject(new Error(failed.reason));
    const job = openControl(serial).catch((error: unknown) => {
      running.delete(serial);
      failedAt.set(serial, { at: Date.now(), reason: error instanceof Error ? error.message : String(error) });
      throw error;
    });
    running.set(serial, job);
    return job;
  }

  async function openControl(serial: string): Promise<ScrcpyControl> {
    const session = await startSession(serial, tools, false);
    if (closed) {
      session.stop();
      throw new Error("The host is shutting down.");
    }
    sessions.add(session);
    let ended = false;
    let idle: NodeJS.Timeout | null = null;
    let sequence = 1n;
    const acks = new Map<bigint, (error?: Error) => void>();
    let pending: Buffer = Buffer.alloc(0);
    session.control.on("data", (chunk: Buffer) => {
      const pulled = pullDeviceMessages(pending.length ? Buffer.concat([pending, chunk]) : chunk);
      pending = Buffer.from(pulled.rest);
      for (const message of pulled.messages) {
        if (message.type !== "ack") continue;
        acks.get(message.sequence)?.();
        acks.delete(message.sequence);
      }
    });
    session.control.resume();
    session.onEnd(() => {
      ended = true;
      sessions.delete(session);
      if (idle) clearTimeout(idle);
      running.delete(serial);
      for (const done of acks.values()) done(new Error("The device's control session stopped before it took the text."));
      acks.clear();
    });
    const rest = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => session.stop(), CONTROL_IDLE_MS);
      idle.unref();
    };
    rest();
    const send = (bytes: Buffer) =>
      new Promise<void>((resolve, reject) => {
        if (ended) {
          reject(new Error("The device's control session stopped."));
          return;
        }
        rest();
        session.control.write(bytes, (error) => (error ? reject(error) : resolve()));
      });
    const control: ScrcpyControl = {
      send,
      async paste(text) {
        const id = sequence++;
        let timer: NodeJS.Timeout | undefined;
        const acked = new Promise<void>((resolve, reject) => {
          timer = setTimeout(() => {
            acks.delete(id);
            reject(new Error("The device did not take the pasted text."));
          }, 5000);
          acks.set(id, (error) => {
            clearTimeout(timer);
            if (error) reject(error);
            else resolve();
          });
        });
        try {
          await send(encodeClipboard(text, id, true));
        } catch (error) {
          clearTimeout(timer);
          acks.delete(id);
          acked.catch(() => {});
          throw error;
        }
        await acked;
      },
      alive: () => !ended,
    };
    return control;
  }

  function close() {
    closed = true;
    for (const session of [...sessions]) session.stop();
    running.clear();
  }

  return { get, close };
}

// The jar goes to the device once per host run, and again after a start fails.
const pushed = new Map<string, Promise<void>>();

function pushServer(serial: string, tools: Tools, jar: string): Promise<void> {
  const key = `${serial}\n${jar}`;
  let job = pushed.get(key);
  if (!job) {
    job = pushFile(tools.run, tools.adb, serial, jar, DEVICE_JAR);
    job.catch(() => pushed.delete(key));
    pushed.set(key, job);
  }
  return job;
}

async function startSession(serial: string, tools: Tools, video: boolean): Promise<Session> {
  const { jar } = tools;
  const scid = (randomBytes(4).readUInt32BE(0) & 0x7fffffff).toString(16).padStart(8, "0");
  const port = await freePort();
  try {
    await pushServer(serial, tools, jar);
    await tools.run(tools.adb, ["-s", serial, "forward", `tcp:${port}`, `localabstract:scrcpy_${scid}`]);
  } catch (error) {
    pushed.delete(`${serial}\n${jar}`);
    throw error;
  }
  const emulator = serial.startsWith("emulator-");
  const videoArgs = video ? [`video_bit_rate=${emulator ? EMULATOR_BITRATE : DEVICE_BITRATE}`, ...(emulator ? [`max_size=${EMULATOR_MAX_SIZE}`] : [])] : ["video=false"];
  const shell: ChildProcessByStdio<null, Readable, Readable> = spawn(
    tools.adb,
    ["-s", serial, "shell", `CLASSPATH=${DEVICE_JAR}`, "app_process", "/", "com.genymobile.scrcpy.Server", SCRCPY_VERSION, `scid=${scid}`, "log_level=error", "audio=false", ...videoArgs, "tunnel_forward=true", "clipboard_autosync=false", "cleanup=false"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  const keep = (chunk: Buffer) => {
    output = (output + chunk.toString("utf8")).slice(-500);
  };
  shell.stderr.on("data", keep);
  shell.stdout.on("data", keep);
  const listeners = new Set<(reason: string) => void>();
  let ended = false;
  let videoSocket: net.Socket | null = null;
  let controlSocket: net.Socket | null = null;
  const end = (reason: string) => {
    if (ended) return;
    ended = true;
    videoSocket?.destroy();
    controlSocket?.destroy();
    shell.kill("SIGKILL");
    tools.run(tools.adb, ["-s", serial, "forward", "--remove", `tcp:${port}`]).catch(() => {});
    for (const listener of listeners) listener(reason);
  };
  shell.on("close", () => end(output.trim() || "The device's scrcpy session stopped"));
  try {
    // The first socket carries a dummy byte that shows the server is there.
    const first = await connectRetry(port, () => ended);
    if (video) {
      videoSocket = first;
      controlSocket = await connectOnce(port);
    } else {
      controlSocket = first;
      // The device's name follows the dummy byte.
      await new Promise<void>((resolve, reject) => {
        let seen = 0;
        const done = (error?: Error) => {
          clearTimeout(timer);
          first.off("data", skip);
          first.off("close", closed);
          if (error) reject(error);
          else resolve();
        };
        const closed = () => done(new Error("The device's scrcpy session closed while starting"));
        const timer = setTimeout(() => done(new Error("The device's scrcpy session did not start")), CONNECT_MS);
        const skip = (chunk: Buffer) => {
          seen += chunk.length;
          if (seen < 64) return;
          first.pause();
          const extra = chunk.subarray(chunk.length - (seen - 64));
          if (extra.length) first.unshift(extra);
          done();
        };
        first.on("data", skip);
        first.once("close", closed);
        first.resume();
      });
    }
  } catch (error) {
    // The device may have lost the jar, as a new emulator on the same serial has, so the next start pushes it again.
    pushed.delete(`${serial}\n${jar}`);
    end(error instanceof Error ? error.message : String(error));
    throw new Error(output.trim() || (error instanceof Error ? error.message : "The device's scrcpy session did not start"));
  }
  const control = controlSocket;
  control.on("error", () => {});
  control.on("close", () => end("The device's scrcpy session stopped"));
  videoSocket?.on("close", () => end("The device's scrcpy session stopped"));
  return {
    video: videoSocket,
    control,
    onEnd(listener) {
      if (ended) listener("The device's scrcpy session stopped");
      else listeners.add(listener);
    },
    stop: () => end("stopped"),
  };
}

function createHub(serial: string, tools: Tools, onDead: () => void): DeviceHub {
  let session: Session | null = null;
  let stopped = false;
  let size: Size | null = null;
  let resetTimer: NodeJS.Timeout | null = null;
  const fanout = createVideoFanout(() => {
    if (resetTimer || stopped) return;
    resetTimer = setTimeout(() => {
      resetTimer = null;
      session?.control.write(RESET_VIDEO);
    }, 100);
  });
  // The dummy byte is read while connecting.
  const state: ScrcpyState = { phase: "name" };
  // Each viewer's finger while it is down, as the touch message that lifts it.
  const held = new Map<WebSocketConnection, Record<string, unknown>>();

  void (async () => {
    try {
      const started = await startSession(serial, tools, true);
      if (stopped) {
        started.stop();
        return;
      }
      session = started;
      started.onEnd((reason) => fail(reason));
      started.control.on("data", () => {});
      let pending: Buffer = Buffer.alloc(0);
      started.video?.on("data", (chunk: Buffer) => {
        try {
          const pulled = pullPackets(pending.length ? Buffer.concat([pending, chunk]) : chunk, state);
          pending = Buffer.from(pulled.rest);
          for (const packet of pulled.packets) take(packet);
        } catch (error) {
          fail(error instanceof Error ? error.message : String(error));
        }
      });
      started.video?.resume();
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  })();

  function take(packet: VideoPacket) {
    if (packet.type === "size") {
      size = { width: packet.width, height: packet.height };
      return;
    }
    if (size) fanout.frame(packet.body, size);
  }

  function add(viewer: WebSocketConnection) {
    const joining = fanout.viewers.size > 0;
    fanout.add(viewer);
    viewer.onMessage((payload, text) => {
      if (!text || !session) return;
      let message: unknown;
      try {
        message = JSON.parse(payload.toString("utf8"));
      } catch {
        return;
      }
      const bytes = controlBytes(message, size);
      if (!bytes) return;
      const touch = isRecord(message) && message.type === "touch" ? message : null;
      if (touch?.action === "up") held.delete(viewer);
      else if (touch) held.set(viewer, { ...touch, action: "up" });
      session.control.write(bytes);
    });
    if (joining && session) session.control.write(RESET_VIDEO);
  }

  function fail(reason: string) {
    if (stopped) return;
    stop();
    fanout.end(reason || "The emulator stream stopped");
    onDead();
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (resetTimer) clearTimeout(resetTimer);
    session?.stop();
    session = null;
  }

  // A viewer that leaves mid-touch lifts its finger, so the device is not left pressed.
  function remove(viewer: WebSocketConnection) {
    const lift = held.get(viewer);
    const bytes = lift ? controlBytes(lift, size) : null;
    if (bytes && session) session.control.write(bytes);
    held.delete(viewer);
    fanout.remove(viewer);
  }

  return { viewers: fanout.viewers, add, remove, stop };
}

// A page touch, in the picture's width × height, or a toolbar key. pinch adds scrcpy's mirrored second finger.
export function controlBytes(raw: unknown, size: Size | null): Buffer | null {
  const message = ControlMessage.parse(raw);
  if (message.type === "key") return encodeKey(message.key);
  if (message.type !== "touch" || !size?.width || !size.height || !message.action) return null;
  const width = Number(message.width) || size.width;
  const height = Number(message.height) || size.height;
  const x = (Number(message.x) * size.width) / width;
  const y = (Number(message.y) * size.height) / height;
  const touch = (pointer: bigint, at: { x: number; y: number }) => encodeTouch({ action: message.action ?? "move", x: at.x, y: at.y, width: size.width, height: size.height, pointer });
  if (message.pinch !== true) return touch(FINGER, { x, y });
  return Buffer.concat([touch(FINGER, { x, y }), touch(VIRTUAL_FINGER, { x: size.width - x, y: size.height - y })]);
}

function connectOnce(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("The device's scrcpy session did not connect"));
    }, 400);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

// adb accepts the forwarded connection before the server listens, so a socket counts once its first byte comes.
// A busy emulator takes seconds to start the server.
async function connectRetry(port: number, gone: () => boolean): Promise<net.Socket> {
  const deadline = Date.now() + CONNECT_MS;
  while (Date.now() < deadline && !gone()) {
    try {
      const socket = await connectOnce(port);
      const first = await new Promise<Buffer | null>((resolve) => {
        const timer = setTimeout(() => resolve(null), 300);
        socket.once("data", (chunk: Buffer) => {
          clearTimeout(timer);
          resolve(chunk);
        });
        socket.once("close", () => {
          clearTimeout(timer);
          resolve(null);
        });
      });
      if (first) {
        // Paused until its reader is there, so nothing after the dummy byte is lost.
        socket.pause();
        if (first.length > 1) socket.unshift(first.subarray(1));
        return socket;
      }
      socket.destroy();
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  throw new Error("The device's scrcpy session did not connect");
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      // A TCP listen always has an AddressInfo.
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function exec(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(err.trim() || `${path.basename(command)} failed`));
      else resolve();
    });
  });
}

