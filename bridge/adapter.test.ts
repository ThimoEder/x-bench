import assert from "node:assert/strict";
import test from "node:test";
import { stderrTail } from "./adapter.ts";

test("stderrTail keeps the last two lines that skip does not match", () => {
  assert.equal(stderrTail("one\n\ntwo\nthree\n"), ": two three");
  assert.equal(stderrTail("  \n"), "");
  assert.equal(stderrTail("error\nnoise 1\nnoise 2\n", /^noise/), ": error");
});
