import assert from "node:assert/strict";
import test from "node:test";
import { createDesk } from "./desk.ts";

test("a desk keeps the first session and adds one beside it", () => {
  const desk = createDesk();
  desk.replace("a");
  assert.equal(desk.add("b").ok, true);
  assert.deepEqual(desk.ids(), ["a", "b"]);
  assert.equal(desk.add("c").ok, false);
  assert.deepEqual(desk.ids(), ["a", "b"]);
});

test("closing one session leaves the other open", () => {
  const desk = createDesk();
  desk.replace("a");
  desk.add("b");
  desk.remove("a");
  assert.deepEqual(desk.ids(), ["b"]);
  assert.equal(desk.add("a").already, false);
  assert.equal(desk.add("b").already, true);
  desk.clear();
  assert.deepEqual(desk.ids(), []);
});

test("dropping a session replaces the pane it lands on", () => {
  const desk = createDesk();
  desk.replace("a");
  desk.add("b");
  desk.replaceSlot("b", "c");
  assert.deepEqual(desk.ids(), ["a", "c"]);
  assert.equal(desk.replaceSlot("a", "c").already, true);
});

test("a newer claim on the desk overtakes an older one", () => {
  const desk = createDesk();
  const first = desk.claim();
  assert.equal(first(), true);
  const second = desk.claim();
  assert.equal(first(), false);
  assert.equal(second(), true);
});
