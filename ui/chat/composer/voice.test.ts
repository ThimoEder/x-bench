import assert from "node:assert/strict";
import test from "node:test";
import { downsample, encodeWav, foreignField, insertAtCursor, mergeFloats, voiceKey, type VoiceKeyEvent } from "./voice.ts";

const down = (key: string, extra: Partial<VoiceKeyEvent> = {}): VoiceKeyEvent => ({ type: "keydown", key, repeat: false, ctrlKey: false, metaKey: false, shiftKey: false, ...extra });
const up = (key: string, extra: Partial<VoiceKeyEvent> = {}): VoiceKeyEvent => ({ type: "keyup", key, repeat: false, ctrlKey: false, metaKey: false, shiftKey: false, ...extra });

test("insert adds a leading space only when the cursor is mid-word", () => {
  assert.deepEqual(insertAtCursor("", 0, " hello "), { draft: "hello", cursor: 5 });
  assert.deepEqual(insertAtCursor("fix", 3, "the bug"), { draft: "fix the bug", cursor: 11 });
  assert.deepEqual(insertAtCursor("fix ", 4, "the bug"), { draft: "fix the bug", cursor: 11 });
  assert.deepEqual(insertAtCursor("say hello", 3, "now"), { draft: "say now hello", cursor: 7 });
  assert.deepEqual(insertAtCursor("keep", 4, "   "), { draft: "keep", cursor: 4 });
});

test("wav header describes 16-bit mono pcm", () => {
  const samples = new Float32Array([0, 0.5, -0.5]);
  const view = new DataView(encodeWav(samples, 16000));
  assert.equal(view.byteLength, 44 + 6);
  assert.equal(ascii(view, 0, 4), "RIFF");
  assert.equal(ascii(view, 8, 12), "WAVE");
  assert.equal(ascii(view, 36, 40), "data");
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getInt16(44, true), 0);
  assert.ok(view.getInt16(46, true) > 16000);
  assert.ok(view.getInt16(48, true) < -16000);
});

test("downsample keeps one sample per output step", () => {
  const merged = mergeFloats([new Float32Array([0, 1]), new Float32Array([2, 3])]);
  assert.deepEqual([...downsample(merged, 32000, 16000)], [0, 2]);
});

test("alt hold starts, stops, and discards a tap", () => {
  assert.equal(voiceKey(down("Alt"), { recording: false }), "start");
  assert.equal(voiceKey(up("Alt"), { recording: true, via: "hold", heldMs: 400 }), "stop");
  assert.equal(voiceKey(up("Alt"), { recording: true, via: "hold", heldMs: 80 }), "discard");
});

test("releasing alt stops a hold take wherever the focus went", () => {
  assert.equal(voiceKey(up("Alt"), { recording: true, via: "hold", heldMs: 400, foreignField: true }), "stop");
  assert.equal(voiceKey(up("Alt", { shiftKey: true }), { recording: true, via: "hold", heldMs: 400 }), "stop");
});

test("a chord aborts and a modified alt is ignored", () => {
  assert.equal(voiceKey(down("a"), { recording: true, via: "hold" }), "abort");
  assert.equal(voiceKey(down("Alt", { shiftKey: true }), { recording: false }), "ignore");
  assert.equal(voiceKey(down("Alt", { repeat: true }), { recording: false }), "ignore");
  assert.equal(voiceKey(down("Alt"), { recording: false, foreignField: true }), "ignore");
  assert.equal(voiceKey(down("Alt"), { recording: false, busy: true }), "ignore");
});

test("alt leaves a button take alone and escape cancels", () => {
  assert.equal(voiceKey(down("Alt"), { recording: true, via: "button" }), "ignore");
  assert.equal(voiceKey(up("Alt"), { recording: true, via: "button", heldMs: 900 }), "ignore");
  assert.equal(voiceKey(down("Escape"), { recording: true, via: "button" }), "cancel");
  assert.equal(voiceKey(down("Escape"), { recording: false }), "ignore");
});

test("another text field is foreign, the composer is not", () => {
  const composer = { tagName: "TEXTAREA" };
  assert.equal(foreignField({ tagName: "INPUT" }, composer), true);
  assert.equal(foreignField({ tagName: "DIV", isContentEditable: true }, composer), true);
  assert.equal(foreignField(composer, composer), false);
  assert.equal(foreignField({ tagName: "BUTTON" }, composer), false);
});

function ascii(view: DataView, start: number, end: number) {
  let text = "";
  for (let i = start; i < end; i++) text += String.fromCharCode(view.getUint8(i));
  return text;
}
