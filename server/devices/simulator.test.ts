import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { RunCommand } from "../runProcess.ts";
import { createSimulator, type SimDevice } from "./simulator.ts";

const IPHONE: SimDevice = { id: "16CCC597-962C-4BF1-902E-8C412D8C45C2", platform: "ios", name: "iPhone 17 Pro", os: "iOS 26.2", booted: true, state: "booted" };
// A JPEG that says it is 1206×2622.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x0a, 0x3e, 0x04, 0xb6, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);

function setup() {
  const ran: string[] = [];
  const run: RunCommand = async (command, args) => {
    const line = [path.basename(command), ...args].join(" ");
    ran.push(line);
    if (line.startsWith("xcrun simctl io")) writeFileSync(args.at(-1) ?? "", JPEG);
    return { stdout: Buffer.from(line.startsWith("plutil") ? "3\n" : line.startsWith("xcrun simctl list devicetypes") ? '{"devicetypes":[]}' : "{}") };
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x-bench-sim-"));
  const simulator = createSimulator({ run, logDir: dir, helpers: { path: () => null, get: () => Promise.reject(new Error("no helper")) }, android: { emulator: "/missing/emulator" } });
  test.after(() => {
    simulator.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { simulator, ran };
}

test("a frame is the screen simctl wrote with its size in points, and pages asking at once share one", async () => {
  const { simulator, ran } = setup();
  const [first, second] = await Promise.all([simulator.frame(IPHONE), simulator.frame(IPHONE)]);
  assert.equal(first, second);
  assert.deepEqual([first.width, first.height], [402, 874]);
  assert.equal(ran.filter((line) => line.startsWith("xcrun simctl io")).length, 1);
  await simulator.frame(IPHONE);
  assert.equal(ran.filter((line) => line.startsWith("xcrun simctl io")).length, 2);
});

test("a device goes to its platform's driver only once it runs", async () => {
  const { simulator } = setup();
  assert.equal(simulator.driverOf(IPHONE).unit, "points");
  assert.equal(simulator.driverOf({ platform: "android" }).unit, "dp");
  await assert.rejects(simulator.tap({ ...IPHONE, booted: false }, { x: 1, y: 1 }), /is not running/);
  await assert.rejects(simulator.shake({ ...IPHONE, id: "emulator-5554", platform: "android" }), /iOS simulators only/);
});
