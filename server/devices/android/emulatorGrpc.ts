// The Android emulator's own gRPC endpoint, the one Android Studio shows emulators through: raw screen frames,
// touches and keys. A running emulator writes its port and token to a discovery file; only the few calls
// the Device tab needs are spoken here, over node:http2 with a small protobuf codec.

import http2 from "node:http2";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const SERVICE = "/android.emulation.control.EmulatorController/";

export interface EmulatorEndpoint {
  serial: string;
  port: number;
  token: string;
}

export interface EmulatorFrame {
  width: number;
  height: number;
  // RGB888, width × height × 3 bytes.
  pixels: Buffer;
}

export interface EmulatorTouch {
  x: number;
  y: number;
  id: number;
  // false lifts the finger.
  down: boolean;
}

export interface EmulatorClient {
  // Frames as the screen changes, at the emulator's own size. Returns a function that stops the stream.
  stream(onFrame: (frame: EmulatorFrame) => void, onEnd: (error: Error | null) => void): () => void;
  touch(touches: EmulatorTouch[]): Promise<void>;
  // A key by its web name, like GoHome, GoBack or AppSwitch, pressed and let go.
  key(name: string): Promise<void>;
  close(): void;
}

// Where emulators announce themselves: pid_<pid>.ini files with port.serial, grpc.port and grpc.token.
export function discoveryDirs(): string[] {
  return [path.join(os.homedir(), "Library", "Caches", "TemporaryItems", "avd", "running"), path.join(os.tmpdir(), "avd", "running")];
}

export function findEmulator(serial: string, dirs = discoveryDirs(), alive: (pid: number) => boolean = processAlive): EmulatorEndpoint | null {
  const wanted = /^emulator-(\d+)$/.exec(serial)?.[1];
  if (!wanted) return null;
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((name) => /^pid_\d+\.ini$/.test(name));
    } catch {
      continue;
    }
    for (const name of names) {
      const pid = Number(/\d+/.exec(name)?.[0]);
      let text = "";
      try {
        text = readFileSync(path.join(dir, name), "utf8");
      } catch {
        continue;
      }
      const found = parseDiscovery(text);
      if (found.serialPort === wanted && found.port && found.token && alive(pid)) return { serial, port: found.port, token: found.token };
    }
  }
  return null;
}

export function parseDiscovery(text: string): { serialPort: string; port: number; token: string } {
  const value = (key: string) => new RegExp(`^${key.replaceAll(".", "\\.")}=(.*)$`, "m").exec(text)?.[1]?.trim() ?? "";
  return { serialPort: value("port.serial"), port: Number(value("grpc.port")) || 0, token: value("grpc.token") };
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function connectEmulator(endpoint: EmulatorEndpoint): EmulatorClient {
  const session = http2.connect(`http://127.0.0.1:${endpoint.port}`);
  session.on("error", () => {});

  function request(method: string, body: Buffer, onMessage?: (message: Buffer) => void): { done: Promise<void>; cancel(): void } {
    const req = session.request({
      ":method": "POST",
      ":path": SERVICE + method,
      "content-type": "application/grpc",
      te: "trailers",
      authorization: `Bearer ${endpoint.token}`,
    });
    const reader = grpcReader((message) => onMessage?.(message));
    let failure: Error | null = null;
    const done = new Promise<void>((resolve, reject) => {
      req.on("data", reader);
      req.on("response", (headers) => {
        failure = grpcError(headers) ?? failure;
      });
      req.on("trailers", (headers) => {
        failure = grpcError(headers) ?? failure;
      });
      req.on("error", reject);
      req.on("close", () => (failure ? reject(failure) : resolve()));
    });
    req.end(grpcFrame(body));
    return { done, cancel: () => req.close(http2.constants.NGHTTP2_CANCEL) };
  }

  return {
    stream(onFrame, onEnd) {
      const call = request("streamScreenshot", encodeFields([[1, 2]]), (message) => {
        const frame = readImage(message);
        if (frame) onFrame(frame);
      });
      let stopped = false;
      call.done.then(
        () => {
          if (!stopped) onEnd(null);
        },
        (error: unknown) => {
          if (!stopped) onEnd(error instanceof Error ? error : new Error(String(error)));
        },
      );
      return () => {
        stopped = true;
        call.cancel();
      };
    },
    async touch(touches) {
      const body = Buffer.concat(touches.map((touch) => encodeFields([[1, encodeFields([[1, Math.round(touch.x)], [2, Math.round(touch.y)], [3, touch.id], [4, touch.down ? 1024 : 0], [5, touch.down ? 20 : 0]])]])));
      await request("sendTouch", body).done;
    },
    async key(name) {
      await request("sendKey", encodeFields([[2, 2], [4, Buffer.from(name, "utf8")]])).done;
    },
    close() {
      session.close();
    },
  };
}

function grpcError(headers: http2.IncomingHttpHeaders): Error | null {
  const status = headers["grpc-status"];
  if (status === undefined || status === "0") return null;
  const message = headers["grpc-message"];
  return new Error(`The emulator refused the request (${String(status)}${message ? `: ${decodeURIComponent(String(message))}` : ""})`);
}

export function grpcFrame(body: Buffer): Buffer {
  const head = Buffer.alloc(5);
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
}

// Splits a gRPC body into messages. Frames run to megabytes, so chunks are joined only once one is complete.
export function grpcReader(onMessage: (message: Buffer) => void): (chunk: Buffer) => void {
  let chunks: Buffer[] = [];
  let have = 0;
  let need = 0;
  return (chunk) => {
    chunks.push(chunk);
    have += chunk.length;
    while (true) {
      if (!need) {
        if (have < 5) return;
        const head = chunks.length === 1 ? (chunks[0] as Buffer) : Buffer.concat(chunks, have);
        chunks = [head];
        need = 5 + head.readUInt32BE(1);
      }
      if (have < need) return;
      const all = chunks.length === 1 ? (chunks[0] as Buffer) : Buffer.concat(chunks, have);
      onMessage(all.subarray(5, need));
      const rest = all.subarray(need);
      chunks = rest.length ? [rest] : [];
      have = rest.length;
      need = 0;
    }
  };
}

type FieldValue = number | Buffer;

export function encodeFields(fields: [number, FieldValue][]): Buffer {
  const parts: Buffer[] = [];
  for (const [number, value] of fields) {
    if (typeof value === "number") {
      parts.push(varint(number << 3), varint(value));
    } else {
      parts.push(varint((number << 3) | 2), varint(value.length), value);
    }
  }
  return Buffer.concat(parts);
}

function varint(value: number): Buffer {
  // Negative int32 values take ten bytes in protobuf.
  let rest = value < 0 ? BigInt.asUintN(64, BigInt(value)) : BigInt(value);
  const bytes: number[] = [];
  while (rest > 127n) {
    bytes.push(Number(rest & 127n) | 128);
    rest >>= 7n;
  }
  bytes.push(Number(rest));
  return Buffer.from(bytes);
}

// A message's fields by number: varints as numbers, length-delimited fields as buffers.
export function decodeFields(buffer: Buffer): Map<number, FieldValue[]> {
  const fields = new Map<number, FieldValue[]>();
  let at = 0;
  const readVarint = () => {
    let result = 0n;
    let shift = 0n;
    while (at < buffer.length) {
      const byte = buffer[at++] as number;
      result |= BigInt(byte & 127) << shift;
      shift += 7n;
      if (!(byte & 128)) break;
    }
    return result;
  };
  while (at < buffer.length) {
    const key = Number(readVarint());
    const number = key >> 3;
    const wire = key & 7;
    let value: FieldValue;
    if (wire === 0) value = Number(readVarint());
    else if (wire === 2) {
      const length = Number(readVarint());
      value = buffer.subarray(at, at + length);
      at += length;
    } else if (wire === 1) {
      at += 8;
      continue;
    } else if (wire === 5) {
      at += 4;
      continue;
    } else break;
    const list = fields.get(number);
    if (list) list.push(value);
    else fields.set(number, [value]);
  }
  return fields;
}

function readImage(message: Buffer): EmulatorFrame | null {
  const image = decodeFields(message);
  const format = image.get(1)?.[0];
  const pixels = image.get(4)?.[0];
  if (!Buffer.isBuffer(format) || !Buffer.isBuffer(pixels)) return null;
  const fields = decodeFields(format);
  const width = Number(fields.get(3)?.[0]) || 0;
  const height = Number(fields.get(4)?.[0]) || 0;
  if (!width || !height || pixels.length !== width * height * 3) return null;
  return { width, height, pixels };
}
