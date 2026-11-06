import assert from "node:assert/strict";
import test from "node:test";
import type { SimHelper } from "./simHelper.ts";
import { createSimStream } from "./simStream.ts";
import type { WebSocketConnection } from "../../websocket.ts";

const DEVICE = { id: "16CCC597-962C-4BF1-902E-8C412D8C45C2", platform: "ios" as const, name: "iPhone 17 Pro", os: "iOS 26.2", booted: true, state: "booted" };

const SPS = Buffer.from([0, 0, 0, 1, 0x67, 0x64, 0x00, 0x33, 0xac]);
const PPS = Buffer.from([0, 0, 0, 1, 0x68, 0xee, 0x3c, 0xb0]);
const IDR = Buffer.from([0, 0, 0, 1, 0x65, 0x88, 0x84]);
const SLICE = Buffer.from([0, 0, 0, 1, 0x41, 0x9a, 0x02]);

interface Viewer extends WebSocketConnection {
  closed: boolean;
  texts: Record<string, unknown>[];
  binary: Buffer[];
  say(message: Record<string, unknown>): void;
}

function viewer(): Viewer {
  const listeners: ((payload: Buffer, text: boolean) => void)[] = [];
  const texts: Record<string, unknown>[] = [];
  const binary: Buffer[] = [];
  const view: Viewer = {
    closed: false,
    texts,
    binary,
    send(payload) {
      binary.push(Buffer.from(payload));
      return true;
    },
    sendText(text) {
      texts.push(JSON.parse(String(text)));
      return true;
    },
    onMessage(listener) {
      listeners.push(listener);
    },
    onClose() {},
    close() {
      view.closed = true;
    },
    buffered: () => 0,
    say(message: Record<string, unknown>) {
      for (const listener of listeners) listener(Buffer.from(JSON.stringify(message)), true);
    },
  };
  return view;
}

function fakeHelper() {
  const calls: { op: string; args: Record<string, unknown> }[] = [];
  const frames = new Set<(data: Buffer) => void>();
  const exits = new Set<() => void>();
  const helper: SimHelper = {
    info: { width: 402, height: 874, widthPixels: 1206, heightPixels: 2622 },
    async call<T>(op: string, args: Record<string, unknown> = {}) {
      calls.push({ op, args });
      return {} as T;
    },
    post(op, args = {}) {
      calls.push({ op, args });
    },
    onFrame(listener) {
      frames.add(listener);
      return () => frames.delete(listener);
    },
    onExit(listener) {
      exits.add(listener);
      return () => exits.delete(listener);
    },
    alive: () => true,
  };
  return { helper, calls, emit: (data: Buffer) => frames.forEach((listener) => listener(data)), exit: () => exits.forEach((listener) => listener()) };
}

const pressed: string[] = [];
const simulator = {
  press: async (_device: unknown, button: string) => {
    pressed.push(button);
  },
};

test("the helper's H.264 reaches a viewer as the codec, then frames from a key frame on", async () => {
  const { helper, calls, emit } = fakeHelper();
  const stream = createSimStream(simulator);
  const watcher = viewer();
  const leave = stream.watch(DEVICE, watcher, helper);
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  assert.deepEqual(calls[0], { op: "stream", args: { fps: 60, scale: 1, bitrate: 8_000_000 } });
  emit(SLICE);
  emit(SPS);
  emit(PPS);
  emit(SLICE);
  emit(IDR);
  emit(SLICE);
  assert.deepEqual(watcher.texts.slice(0, 2), [
    { type: "size", format: "h264", width: 1206, height: 2622 },
    { type: "codec", codec: "avc1.640033", description: "AWQAM//hAAVnZAAzrAEABGjuPLA=" },
  ]);
  assert.deepEqual(
    watcher.binary.map((frame) => frame[0]),
    [1, 0],
    "frames before the first key frame are left out",
  );
  assert.deepEqual([...watcher.binary[0]!.subarray(1)], [0, 0, 0, 3, 0x65, 0x88, 0x84]);
  leave();
  assert.equal(calls.at(-1)?.op, "stop-stream");
});

test("touches from the page reach the helper in points, and Option makes a pinch", async () => {
  const { helper, calls } = fakeHelper();
  const stream = createSimStream(simulator);
  const watcher = viewer();
  stream.watch(DEVICE, watcher, helper);
  watcher.say({ type: "touch", action: "down", x: 603, y: 1311, width: 1206, height: 2622 });
  watcher.say({ type: "touch", action: "up", x: 300, y: 600, width: 1206, height: 2622, pinch: true });
  watcher.say({ type: "key", key: "home" });
  assert.deepEqual(calls.slice(-2), [
    { op: "touch", args: { phase: "down", x: 201, y: 437 } },
    { op: "touch2", args: { phase: "up", x1: 100, y1: 200, x2: 302, y2: 674 } },
  ]);
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  assert.deepEqual(pressed, ["home"]);
});

test("a helper that goes away closes its viewers, and a new helper gets a new stream", async () => {
  const first = fakeHelper();
  const stream = createSimStream(simulator);
  const watcher = viewer();
  stream.watch(DEVICE, watcher, first.helper);
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  first.exit();
  assert.equal(watcher.closed, true);
  assert.deepEqual(watcher.texts.at(-1), { type: "error", message: "The simulator stream stopped." });
  const second = fakeHelper();
  const next = viewer();
  stream.watch(DEVICE, next, second.helper);
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  assert.equal(second.calls[0]?.op, "stream");
});

test("a viewer that leaves mid-touch lifts its finger", () => {
  const { helper, calls } = fakeHelper();
  const stream = createSimStream(simulator);
  const watcher = viewer();
  const leave = stream.watch(DEVICE, watcher, helper);
  watcher.say({ type: "touch", action: "down", x: 603, y: 1311, width: 1206, height: 2622 });
  leave();
  assert.deepEqual(calls.find((call) => call.op === "touch" && call.args.phase === "up"), { op: "touch", args: { phase: "up", x: 201, y: 437 } });
});

test("keys from the page reach the helper, and a viewer that leaves lets go of the ones still down", () => {
  const { helper, calls } = fakeHelper();
  const stream = createSimStream(simulator);
  const watcher = viewer();
  const leave = stream.watch(DEVICE, watcher, helper);
  watcher.say({ type: "keyboard", action: "down", code: 225 });
  watcher.say({ type: "keyboard", action: "down", code: 4 });
  watcher.say({ type: "keyboard", action: "up", code: 4 });
  watcher.say({ type: "keyboard", action: "down", code: "x" });
  leave();
  assert.deepEqual(calls.filter((call) => call.op === "key"), [
    { op: "key", args: { code: 225, phase: "down" } },
    { op: "key", args: { code: 4, phase: "down" } },
    { op: "key", args: { code: 4, phase: "up" } },
    { op: "key", args: { code: 225, phase: "up" } },
  ]);
});
