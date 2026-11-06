import assert from "node:assert/strict";
import test from "node:test";
import { zoomAt, wheelPixels } from "./imageZoom.ts";

test("wheel zoom grows toward the pointer and stops at the original size", () => {
  const closer = zoomAt({ scale: 1, x: 0, y: 0 }, 40, -20, -100);
  assert.ok(closer.scale > 1);
  assert.notEqual(closer.x, 0);
  const back = zoomAt(closer, 40, -20, 5000);
  assert.equal(back.scale, 1);
  assert.equal(back.x, 0);
  assert.equal(back.y, 0);
});

test("wheel zoom does not pass the closest or farthest stop", () => {
  const far = zoomAt({ scale: 8, x: 1, y: 1 }, 0, 0, -100);
  assert.equal(far.scale, 8);
  const near = zoomAt({ scale: 1, x: 3, y: 4 }, 10, 10, 100);
  assert.deepEqual(near, { scale: 1, x: 3, y: 4 });
});

test("line and page wheel modes become pixels", () => {
  assert.equal(wheelPixels({ deltaY: 2, deltaMode: 1 }), 32);
  assert.equal(wheelPixels({ deltaY: 1, deltaMode: 2 }), 400);
});
