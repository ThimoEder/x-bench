import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// A data frame carries text; close and ping frames carry their flag instead.
export type Frame =
  | { text: boolean; close?: undefined; ping?: undefined; payload: Buffer }
  | { close: true; text?: undefined; ping?: undefined; payload: Buffer }
  | { ping: true; text?: undefined; close?: undefined; payload: Buffer };

// The start of a message whose final frame has not arrived yet.
export interface Fragment {
  opcode: number;
  payload: Buffer;
}

export type MessageListener = (payload: Buffer, text: boolean) => void;

export interface WebSocketConnection {
  send(payload: Buffer | string): boolean;
  sendText(text: Buffer | string): boolean;
  onMessage(listener: MessageListener): void;
  onClose(listener: () => void): void;
  close(): void;
  buffered(): number;
}

export function acceptWebSocket(req: IncomingMessage, socket: Duplex, head?: Buffer | null): WebSocketConnection | null {
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    return null;
  }
  const accept = createHash("sha1").update(String(key) + GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  return createSocket(socket, head);
}

export function decodeFrames(
  buffer: Buffer,
  pending: Fragment | null = null,
): { frames: Frame[]; rest: Buffer; pending: Fragment | null } {
  const frames: Frame[] = [];
  let offset = 0;
  let fragment = pending;
  while (buffer.length - offset >= 2) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    if (first === undefined || second === undefined) break;
    const fin = (first & 0x80) !== 0;
    let opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let at = offset + 2;
    if (length === 126) {
      if (buffer.length - at < 2) break;
      length = buffer.readUInt16BE(at);
      at += 2;
    } else if (length === 127) {
      if (buffer.length - at < 8) break;
      const big = buffer.readBigUInt64BE(at);
      if (big > 8_000_000n) throw new Error("WebSocket frame is too large");
      length = Number(big);
      at += 8;
    }
    const mask = masked ? 4 : 0;
    if (buffer.length - at < mask + length) break;
    let payload = buffer.subarray(at + mask, at + mask + length);
    if (masked) payload = unmask(payload, buffer.subarray(at, at + 4));
    offset = at + mask + length;
    if (opcode === 0 && fragment) {
      fragment.payload = Buffer.concat([fragment.payload, payload]);
      opcode = fragment.opcode;
      payload = fragment.payload;
    }
    if (!fin) {
      fragment = { opcode, payload: Buffer.from(payload) };
      continue;
    }
    fragment = null;
    if (opcode === 0x1 || opcode === 0x2) frames.push({ text: opcode === 0x1, payload: Buffer.from(payload) });
    if (opcode === 0x8) frames.push({ close: true, payload: Buffer.alloc(0) });
    if (opcode === 0x9) frames.push({ ping: true, payload: Buffer.from(payload) });
  }
  return { frames, rest: buffer.subarray(offset), pending: fragment };
}

export function encodeFrame(payload: Buffer | string, opcode: number): Buffer {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;
  if (body.length < 126) {
    header = Buffer.alloc(2);
    header[1] = body.length;
  } else if (body.length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, body]);
}

function createSocket(socket: Duplex, head: Buffer | null | undefined): WebSocketConnection {
  let incoming: Buffer = Buffer.from(head || []);
  let pending: Fragment | null = null;
  const message: MessageListener[] = [];
  const close: (() => void)[] = [];
  const sendRaw = (payload: Buffer | string, opcode: number) => {
    if (socket.destroyed || socket.writableEnded) return false;
    return socket.write(encodeFrame(payload, opcode));
  };
  socket.on("data", (chunk: Buffer) => {
    incoming = incoming.length ? Buffer.concat([incoming, chunk]) : chunk;
    let parsed: ReturnType<typeof decodeFrames>;
    try {
      parsed = decodeFrames(incoming, pending);
    } catch {
      socket.destroy();
      return;
    }
    incoming = Buffer.from(parsed.rest);
    pending = parsed.pending;
    for (const frame of parsed.frames) {
      if (frame.close) {
        socket.end();
        return;
      }
      if (frame.ping) {
        sendRaw(frame.payload, 0x0a);
        continue;
      }
      for (const listener of message) listener(frame.payload, frame.text);
    }
  });
  socket.on("close", () => {
    for (const listener of close) listener();
  });
  socket.on("error", () => socket.destroy());
  return {
    send(payload) {
      return sendRaw(payload, 0x02);
    },
    sendText(text) {
      return sendRaw(text, 0x01);
    },
    onMessage(listener) {
      message.push(listener);
    },
    onClose(listener) {
      close.push(listener);
    },
    close() {
      if (!socket.destroyed) socket.end();
    },
    buffered() {
      return socket.writableLength || 0;
    },
  };
}

function unmask(payload: Buffer, mask: Buffer): Buffer {
  const out = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) out[i] = (payload[i] ?? 0) ^ (mask[i & 3] ?? 0);
  return out;
}
