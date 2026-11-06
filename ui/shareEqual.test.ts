import assert from "node:assert/strict";
import test from "node:test";
import { shareEqual } from "./shareEqual.ts";

function snapshot(reply: string) {
  return JSON.parse(JSON.stringify({
    error: null,
    working: ["s1"],
    open: [
      {
        id: "s1",
        status: "running",
        transcript: [
          { id: "u1", type: "user", text: "hi" },
          { id: "t1", type: "tool", diffs: [{ path: "a.txt", oldText: "one\n", newText: "two\n" }] },
          { id: "a1", type: "assistant", text: reply, streaming: true },
        ],
      },
    ],
    projects: [{ cwd: "/repo", sessions: [{ id: "s1", title: "Fix it" }] }],
  }));
}

test("a new chunk keeps every unchanged part of the last snapshot", () => {
  const previous = snapshot("Hello");
  const next = shareEqual(previous, snapshot("Hello there"));
  assert.notEqual(next, previous);
  assert.equal(next.projects, previous.projects);
  assert.equal(next.working, previous.working);
  const [user, tool, reply] = next.open[0].transcript;
  assert.equal(user, previous.open[0].transcript[0]);
  assert.equal(tool, previous.open[0].transcript[1]);
  assert.notEqual(reply, previous.open[0].transcript[2]);
  assert.equal(reply.text, "Hello there");
  assert.notEqual(next.open[0], previous.open[0]);
});

test("an equal snapshot comes back as the last one, and changes of every kind come through", () => {
  const previous = snapshot("Hello");
  assert.equal(shareEqual(previous, snapshot("Hello")), previous);

  const grown = snapshot("Hello");
  grown.open[0].transcript.push({ id: "a2", type: "assistant", text: "More" });
  grown.error = "Grok stopped";
  delete grown.working;
  grown.projects[0].sessions[0].archived = true;
  const next = shareEqual(previous, grown);
  assert.deepEqual(next, grown);
  assert.equal(next.open[0].transcript[0], previous.open[0].transcript[0]);
  assert.notEqual(next.projects, previous.projects);

  const shorter = snapshot("Hello");
  shorter.open[0].transcript.pop();
  assert.deepEqual(shareEqual(previous, shorter), shorter);
  assert.equal(shareEqual(previous, shorter).open[0].transcript[1], previous.open[0].transcript[1]);
});

test("a first snapshot or a changed shape is taken as it is", () => {
  const next = snapshot("Hello");
  assert.equal(shareEqual(null, next), next);
  assert.deepEqual(shareEqual({ open: {} }, next), next);
  assert.deepEqual(shareEqual(next, { ...next, open: null }), { ...next, open: null });
});
