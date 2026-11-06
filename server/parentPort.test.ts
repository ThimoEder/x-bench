import assert from "node:assert/strict";
import test from "node:test";
import { grokMessage, isParentPort, isStopMessage, listeningMessage } from "./parentPort.ts";

test("only an object with postMessage and on counts as the parent port", () => {
  assert.equal(isParentPort(undefined), false);
  assert.equal(isParentPort({ postMessage() {} }), false);
  assert.equal(isParentPort({ postMessage: 1, on() {} }), false);
  assert.equal(isParentPort({ postMessage() {}, on() {} }), true);
});

test("only { type: \"stop\" } stops the host", () => {
  assert.equal(isStopMessage({ type: "stop" }), true);
  assert.equal(isStopMessage({ type: "listening" }), false);
  assert.equal(isStopMessage("stop"), false);
  assert.equal(isStopMessage(null), false);
});

test("the listening message carries the port", () => {
  assert.deepEqual(listeningMessage(8797), { type: "listening", port: 8797 });
});

test("the grok message carries Grok's pid and whether it runs", () => {
  assert.deepEqual(grokMessage(4242, true), { type: "grok", pid: 4242, running: true });
  assert.deepEqual(grokMessage(4242, false), { type: "grok", pid: 4242, running: false });
});
