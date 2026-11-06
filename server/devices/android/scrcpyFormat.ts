import { ANDROID_KEYCODES } from "../deviceMath.ts";

// scrcpy's own pointer ids for a finger, and for the mirrored second finger of its pinch.
export const FINGER = -2n;
export const VIRTUAL_FINGER = -3n;
const CONFIG = 1n << 62n;
const KEY = 1n << 61n;

export type ScrcpyPhase = "dummy" | "name" | "codec" | "frames";

// Parser progress through the video socket header, kept between reads.
export interface ScrcpyState {
  phase?: ScrcpyPhase;
  name?: string;
  codec?: string;
}

export type VideoPacket =
  | { type: "size"; width: number; height: number }
  | { type: "config" | "frame"; key: boolean; body: Buffer };

export interface TouchInput {
  action: string;
  x: unknown;
  y: unknown;
  width: unknown;
  height: unknown;
  pointer?: bigint;
}

// What the device sends back on the control socket.
export type DeviceMessage = { type: "clipboard"; text: string } | { type: "ack"; sequence: bigint };

// The most text one inject-text message carries.
export const TEXT_BYTES = 300;

export function pullPackets(buffer: Buffer, state: ScrcpyState): { packets: VideoPacket[]; rest: Buffer } {
  const packets: VideoPacket[] = [];
  let offset = 0;
  const phase = () => state.phase || "dummy";
  while (true) {
    const rest = buffer.length - offset;
    if (phase() === "dummy") {
      if (rest < 1) break;
      offset += 1;
      state.phase = "name";
      continue;
    }
    if (phase() === "name") {
      if (rest < 64) break;
      state.name = buffer.subarray(offset, offset + 64).toString("utf8").replace(/\0+$/, "");
      offset += 64;
      state.phase = "codec";
      continue;
    }
    if (phase() === "codec") {
      if (rest < 4) break;
      state.codec = buffer.subarray(offset, offset + 4).toString("utf8");
      offset += 4;
      state.phase = "frames";
      continue;
    }
    if (rest < 12) break;
    if (buffer.readUInt32BE(offset) & 0x80000000) {
      packets.push({ type: "size", width: buffer.readInt32BE(offset + 4), height: buffer.readInt32BE(offset + 8) });
      offset += 12;
      continue;
    }
    const bits = buffer.readBigUInt64BE(offset);
    const size = buffer.readUInt32BE(offset + 8);
    if (size > 8_000_000) {
      throw Object.assign(new Error("Video packet is too large"), { status: 502 });
    }
    if (rest < 12 + size) break;
    const body = Buffer.from(buffer.subarray(offset + 12, offset + 12 + size));
    offset += 12 + size;
    packets.push({ type: (bits & CONFIG) !== 0n ? "config" : "frame", key: (bits & KEY) !== 0n, body });
  }
  return { packets, rest: buffer.subarray(offset) };
}

export function encodeTouch({ action, x, y, width, height, pointer = FINGER }: TouchInput): Buffer {
  const buf = Buffer.alloc(32);
  buf[0] = 2;
  buf[1] = action === "down" ? 0 : action === "up" ? 1 : 2;
  buf.writeBigInt64BE(pointer, 2);
  buf.writeUInt32BE(clamp(x), 10);
  buf.writeUInt32BE(clamp(y), 14);
  buf.writeUInt16BE(clamp(width, 1, 65535), 18);
  buf.writeUInt16BE(clamp(height, 1, 65535), 20);
  buf.writeUInt16BE(action === "up" ? 0 : 0xffff, 22);
  buf.writeUInt32BE(action === "down" ? 1 : 0, 24);
  buf.writeUInt32BE(action === "up" ? 0 : 1, 28);
  return buf;
}

export function encodeKey(key: unknown): Buffer | null {
  const code = ANDROID_KEYCODES[String(key)] ?? 0;
  if (!code) return null;
  return Buffer.concat([keyEvent(code, "down"), keyEvent(code, "up")]);
}

// An Android key code going down or up.
export function keyEvent(code: number, action: "down" | "up"): Buffer {
  const buf = Buffer.alloc(14);
  buf[0] = 0;
  buf[1] = action === "down" ? 0 : 1;
  buf.writeUInt32BE(code, 2);
  return buf;
}

// Text typed as key presses, at most TEXT_BYTES of UTF-8.
export function encodeText(text: string): Buffer {
  const body = Buffer.from(text, "utf8");
  if (body.length > TEXT_BYTES) throw new Error("Text is too long for one message");
  const head = Buffer.alloc(5);
  head[0] = 1;
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
}

// Puts text on the device's clipboard and, with paste, pastes it into the focused field. The device
// acknowledges the sequence number once done.
export function encodeClipboard(text: string, sequence: bigint, paste: boolean): Buffer {
  const body = Buffer.from(text, "utf8");
  const head = Buffer.alloc(14);
  head[0] = 9;
  head.writeBigUInt64BE(sequence, 1);
  head[9] = paste ? 1 : 0;
  head.writeUInt32BE(body.length, 10);
  return Buffer.concat([head, body]);
}

// How a piece of text goes in: plain ASCII as key presses, in messages of at most TEXT_BYTES, and anything
// else pasted whole, since mixing the two in one field loses characters on Android's keyboards.
export function textRuns(text: string): { kind: "type" | "paste"; text: string }[] {
  if (!/^[\x20-\x7e]*$/.test(text)) return [{ kind: "paste", text }];
  const runs: { kind: "type" | "paste"; text: string }[] = [];
  for (let at = 0; at < text.length; at += TEXT_BYTES) runs.push({ kind: "type", text: text.slice(at, at + TEXT_BYTES) });
  return runs;
}

export function pullDeviceMessages(buffer: Buffer): { messages: DeviceMessage[]; rest: Buffer } {
  const messages: DeviceMessage[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const type = buffer[offset];
    const rest = buffer.length - offset;
    if (type === 0) {
      if (rest < 5) break;
      const length = buffer.readUInt32BE(offset + 1);
      if (rest < 5 + length) break;
      messages.push({ type: "clipboard", text: buffer.subarray(offset + 5, offset + 5 + length).toString("utf8") });
      offset += 5 + length;
    } else if (type === 1) {
      if (rest < 9) break;
      messages.push({ type: "ack", sequence: buffer.readBigUInt64BE(offset + 1) });
      offset += 9;
    } else if (type === 2) {
      if (rest < 5) break;
      const length = buffer.readUInt16BE(offset + 3);
      if (rest < 5 + length) break;
      offset += 5 + length;
    } else {
      return { messages, rest: Buffer.alloc(0) };
    }
  }
  return { messages, rest: buffer.subarray(offset) };
}

function clamp(value: unknown, min = 0, max = 20000): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}
