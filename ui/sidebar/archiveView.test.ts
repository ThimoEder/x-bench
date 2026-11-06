import assert from "node:assert/strict";
import test from "node:test";
import { persistShowArchived, readShowArchived, visibleSessions } from "./archiveView.ts";

test("show archived is off unless the key is 1", () => {
  assert.equal(readShowArchived({ getItem: () => null }), false);
  assert.equal(readShowArchived({ getItem: () => "0" }), false);
  assert.equal(readShowArchived({ getItem: () => "1" }), true);
  assert.equal(readShowArchived({ getItem() { throw new Error("blocked"); } }), false);
});

test("persisting writes or removes the key", () => {
  const saved = new Map<string, string>();
  const storage = {
    setItem: (key: string, value: string) => saved.set(key, value),
    removeItem: (key: string) => saved.delete(key),
  };
  assert.equal(persistShowArchived(true, storage), true);
  assert.equal(saved.get("x-bench-show-archived"), "1");
  assert.equal(persistShowArchived(false, storage), false);
  assert.equal(saved.has("x-bench-show-archived"), false);
  assert.equal(persistShowArchived(true, { setItem() { throw new Error("blocked"); }, removeItem() {} }), true);
});

test("visible sessions hide archived rows until asked", () => {
  const sessions = [{ id: "a" }, { id: "b", archived: true }];
  assert.deepEqual(visibleSessions(sessions, false).map((session) => session.id), ["a"]);
  assert.deepEqual(visibleSessions(sessions, true).map((session) => session.id), ["a", "b"]);
  assert.deepEqual(visibleSessions(null, true), []);
});
