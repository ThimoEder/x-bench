import assert from "node:assert/strict";
import test from "node:test";
import { LIST_RATIO_DEFAULT, clampRatio, listRatioFrom, storedListRatio } from "./dockSplit.ts";

const storageWith = (value: string | null) => ({ getItem: () => value });

test("a missing key opens the list at its default height", () => {
  assert.equal(storedListRatio(storageWith(null)), LIST_RATIO_DEFAULT);
  assert.equal(listRatioFrom(undefined), LIST_RATIO_DEFAULT);
});

test("an empty value opens the list at its default height", () => {
  assert.equal(storedListRatio(storageWith("")), LIST_RATIO_DEFAULT);
  assert.equal(listRatioFrom("  "), LIST_RATIO_DEFAULT);
});

test("a stored height is used as is", () => {
  assert.equal(storedListRatio(storageWith("0.5")), 0.5);
});

test("an out-of-range height is clamped", () => {
  assert.equal(storedListRatio(storageWith("0")), clampRatio(0));
  assert.equal(storedListRatio(storageWith("0")), 0.12);
  assert.equal(storedListRatio(storageWith("5")), 0.72);
});

test("junk or a blocked store falls back to the default", () => {
  assert.equal(storedListRatio(storageWith("abc")), LIST_RATIO_DEFAULT);
  assert.equal(storedListRatio({ getItem() { throw new Error("blocked"); } }), LIST_RATIO_DEFAULT);
  assert.equal(storedListRatio(undefined), LIST_RATIO_DEFAULT);
});
