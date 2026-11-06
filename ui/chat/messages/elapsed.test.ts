import assert from "node:assert/strict";
import test from "node:test";
import { formatElapsed } from "./elapsed.ts";

test("elapsed time reads like the cli timer", () => {
  assert.equal(formatElapsed(0), "0s");
  assert.equal(formatElapsed(1500), "1s");
  assert.equal(formatElapsed(59000), "59s");
  assert.equal(formatElapsed(60000), "1m");
  assert.equal(formatElapsed(75000), "1m15s");
  assert.equal(formatElapsed(3600000), "1h");
  assert.equal(formatElapsed(3720000), "1h2m");
  assert.equal(formatElapsed(-5), "0s");
});
