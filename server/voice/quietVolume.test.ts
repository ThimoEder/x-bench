import assert from "node:assert/strict";
import test from "node:test";
import { createQuietVolume, QUIET_LEVEL } from "./quietVolume.ts";
import type { RunCommand } from "../runProcess.ts";

const LOWERED = { from: 60, to: 12 };

// A fake osascript for a Mac at volume 60, which a lowering takes to 12.
function fakeOsascript() {
  const inputs: Record<string, unknown>[] = [];
  const run: RunCommand = async (command, args) => {
    assert.equal(command, "osascript");
    const input = JSON.parse(args[args.length - 1] ?? "{}") as Record<string, unknown>;
    inputs.push(input);
    return { stdout: Buffer.from(JSON.stringify(input.restore ? null : LOWERED)) };
  };
  return { run, inputs };
}

// A fake whose calls matching hold wait for release; starting resolves at the first of them.
function heldOsascript(hold: (input: Record<string, unknown>) => boolean) {
  const fake = fakeOsascript();
  let started!: () => void;
  const starting = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const run: RunCommand = async (command, args, options) => {
    const input = JSON.parse(args[args.length - 1] ?? "{}") as Record<string, unknown>;
    if (hold(input)) {
      started();
      await released;
    }
    return fake.run(command, args, options);
  };
  return { run, inputs: fake.inputs, starting, release };
}

test("the volume goes down for the first take and back after the last", async () => {
  const { run, inputs } = fakeOsascript();
  const volume = createQuietVolume({ run, platform: "darwin" });
  await volume.lower("a");
  await volume.lower("b");
  await volume.restore("a");
  assert.equal(inputs.length, 1);
  await volume.restore("b");
  await volume.restore("b");
  assert.deepEqual(inputs, [{ level: QUIET_LEVEL }, { restore: LOWERED }]);
});

test("the first take's level counts, kept between nothing and all", async () => {
  const { run, inputs } = fakeOsascript();
  const volume = createQuietVolume({ run, platform: "darwin" });
  await volume.lower("a", 0.05);
  await volume.lower("b", 0.5);
  await volume.restore("a");
  await volume.restore("b");
  await volume.lower("c", 3);
  assert.deepEqual(
    inputs.filter((input) => "level" in input),
    [{ level: 0.05 }, { level: 1 }],
  );
});

test("a take that ends before the lowering starts leaves the volume alone", async () => {
  const { run, inputs } = fakeOsascript();
  const volume = createQuietVolume({ run, platform: "darwin" });
  void volume.lower("a");
  await volume.restore("a");
  assert.equal(inputs.length, 0);
});

test("a take that ends while the lowering runs still gets its volume back", async () => {
  const { run, inputs, starting, release } = heldOsascript((input) => "level" in input);
  const volume = createQuietVolume({ run, platform: "darwin" });
  const lowering = volume.lower("a");
  await starting;
  const restoring = volume.restore("a");
  release();
  await Promise.all([lowering, restoring]);
  assert.deepEqual(inputs, [{ level: QUIET_LEVEL }, { restore: LOWERED }]);
});

test("a lower that arrives after its take ended is ignored", async () => {
  const { run, inputs } = fakeOsascript();
  const volume = createQuietVolume({ run, platform: "darwin" });
  await volume.restore("a");
  await volume.lower("a");
  assert.equal(inputs.length, 0);
});

test("the volume comes back on its own when a take never ends", async () => {
  const { run, inputs } = fakeOsascript();
  const volume = createQuietVolume({ run, platform: "darwin", holdMs: 10 });
  await volume.lower("a");
  await new Promise((resolve) => {
    setTimeout(resolve, 40);
  });
  assert.deepEqual(inputs.at(-1), { restore: LOWERED });
});

test("shutdown restores every take", async () => {
  const { run, inputs } = fakeOsascript();
  const volume = createQuietVolume({ run, platform: "darwin" });
  await volume.lower("a");
  await volume.lower("b");
  await volume.restoreAll();
  assert.deepEqual(inputs, [{ level: QUIET_LEVEL }, { restore: LOWERED }]);
});

test("shutdown waits for a lowering already running and restores it", async () => {
  const { run, inputs, starting, release } = heldOsascript((input) => "level" in input);
  const volume = createQuietVolume({ run, platform: "darwin" });
  void volume.lower("a");
  await starting;
  const stopping = volume.restoreAll();
  release();
  await stopping;
  assert.deepEqual(inputs, [{ level: QUIET_LEVEL }, { restore: LOWERED }]);
});

test("shutdown stops waiting for a restore that hangs", async () => {
  const { run } = heldOsascript((input) => "restore" in input);
  const volume = createQuietVolume({ run, platform: "darwin", shutdownWaitMs: 10 });
  await volume.lower("a");
  await volume.restoreAll();
});

test("a failing osascript leaves dictation alone", async () => {
  const volume = createQuietVolume({
    platform: "darwin",
    run: async () => {
      throw new Error("osascript took longer than 15 seconds");
    },
  });
  const logged = console.error;
  console.error = () => {};
  try {
    await volume.lower("a");
    await volume.restore("a");
  } finally {
    console.error = logged;
  }
});

test("other systems leave the volume alone", async () => {
  const { run, inputs } = fakeOsascript();
  const volume = createQuietVolume({ run, platform: "linux" });
  await volume.lower("a");
  await volume.restore("a");
  assert.equal(inputs.length, 0);
});
