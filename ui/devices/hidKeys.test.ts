import assert from "node:assert/strict";
import test from "node:test";
import { hidUsage } from "./hidKeys.ts";

test("physical keys map to their HID usages", () => {
  assert.equal(hidUsage("KeyA"), 4);
  assert.equal(hidUsage("KeyZ"), 29);
  assert.equal(hidUsage("Digit1"), 30);
  assert.equal(hidUsage("Digit9"), 38);
  assert.equal(hidUsage("Digit0"), 39);
  assert.equal(hidUsage("F1"), 58);
  assert.equal(hidUsage("F12"), 69);
  assert.equal(hidUsage("Enter"), 40);
  assert.equal(hidUsage("ArrowUp"), 82);
  assert.equal(hidUsage("ShiftLeft"), 225);
  assert.equal(hidUsage("MetaLeft"), undefined);
  assert.equal(hidUsage("F13"), undefined);
});
