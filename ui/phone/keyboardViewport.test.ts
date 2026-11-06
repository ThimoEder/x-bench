import { test } from "node:test";
import assert from "node:assert/strict";
import { keyboardUp } from "./keyboardViewport.ts";

test("the keyboard is up once the visible height drops well under the full height", () => {
  assert.equal(keyboardUp(874, 874), false);
  assert.equal(keyboardUp(850, 874), false);
  assert.equal(keyboardUp(815, 874), true);
  assert.equal(keyboardUp(500, 874), true);
});
