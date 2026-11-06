import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createChatRecords, type ChatRecord } from "./chatRecords.ts";

function record(harnessId: string): ChatRecord {
  return { stretches: [{ provider: "claude", harnessId, model: "Opus", modelId: "opus", items: [], start: null }], start: null, skip: 0, pending: "handoff", handoffs: {} };
}

test("a host sees the switches another host on the same home writes, and the earlier sessions they name", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "x-bench-chats-"));
  try {
    const app = createChatRecords(dir);
    const dev = createChatRecords(dir);
    assert.equal(app.get("chat"), null);
    assert.equal(app.chatOf("claude-1"), null);
    dev.save("chat", record("claude-1"));
    assert.equal(app.get("chat")?.pending, "handoff");
    assert.equal(app.chatOf("claude-1"), "chat");
    dev.drop("chat");
    assert.equal(app.get("chat"), null);
    assert.equal(app.chatOf("claude-1"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a save right after another host's write keeps the record just saved", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "x-bench-chats-"));
  try {
    const app = createChatRecords(dir);
    const dev = createChatRecords(dir);
    app.save("chat", { ...record("claude-1"), pending: "first" });
    dev.save("other", record("grok-1"));
    app.save("chat", { ...record("claude-1"), pending: "second" });
    assert.equal(app.get("chat")?.pending, "second");
    assert.equal(app.chatOf("grok-1"), "other");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a record the disk refuses is reported and not kept", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "x-bench-chats-"));
  try {
    writeFileSync(path.join(dir, "chat.json"), "{ broken");
    const store = createChatRecords(dir);
    assert.equal(store.get("chat"), null);
    assert.equal(store.save("chat", record("claude-1")), false);
    assert.equal(store.get("chat"), null);
    assert.equal(store.chatOf("claude-1"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
