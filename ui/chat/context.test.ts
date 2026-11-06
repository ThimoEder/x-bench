import assert from "node:assert/strict";
import test from "node:test";
import { contextIsFull, contextLabel, formatContext } from "./context.ts";

test("context reads as thousands over the model window", () => {
  assert.equal(formatContext(0, 500000), "0 / 500k");
  assert.equal(formatContext(19840, 500000), "20k / 500k");
  assert.equal(formatContext(1500, 500000), "1.5k / 500k");
  assert.equal(formatContext(119796, 500000), "120k / 500k");
  assert.equal(formatContext(119796, 0), null);
  assert.equal(contextLabel(119796, 500000), "119,796 of 500,000 context tokens");
});

test("the count is full at the model's compact point", () => {
  assert.equal(contextIsFull({ used: 399999, size: 500000, compactAt: 80 }), false);
  assert.equal(contextIsFull({ used: 400000, size: 500000, compactAt: 80 }), true);
  assert.equal(contextIsFull({ used: 160000, size: 200000, compactAt: 90 }), false);
  assert.equal(contextIsFull({ used: 180000, size: 200000, compactAt: 90 }), true);
  assert.equal(contextIsFull({ used: 400000, size: 500000 }), true);
  assert.equal(contextLabel(400000, 500000, true), "400,000 of 500,000 context tokens, at the compact limit");
});
