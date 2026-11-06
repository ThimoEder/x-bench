import assert from "node:assert/strict";
import test from "node:test";
import { GLIDE_MS, followScroll, glideStart, glideTop, transcriptMark } from "./scroll.ts";

test("a message that arrives before the scroll event keeps the thread pinned", () => {
  const next = followScroll({ stick: true, lastTop: 1468 }, { pinning: false, scrollTop: 1468, gap: 217 });
  assert.equal(next.stick, true);
  assert.equal(next.lastTop, 1468);
});

test("scrolling up past the stick zone releases the bottom", () => {
  const next = followScroll({ stick: true, lastTop: 1468 }, { pinning: false, scrollTop: 1000, gap: 468 });
  assert.equal(next.stick, false);
  assert.equal(next.lastTop, 1000);
});

test("a small scroll up inside the stick zone stays pinned", () => {
  const next = followScroll({ stick: true, lastTop: 1468 }, { pinning: false, scrollTop: 1420, gap: 48 });
  assert.equal(next.stick, true);
});

test("scrolling back near the bottom pins again", () => {
  const next = followScroll({ stick: false, lastTop: 1000 }, { pinning: false, scrollTop: 1400, gap: 40 });
  assert.equal(next.stick, true);
});

test("the programmatic scroll does not release the bottom", () => {
  const next = followScroll({ stick: true, lastTop: 0 }, { pinning: true, scrollTop: 1468, gap: 217 });
  assert.equal(next.stick, true);
  assert.equal(next.lastTop, 1468);
});

test("subpixel jitter after new text does not release the bottom", () => {
  const next = followScroll({ stick: true, lastTop: 1468 }, { pinning: false, scrollTop: 1467.5, gap: 200 });
  assert.equal(next.stick, true);
});

test("the transcript mark moves when a reply grows or a tool finishes, and holds otherwise", () => {
  const reply = { id: "assistant-1", type: "assistant" as const, text: "Hi", streaming: true };
  const tool = { id: "tool:1", type: "tool" as const, toolCallId: "1", title: "", kind: "", status: "in_progress", rawInput: null, role: "other" as const, diffs: [], outputPreview: "" };
  const mark = transcriptMark([reply]);
  assert.equal(transcriptMark([{ ...reply }]), mark);
  assert.notEqual(transcriptMark([{ ...reply, text: "Hi there" }]), mark);
  assert.notEqual(transcriptMark([reply, tool]), mark);
  assert.notEqual(transcriptMark([reply, { ...tool, status: "completed" }]), transcriptMark([reply, tool]));
});

test("a glide back to the end starts at most one window above it", () => {
  assert.equal(glideStart(0, 70000, 700), 69300);
  assert.equal(glideStart(69800, 70000, 700), 69800);
});

test("a glide eases out and lands on the end, also when the end moved meanwhile", () => {
  assert.equal(glideTop(1000, 2000, 0), 1000);
  const half = glideTop(1000, 2000, GLIDE_MS / 2);
  assert.ok(half > 1500 && half < 2000);
  assert.equal(glideTop(1000, 2400, GLIDE_MS), 2400);
  assert.equal(glideTop(1000, 2400, GLIDE_MS * 3), 2400);
});
