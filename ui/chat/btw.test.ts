import assert from "node:assert/strict";
import test from "node:test";
import { clampBtwPlace, defaultBtwPlace, mergeBtwEntries, readBtwPlace } from "./btw.ts";

test("a side window stays on screen", () => {
  const viewport = { width: 1200, height: 800 };
  assert.deepEqual(clampBtwPlace({ x: -40, y: 900, width: 900, height: 900 }, viewport), {
    x: 8,
    y: 8,
    width: 900,
    height: 784,
  });
  const place = defaultBtwPlace(viewport);
  assert.equal(place.x + place.width <= viewport.width - 8, true);
  assert.equal(place.y + place.height <= viewport.height - 8, true);
  assert.deepEqual(readBtwPlace("not json", viewport), defaultBtwPlace(viewport));
});

test("saved side questions stay, and a question still in flight is kept", () => {
  const saved = [{ id: "btw-1", question: "earlier", answer: "yes" }];
  const local = [
    { id: "btw-1", question: "earlier", answer: "yes" },
    { id: "local-2", question: "now", answer: "bridge.js" },
    { id: "local-3", question: "next", answer: "", pending: true },
  ];
  assert.deepEqual(mergeBtwEntries(saved, local), [
    saved[0],
    { id: "local-2", question: "now", answer: "bridge.js" },
    local[2],
  ]);
});
