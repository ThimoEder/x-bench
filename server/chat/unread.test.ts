import assert from "node:assert/strict";
import test from "node:test";
import { sameMarks, updateUnread } from "./unread.ts";

test("a finished background chat stays unread until it is opened", () => {
  const unread = updateUnread([], { id: "a", wasRunning: true, status: "idle", open: false, pending: false });
  assert.deepEqual(unread, ["a"]);
  assert.deepEqual(
    updateUnread(unread, { id: "a", wasRunning: false, status: "idle", open: true, pending: false }),
    [],
  );
});

test("a chat you are looking at does not turn unread when it finishes", () => {
  assert.deepEqual(
    updateUnread(["b"], { id: "a", wasRunning: true, status: "idle", open: true, pending: false }),
    ["b"],
  );
});

test("a running or waiting chat is not marked unread", () => {
  assert.deepEqual(
    updateUnread(["a"], { id: "a", wasRunning: true, status: "running", open: false, pending: false }),
    [],
  );
  assert.deepEqual(
    updateUnread([], { id: "a", wasRunning: true, status: "idle", open: false, pending: true }),
    [],
  );
});

test("activity marks match only when every list is unchanged", () => {
  const marks = { working: ["a"], attention: [], unread: ["b"] };
  assert.equal(sameMarks({ open: [], ...marks }, { working: ["a"], attention: [], unread: ["b"] }), true);
  assert.equal(sameMarks(marks, { ...marks, working: [] }), false);
  assert.equal(sameMarks(marks, { ...marks, unread: ["b", "c"] }), false);
  assert.equal(sameMarks({}, { working: [], attention: [], unread: [] }), true);
  assert.equal(sameMarks({ needsYou: [] }, { needsYou: [{ key: "s1:question:1" }] as never }), false);
});
