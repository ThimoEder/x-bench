import assert from "node:assert/strict";
import test from "node:test";
import { DOCK_CHATS_KEY, dockMemory, dockPlaceFrom } from "./dockMemory.ts";

function fakeStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  let writes = 0;
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      writes += 1;
      items.set(key, value);
    },
    get writes() {
      return writes;
    },
    raw: () => items.get(DOCK_CHATS_KEY),
  };
}

test("each chat keeps its own place, merged field by field", () => {
  const memory = dockMemory(fakeStorage());
  memory.save("a", { open: true, tab: "browser" });
  memory.save("b", { open: false, tab: "files", file: "src/app.ts" });
  memory.save("a", { scope: "main" });
  assert.deepEqual(memory.get("a"), { open: true, tab: "browser", scope: "main" });
  assert.deepEqual(memory.get("b"), { open: false, tab: "files", file: "src/app.ts" });
  assert.equal(memory.get("c"), undefined);
});

test("a field saved as undefined or empty is cleared", () => {
  const memory = dockMemory(fakeStorage());
  memory.save("a", { tab: "files", file: "README.md", change: "x.ts" });
  memory.save("a", { file: undefined, change: "" });
  assert.deepEqual(memory.get("a"), { tab: "files" });
});

test("places survive a reload of the page", () => {
  const storage = fakeStorage();
  dockMemory(storage).save("a", { open: false, tab: "device", device: "emulator-5554" });
  assert.deepEqual(dockMemory(storage).get("a"), { open: false, tab: "device", device: "emulator-5554" });
  dockMemory(storage).save("b", { tab: "terminal", shell: "4f1c", terminal: true });
  assert.deepEqual(dockMemory(storage).get("b"), { tab: "terminal", shell: "4f1c", terminal: true });
  dockMemory(storage).save("c", { width: 1100, rest: 500 });
  assert.deepEqual(dockMemory(storage).get("c"), { width: 1100, rest: 500 });
});

test("an unchanged place is not written again", () => {
  const storage = fakeStorage();
  const memory = dockMemory(storage);
  memory.save("a", { tab: "changes" });
  memory.save("a", { tab: "changes" });
  assert.equal(storage.writes, 1);
});

test("the oldest places go past the limit, and a changed place counts as new", () => {
  const memory = dockMemory(fakeStorage(), 2);
  memory.save("a", { tab: "files" });
  memory.save("b", { tab: "files" });
  memory.save("a", { tab: "browser" });
  memory.save("c", { tab: "files" });
  assert.equal(memory.get("b"), undefined);
  assert.deepEqual(memory.get("a"), { tab: "browser" });
  assert.deepEqual(memory.get("c"), { tab: "files" });
});

test("a forgotten chat starts fresh", () => {
  const storage = fakeStorage();
  const memory = dockMemory(storage);
  memory.save("a", { tab: "browser" });
  memory.forget("a");
  assert.equal(memory.get("a"), undefined);
  assert.equal(dockMemory(storage).get("a"), undefined);
});

test("unreadable storage and bad fields are dropped", () => {
  assert.equal(dockMemory(fakeStorage({ [DOCK_CHATS_KEY]: "{not json" })).get("a"), undefined);
  const stored = JSON.stringify([["a", { tab: "nope", scope: "main", open: "yes", file: 3, width: "wide", rest: -1 }], ["", { tab: "files" }], "junk"]);
  const memory = dockMemory(fakeStorage({ [DOCK_CHATS_KEY]: stored }));
  assert.deepEqual(memory.get("a"), { scope: "main" });
  assert.equal(memory.get(""), undefined);
  assert.equal(dockPlaceFrom(null), undefined);
});

test("without storage the places still hold for the visit", () => {
  const memory = dockMemory(null);
  memory.save("a", { tab: "files" });
  assert.deepEqual(memory.get("a"), { tab: "files" });
});

test("a stored pane split keeps its surface and side, with its share held in range", () => {
  assert.deepEqual(dockPlaceFrom({ tab: "changes", split: { tab: "files", edge: "left", ratio: 0.95 } }), { tab: "changes", split: { tab: "files", edge: "left", ratio: 0.8 } });
  assert.deepEqual(dockPlaceFrom({ split: { tab: "files", edge: "top" } }), { split: { tab: "files", edge: "top", ratio: 0.5 } });
  assert.deepEqual(dockPlaceFrom({ split: { tab: "files", edge: "middle", ratio: 0.5 } }), {});
  assert.deepEqual(dockPlaceFrom({ split: { tab: "mail", edge: "top", ratio: 0.5 } }), {});
});

test("a change tells every subscriber, and a save that changes nothing tells none", () => {
  const memory = dockMemory(fakeStorage());
  let heard = 0;
  const stop = memory.subscribe(() => {
    heard += 1;
  });
  memory.save("a", { open: true });
  memory.save("a", { open: true });
  assert.equal(heard, 1);
  memory.forget("a");
  memory.forget("a");
  assert.equal(heard, 2);
  stop();
  memory.save("a", { open: false });
  assert.equal(heard, 2);
});
