import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSessionIndex, notePreset } from "./sessionIndex.ts";

test("a session's harness mode is kept when its other fields change, and an older file without it reads", () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), "x-bench-index-"));
  const file = path.join(folder, "sessions.json");
  try {
    writeFileSync(file, JSON.stringify({ sessions: [{ id: "old", provider: "claude", harnessId: "old", cwd: "/w", title: "Old", createdAt: "", updatedAt: "" }] }));
    const index = createSessionIndex(file);
    assert.equal(index.get("old")?.harnessMode, undefined);
    index.record({ id: "s1", provider: "chatgpt", harnessMode: "read-only" });
    index.record({ id: "s1", provider: "chatgpt", cwd: "/w", title: "Plan the docs" });
    index.record({ id: "c1", provider: "claude", harnessModel: "opus", harnessEffort: "high", harnessMode: "auto" });
    index.record({ id: "c1", provider: "claude", cwd: "/w", title: "The thread" });
    const again = createSessionIndex(file).get("s1");
    assert.equal(again?.harnessMode, "read-only");
    assert.equal(again?.title, "Plan the docs");
    const claude = createSessionIndex(file).get("c1");
    assert.equal(claude?.harnessModel, "opus");
    assert.equal(claude?.harnessEffort, "high");
    assert.equal(claude?.harnessMode, "auto");
    assert.equal(claude?.title, "The thread");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("a field a newer host wrote survives this host saving the file", () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), "x-bench-index-"));
  const file = path.join(folder, "sessions.json");
  try {
    writeFileSync(file, JSON.stringify({ sessions: [{ id: "c1", provider: "claude", harnessId: "c1", cwd: "/w", title: "", createdAt: "", updatedAt: "", harnessFuture: "kept" }] }));
    const index = createSessionIndex(file);
    index.record({ id: "c1", provider: "claude", title: "Renamed" });
    index.record({ id: "c2", provider: "claude" });
    const row = createSessionIndex(file).get("c1") as unknown as Record<string, unknown>;
    assert.equal(row.harnessFuture, "kept");
    assert.equal(row.title, "Renamed");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("a Codex preset saved while a chat still runs on another provider leaves its provider alone", () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), "x-bench-index-"));
  try {
    const index = createSessionIndex(path.join(folder, "sessions.json"));
    index.record({ id: "chat", provider: "grok", harnessId: "grok-1", cwd: "/w" });
    // Switching back to the chat's own ChatGPT session: its preset is set before the switch commits.
    notePreset(index, "chat", "read-only");
    assert.deepEqual([index.get("chat")?.provider, index.get("chat")?.harnessId, index.get("chat")?.harnessMode], ["grok", "grok-1", "read-only"]);
    // A new Codex session the index does not know yet is filed as its own ChatGPT row.
    notePreset(index, "codex-2", "agent");
    assert.equal(index.get("codex-2")?.provider, "chatgpt");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
