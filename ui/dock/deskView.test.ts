import assert from "node:assert/strict";
import test from "node:test";
import { deskWithOpening, loadingSession, requestSessionId, sessionsForDesk, slotOf, staleSessionFailure, withFirstMessage } from "./deskView.ts";

test("a new thread stays on the desk until the open list includes it", () => {
  const previous = [{ id: "old", title: "Old chat" }];
  const created = { id: "new", title: "New session" };
  assert.deepEqual(sessionsForDesk(previous, created).map((session) => session.id), ["new"]);
  assert.deepEqual(sessionsForDesk([{ id: "new", title: "New session" }, { id: "old", title: "Old chat" }], created).map((session) => session.id), ["new", "old"]);
  assert.deepEqual(sessionsForDesk(previous, null).map((session) => session.id), ["old"]);
});

test("a request that named a session the server no longer holds is stale", () => {
  assert.equal(staleSessionFailure("No session is open", "old"), true);
  assert.equal(staleSessionFailure("No session is open", ""), false);
  assert.equal(staleSessionFailure("Folder does not exist", "old"), false);
});

test("a request names its session in the body or the query", () => {
  assert.equal(requestSessionId("/api/send", { sessionId: "s1" }), "s1");
  assert.equal(requestSessionId("/api/file?sessionId=s2&path=a.png", undefined), "s2");
  assert.equal(requestSessionId("/api/events", {}), "");
});

test("the first message shows at once and leaves when the session has its own", () => {
  const first = { sessionId: "s1", text: "Build the thing", attachments: [] };
  const empty = { id: "s1", status: "idle" as const, transcript: [] as { type: string; text?: string }[] };
  const shown = withFirstMessage(empty, first);
  assert.equal(shown.status, "running");
  assert.deepEqual(shown.transcript.map((item) => item.type), ["user"]);
  const echoed = { ...empty, transcript: [{ type: "user", text: "Build the thing" }] };
  assert.equal(withFirstMessage(echoed, first), echoed);
  assert.equal(withFirstMessage({ ...empty, id: "s2" }, first).transcript.length, 0);
  assert.equal(withFirstMessage(empty, null), empty);
});

test("a chat being opened takes its slot until the host's desk lists it", () => {
  const a = { id: "a" };
  const b = { id: "b" };
  const next = { id: "next" };
  assert.deepEqual(deskWithOpening([a, b], { session: next, place: "replace" }).map((session) => session.id), ["next"]);
  assert.deepEqual(deskWithOpening([a], { session: next, place: "beside" }).map((session) => session.id), ["a", "next"]);
  assert.deepEqual(deskWithOpening([a, b], { session: next, place: { replaceId: "b" } }).map((session) => session.id), ["a", "next"]);
  assert.deepEqual(deskWithOpening([a], { session: next, place: { replaceId: "gone" } }).map((session) => session.id), ["next"]);
  const listed = [a, { id: "next", title: "From the host" }];
  assert.equal(deskWithOpening(listed, { session: next, place: "replace" }), listed);
  assert.deepEqual(deskWithOpening([a], null), [a]);
});

test("a loading chat takes its title and provider from its sidebar row, and its transcript from a stored copy", () => {
  const row = { id: "s1", cwd: "/repo", title: "Fix the build", provider: "claude" };
  const empty = loadingSession(row);
  assert.equal(empty.loading, true);
  assert.equal(empty.title, "Fix the build");
  assert.equal(empty.provider, "claude");
  assert.deepEqual(empty.transcript, []);
  const stored = { ...empty, title: null, provider: "grok", transcript: [{ id: "u1", type: "user" as const, text: "Hello", streaming: false }] };
  const shown = loadingSession(row, stored);
  assert.equal(shown.loading, true);
  assert.equal(shown.title, "Fix the build");
  assert.equal(shown.provider, "grok");
  assert.equal(shown.transcript.length, 1);
});

test("a chat dropped on a pane still loading takes the slot that pane was going to take", () => {
  const loading = { session: { id: "a" }, place: { replaceId: "y" } };
  assert.deepEqual(slotOf("a", loading), { replaceId: "y" });
  assert.equal(slotOf("a", { session: { id: "a" }, place: "beside" as const }), "beside");
  assert.deepEqual(slotOf("x", loading), { replaceId: "x" });
  assert.deepEqual(slotOf("x", null), { replaceId: "x" });
});
