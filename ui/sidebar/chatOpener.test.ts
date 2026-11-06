import assert from "node:assert/strict";
import test from "node:test";
import { chatOpener, type LoadingSession } from "./chatOpener.ts";
import { loadingSession, type Opening } from "../dock/deskView.ts";

// A host whose answers the test hands out, one request at a time.
function fakeHost() {
  const pending: { path: string; body: Record<string, unknown>; resolve: (value: unknown) => void; reject: (error: Error) => void }[] = [];
  const shown: (Opening<LoadingSession> | null)[] = [];
  const stored: string[] = [];
  const failures: string[] = [];
  const opener = chatOpener({
    call: (path, body) => {
      const { promise, resolve, reject } = Promise.withResolvers<unknown>();
      pending.push({ path, body: body as Record<string, unknown>, resolve, reject });
      return promise;
    },
    show: (opening) => shown.push(opening),
    showStored: (sessionId) => stored.push(sessionId),
    fail: (message) => failures.push(message),
  });
  const request = (path: string, sessionId: string) => {
    const found = pending.find((item) => item.path === path && item.body.sessionId === sessionId);
    assert.ok(found, `no ${path} for ${sessionId}`);
    return found;
  };
  return { opener, pending, shown, stored, failures, request };
}

function settle() {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

const storedCopy = (id: string) => ({ session: { ...loadingSession({ id, cwd: "/repo" }), transcript: [{ id: "u1", type: "user", text: "Hi", streaming: false }] } });

test("opening a chat shows it at once, asks for its stored copy and loads it in its slot", async () => {
  const host = fakeHost();
  host.opener.open({ id: "a", cwd: "/repo", title: "Chat A" }, "/repo", { replaceId: "old" });
  assert.equal(host.shown.at(-1)?.session.id, "a");
  assert.equal(host.shown.at(-1)?.session.title, "Chat A");
  assert.deepEqual(host.shown.at(-1)?.place, { replaceId: "old" });
  assert.deepEqual(host.request("/api/load", "a").body, { sessionId: "a", cwd: "/repo", replaceId: "old" });
  host.request("/api/preview", "a").resolve(storedCopy("a"));
  await settle();
  assert.deepEqual(host.stored, ["a"]);
});

test("a failed load takes the chat down and reports the error", async () => {
  const host = fakeHost();
  host.opener.open({ id: "a", cwd: "/repo" }, "/repo");
  host.request("/api/load", "a").reject(new Error("Session did not load"));
  await settle();
  assert.equal(host.shown.at(-1), null);
  assert.deepEqual(host.failures, ["Session did not load"]);
});

test("clicking two chats quickly ends on the second: the first one's answers change nothing", async () => {
  const host = fakeHost();
  host.opener.open({ id: "a", cwd: "/repo" }, "/repo");
  host.opener.open({ id: "b", cwd: "/repo" }, "/repo");
  assert.equal(host.shown.at(-1)?.session.id, "b");
  host.request("/api/preview", "a").resolve(storedCopy("a"));
  host.request("/api/load", "a").reject(new Error("Session did not load"));
  await settle();
  assert.equal(host.shown.at(-1)?.session.id, "b");
  assert.deepEqual(host.stored, []);
  assert.deepEqual(host.failures, []);
});

test("leaving for another view takes the chat down and drops its late answers", async () => {
  const host = fakeHost();
  host.opener.open({ id: "a", cwd: "/repo" }, "/repo");
  host.opener.cancel();
  assert.equal(host.shown.at(-1), null);
  host.request("/api/load", "a").reject(new Error("Session did not load"));
  await settle();
  assert.deepEqual(host.failures, []);
});

test("a load another page overtook takes the chat down without an error", async () => {
  const host = fakeHost();
  host.opener.open({ id: "a", cwd: "/repo" }, "/repo");
  host.request("/api/load", "a").resolve({ open: [], overtaken: true });
  await settle();
  assert.equal(host.shown.at(-1), null);
  assert.deepEqual(host.failures, []);
});

test("a claimed turn ends with the next open or a cancel", () => {
  const host = fakeHost();
  const first = host.opener.claim();
  assert.equal(first(), true);
  host.opener.open({ id: "a", cwd: "/repo" }, "/repo");
  assert.equal(first(), false);
  const second = host.opener.claim();
  host.opener.cancel();
  assert.equal(second(), false);
});
