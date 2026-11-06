import assert from "node:assert/strict";
import test from "node:test";
import { annexBToLength, avcCodec } from "./devices/h264.ts";
import { encodeKey, encodeTouch, pullPackets, type ScrcpyState } from "./devices/android/scrcpyFormat.ts";
import { decodeFrames, encodeFrame } from "./websocket.ts";

const CONFIG = Buffer.from("000000016742c0298d681b079a420202020f08846a0000000168ce01a835c8", "hex");

test("an h264 config packet becomes a browser codec description", () => {
  const codec = avcCodec(CONFIG);
  assert.equal(codec?.codec, "avc1.42C029");
  assert.equal(codec?.description[0], 1);
  assert.equal(codec?.description[1], 0x42);
  const frame = annexBToLength(Buffer.from("0000000165b80004", "hex"));
  assert.equal(frame.readUInt32BE(0), 4);
  assert.equal(frame[4], 0x65);
});

test("a scrcpy header yields the screen size and the config packet", () => {
  const name = Buffer.alloc(64);
  name.write("sdk_gphone64_arm64");
  const session = Buffer.alloc(12);
  session.writeUInt32BE(0x80000000, 0);
  session.writeInt32BE(432, 4);
  session.writeInt32BE(960, 8);
  const head = Buffer.alloc(12);
  head.writeBigUInt64BE(1n << 62n, 0);
  head.writeUInt32BE(CONFIG.length, 8);
  const bytes = Buffer.concat([Buffer.from([0]), name, Buffer.from("h264"), session, head, CONFIG, Buffer.from([1, 2])]);
  const state: ScrcpyState = {};
  const first = pullPackets(bytes.subarray(0, 20), state);
  assert.equal(first.packets.length, 0);
  const full = pullPackets(Buffer.concat([first.rest, bytes.subarray(20)]), state);
  assert.equal(state.name, "sdk_gphone64_arm64");
  assert.equal(state.codec, "h264");
  assert.deepEqual(full.packets[0], { type: "size", width: 432, height: 960 });
  const config = full.packets[1];
  assert.ok(config?.type === "config", "the second packet is not the config");
  assert.equal(config.body.equals(CONFIG), true);
  assert.equal(full.rest.length, 2);
});

test("a touch and a home key use the scrcpy control layout", () => {
  const touch = encodeTouch({ action: "down", x: 10, y: 20, width: 432, height: 960 });
  assert.equal(touch.length, 32);
  assert.equal(touch[0], 2);
  assert.equal(touch[1], 0);
  assert.equal(touch.readUInt32BE(10), 10);
  assert.equal(touch.readUInt32BE(14), 20);
  assert.equal(touch.readUInt16BE(18), 432);
  assert.equal(touch.readUInt16BE(22), 0xffff);
  const key = encodeKey("home");
  assert.ok(key, "the home key did not encode");
  assert.equal(key.length, 28);
  assert.equal(key[1], 0);
  assert.equal(key.readUInt32BE(2), 3);
  assert.equal(key[15], 1);
  assert.equal(encodeKey("nope"), null);
});

test("a masked websocket text frame decodes and a binary frame encodes", () => {
  const payload = Buffer.from("hi");
  const mask = Buffer.from([1, 2, 3, 4]);
  const frame = Buffer.alloc(2 + 4 + payload.length);
  frame[0] = 0x81;
  frame[1] = 0x80 | payload.length;
  mask.copy(frame, 2);
  for (let i = 0; i < payload.length; i++) frame[6 + i] = (payload[i] ?? 0) ^ (mask[i] ?? 0);
  const decoded = decodeFrames(frame);
  assert.equal(decoded.frames[0]?.text, true);
  assert.equal(decoded.frames[0]?.payload.toString(), "hi");
  const encoded = encodeFrame(Buffer.from([1, 2, 3]), 0x02);
  assert.equal(encoded[0], 0x82);
  assert.equal(encoded[1], 3);
  assert.deepEqual([...encoded.subarray(2)], [1, 2, 3]);
});
