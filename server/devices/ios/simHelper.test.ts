import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createSimHelpers } from "./simHelper.ts";

function framed(kind: number, payload: Buffer | string): Buffer {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const header = Buffer.alloc(5);
  header[0] = kind;
  header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, body]);
}

// A stand-in for xbench-sim that answers each request line with handle's result.
function fakeProcess(handle: (request: Record<string, unknown>) => unknown, start: "ready" | "failed" = "ready") {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
  let rest = "";
  child.stdin.on("data", (chunk: Buffer) => {
    const lines = (rest + chunk.toString()).split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines) {
      const request = JSON.parse(line) as Record<string, unknown>;
      if (request.id === undefined) continue;
      child.stdout.write(framed(0, JSON.stringify({ id: request.id, ok: true, result: handle(request) })));
    }
  });
  setImmediate(() => {
    if (start === "failed") child.stdout.write(framed(0, JSON.stringify({ event: "failed", error: "No simulator has the UDID X." })));
    else child.stdout.write(framed(0, JSON.stringify({ event: "ready", info: { name: "iPhone 17 Pro", width: 402, height: 874, widthPixels: 1206, heightPixels: 2622, scale: 3 } })));
  });
  return child;
}

test("a helper starts once per simulator, answers requests and passes frames on", async () => {
  let starts = 0;
  let child: ReturnType<typeof fakeProcess> | null = null;
  const helpers = createSimHelpers({
    binary: "/fake/xbench-sim",
    start: () => {
      starts += 1;
      child = fakeProcess((request) => ({ echoed: request.op }));
      return child as unknown as ChildProcessWithoutNullStreams;
    },
  });
  const [first, second] = await Promise.all([helpers.get("A"), helpers.get("A")]);
  assert.equal(first, second);
  assert.equal(starts, 1);
  assert.equal(first.info.width, 402);
  assert.deepEqual(await first.call("describe"), { echoed: "describe" });
  const frames: string[] = [];
  first.onFrame((data) => frames.push(data.toString("hex")));
  const feed = child as unknown as ReturnType<typeof fakeProcess>;
  const whole = framed(1, Buffer.from([0, 0, 0, 1, 0x65]));
  feed.stdout.write(whole.subarray(0, 3));
  feed.stdout.write(whole.subarray(3));
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  assert.deepEqual(frames, ["0000000165"]);
});

test("a helper that fails to start is left alone for a minute", async () => {
  let now = 0;
  let starts = 0;
  const helpers = createSimHelpers({
    binary: "/fake/xbench-sim",
    now: () => now,
    start: () => {
      starts += 1;
      return fakeProcess(() => null, "failed") as unknown as ChildProcessWithoutNullStreams;
    },
  });
  await assert.rejects(helpers.get("X"), /No simulator has the UDID X/);
  await assert.rejects(helpers.get("X"), /No simulator has the UDID X/);
  assert.equal(starts, 1);
  now = 61_000;
  await assert.rejects(helpers.get("X"));
  assert.equal(starts, 2);
});

test("without a helper binary there is nothing to start", async () => {
  const helpers = createSimHelpers({ binary: null });
  assert.equal(helpers.path(), null);
  await assert.rejects(helpers.get("A"), /no simulator helper/);
});
