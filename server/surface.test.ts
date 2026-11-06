import assert from "node:assert/strict";
import test from "node:test";
import { createDesk } from "./desk.ts";
import { createSurfaces } from "./surface.ts";

test("switching to chat parks both builder panes and shows the saved chat", () => {
  const desk = createDesk();
  const surfaces = createSurfaces(desk);
  desk.replace("a");
  desk.add("b");
  surfaces.show("chat");
  assert.equal(surfaces.surface(), "chat");
  assert.deepEqual(desk.ids(), []);
  assert.deepEqual(surfaces.parked("builder"), ["a", "b"]);
  desk.replace("c");
  surfaces.show("builder");
  assert.deepEqual(desk.ids(), ["a", "b"]);
  assert.deepEqual(surfaces.parked("chat"), ["c"]);
  surfaces.show("chat");
  assert.deepEqual(desk.ids(), ["c"]);
  assert.deepEqual(surfaces.parked("builder"), ["a", "b"]);
});

test("replacing the chat pane leaves the parked builder panes in place", () => {
  const desk = createDesk();
  const surfaces = createSurfaces(desk);
  desk.replace("a");
  desk.add("b");
  surfaces.show("chat");
  desk.replace("c");
  desk.replace("d");
  assert.deepEqual(surfaces.parked("builder"), ["a", "b"]);
  surfaces.show("builder");
  assert.deepEqual(desk.ids(), ["a", "b"]);
});

test("a builder desk still refuses a third pane", () => {
  const desk = createDesk();
  const surfaces = createSurfaces(desk);
  assert.equal(surfaces.surface(), "builder");
  assert.equal(surfaces.allowsBeside(), true);
  desk.replace("a");
  assert.equal(desk.add("b").ok, true);
  assert.equal(desk.add("c").ok, false);
  assert.deepEqual(desk.ids(), ["a", "b"]);
  surfaces.show("chat");
  assert.equal(surfaces.allowsBeside(), false);
});

test("a session that left the bridge is not restored", () => {
  const alive = new Set(["a"]);
  const desk = createDesk();
  const surfaces = createSurfaces(desk, { alive: (id) => alive.has(id) });
  desk.replace("a");
  desk.add("b");
  surfaces.show("chat");
  surfaces.show("builder");
  assert.deepEqual(desk.ids(), ["a"]);
});

test("dropping a session removes it from the parked list too", () => {
  const desk = createDesk();
  const surfaces = createSurfaces(desk);
  desk.replace("a");
  desk.add("b");
  surfaces.show("chat");
  surfaces.drop("a");
  surfaces.show("builder");
  assert.deepEqual(desk.ids(), ["b"]);
});
