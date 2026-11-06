import assert from "node:assert/strict";
import test from "node:test";
import type { StretchStart } from "../../../server/chat/chatRecords.ts";
import { installDom } from "../../testing/dom.ts";

installDom();
const { wrinkleNote } = await import("./Wrinkle.tsx");

const start: StretchStart = { fromProvider: "claude", fromModel: "Opus", tokens: 3200, resumed: false, summarized: false, cut: false };

test("the note says what the new model read and why it was less than the whole chat", () => {
  assert.equal(wrinkleNote(start, "Grok"), "Grok reads 3.2k tokens of this chat");
  assert.equal(wrinkleNote({ ...start, summarized: true }, "Grok"), "Grok reads a summary of this chat");
  assert.equal(wrinkleNote({ ...start, cut: true }, "Grok"), "Grok reads 3.2k tokens of this chat, oldest entries left out");
  assert.equal(wrinkleNote({ ...start, summaryFailed: true }, "Grok", "Claude"), "Grok reads 3.2k tokens of this chat, since Claude could not summarize");
  assert.equal(wrinkleNote({ ...start, resumed: true }, "Grok"), "Grok picked up its session and reads 3.2k tokens it missed");
  assert.equal(wrinkleNote({ ...start, resumed: true, tokens: 0 }, "Grok"), "Grok picked up its session");
});
