import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { CatalogEntry } from "../../bridge/protocol.ts";
import type { Provider } from "../../bridge/provider.ts";
import type { SessionState } from "../../bridge/reducer.ts";
import { chatIds, chatView } from "./chatIds.ts";
import { memoryChatRecords, type FrozenStretch } from "./chatRecords.ts";
import { createSessionIndex } from "./sessionIndex.ts";

function withIndex(run: (index: ReturnType<typeof createSessionIndex>) => void | Promise<void>) {
  const folder = mkdtempSync(path.join(os.tmpdir(), "x-bench-chat-ids-"));
  return Promise.resolve(run(createSessionIndex(path.join(folder, "sessions.json")))).finally(() => rmSync(folder, { recursive: true, force: true }));
}

function stretch(provider: string, harnessId: string): FrozenStretch {
  return { provider, harnessId, model: "", modelId: "", items: [], start: null };
}

function records(chatId: string, ...stretches: FrozenStretch[]) {
  const store = memoryChatRecords();
  store.save(chatId, { stretches, start: null, skip: 0, pending: null, handoffs: {} });
  return store;
}

function session(id: string): SessionState {
  return { id, transcript: [] } as unknown as SessionState;
}

// A harness that holds one session under its own id and records the ids it is called with.
function harness(id: string) {
  const calls: unknown[][] = [];
  const listeners: ((session: SessionState) => void)[] = [];
  const catalogListeners: ((entry: CatalogEntry) => void)[] = [];
  const provider = {
    id,
    catalog: new Map<string, CatalogEntry>([[id, { sessionId: id, title: "Live", cwd: "/w", isWorktree: false, sessionKind: null, updatedAt: null }]]),
    getSession: (sessionId: string) => (sessionId === id ? session(id) : null),
    sessions: () => [session(id)],
    activityMarks: () => ({ working: [id], attention: [] }),
    openTurns: () => [id],
    async prompt(sessionId: string, text: string) {
      calls.push(["prompt", sessionId, text]);
      return session(sessionId);
    },
    onSession(listener: (session: SessionState) => void) {
      listeners.push(listener);
      return () => {};
    },
    onCatalog(listener: (entry: CatalogEntry) => void) {
      catalogListeners.push(listener);
      return () => {};
    },
  };
  return { provider: provider as unknown as Provider, calls, emit: (state: SessionState) => listeners.forEach((listener) => listener(state)), name: (entry: CatalogEntry) => catalogListeners.forEach((listener) => listener(entry)) };
}

test("a switched chat keeps its id: calls reach the live harness session, and what comes back names the chat", () =>
  withIndex(async (index) => {
    index.record({ id: "chat", provider: "grok", harnessId: "live", cwd: "/w" });
    const { provider, calls, emit, name } = harness("live");
    const view = chatView(provider, chatIds(index, records("chat", stretch("claude", "chat"))));

    assert.equal(view.getSession("chat")?.id, "chat");
    assert.equal((await view.prompt("chat", "hello"))?.id, "chat");
    assert.deepEqual(calls, [["prompt", "live", "hello"]]);
    assert.deepEqual(view.sessions().map((item) => item.id), ["chat"]);
    assert.deepEqual(view.activityMarks().working, ["chat"]);
    assert.deepEqual(view.openTurns?.(), ["chat"]);
    assert.equal(view.catalog.get("chat")?.sessionId, "chat");
    assert.equal(view.catalog.has("live"), false);

    const seen: string[] = [];
    view.onSession((state) => seen.push(state.id));
    view.onCatalog((entry) => seen.push(entry.sessionId ?? ""));
    emit(session("live"));
    name({ sessionId: "live", title: "Renamed", cwd: "/w", isWorktree: false, sessionKind: null, updatedAt: null });
    assert.deepEqual(seen, ["chat", "chat"]);
  }));

test("a session the index does not know keeps its own id", () =>
  withIndex(async (index) => {
    const { provider, calls } = harness("solo");
    const view = chatView(provider, chatIds(index, memoryChatRecords()));
    await view.prompt("solo", "hi");
    assert.deepEqual(calls, [["prompt", "solo", "hi"]]);
    assert.equal(view.getSession("solo")?.id, "solo");
  }));

test("an earlier stretch's harness session still belongs to its chat, and the live one wins", () =>
  withIndex((index) => {
    index.record({ id: "chat", provider: "claude", harnessId: "chat", cwd: "/w" });
    index.record({ id: "other", provider: "grok", harnessId: "other", cwd: "/w" });
    const ids = chatIds(index, records("chat", stretch("claude", "chat"), stretch("grok", "grok-1")));
    assert.equal(ids.toApp("grok-1"), "chat");
    assert.equal(ids.toApp("chat"), "chat");
    assert.equal(ids.toApp("other"), "other");
    assert.equal(ids.toApp("nobody"), "nobody");
    assert.equal(ids.toHarness("chat"), "chat");
  }));

test("a row filed under a live session's own id does not take the session from its chat", () =>
  withIndex((index) => {
    index.record({ id: "chat", provider: "grok", harnessId: "grok-1", cwd: "/w" });
    index.record({ id: "grok-1", provider: "grok", harnessId: "grok-1", cwd: "/w" });
    assert.equal(chatIds(index, memoryChatRecords()).toApp("grok-1"), "chat");
  }));

test("a row filed under an earlier session's own id does not take the session from its chat", () =>
  withIndex((index) => {
    index.record({ id: "chat", provider: "claude", harnessId: "chat", cwd: "/w" });
    index.record({ id: "grok-1", provider: "grok", harnessId: "grok-1", cwd: "/w" });
    assert.equal(chatIds(index, records("chat", stretch("claude", "chat"), stretch("grok", "grok-1"))).toApp("grok-1"), "chat");
  }));

test("a switched chat's harness sessions are listed with the one it runs on now first", () =>
  withIndex((index) => {
    index.record({ id: "chat", provider: "grok", harnessId: "grok-2", cwd: "/w" });
    const ids = chatIds(index, records("chat", stretch("claude", "chat"), stretch("grok", "grok-1")));
    assert.deepEqual(ids.harnesses("chat"), ["grok-2", "grok-1", "chat"]);
    assert.deepEqual(ids.harnesses("solo"), ["solo"]);
  }));
