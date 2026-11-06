import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { RunCommand } from "../../runProcess.ts";
import { writeTree } from "../screenTree.ts";
import type { SimDevice } from "../simulator.ts";
import type { AndroidHelper, AndroidHelpers } from "./androidHelper.ts";
import { createAndroidDriver } from "./androidDriver.ts";
import type { ScrcpyControls } from "./scrcpy.ts";
import { encodeText, encodeTouch, keyEvent } from "./scrcpyFormat.ts";

const PIXEL: SimDevice = { id: "emulator-5554", platform: "android", name: "Pixel 9", os: "Android", booted: true, state: "device" };

const XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
<node index="0" text="" resource-id="" class="android.widget.FrameLayout" clickable="false" enabled="true" bounds="[0,0][1080,2400]">
<node index="0" text="Network &amp; internet" resource-id="com.android.settings:id/row" class="android.widget.Button" clickable="true" enabled="true" bounds="[0,315][1080,507]" />
</node>
</hierarchy>`;

// A PNG header for a 1080×2400 screen, enough for pngSize.
function png(): Buffer {
  const buffer = Buffer.alloc(33);
  buffer.write("\x89PNG\r\n\x1a\n", 0, "latin1");
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "latin1");
  buffer.writeUInt32BE(1080, 16);
  buffer.writeUInt32BE(2400, 20);
  return buffer;
}

// adb on an emulator at 420 dpi, 1080×2400 pixels, which answers each command line from answers or with nothing.
function fakeAdb(answers: Record<string, string | Buffer> = {}) {
  const ran: string[] = [];
  const run: RunCommand = async (command, args) => {
    const line = [path.basename(command), ...args].join(" ");
    ran.push(line);
    if (line.startsWith("sips")) fs.writeFileSync(args.at(-1) ?? "", "jpeg");
    const known: Record<string, string | Buffer> = {
      "adb -s emulator-5554 shell wm density": "Physical density: 420\n",
      "adb -s emulator-5554 shell dumpsys window displays": "  Display: mDisplayId=0\n    init=1080x2400 420dpi cur=1080x2400 app=1080x2337 rng=1080x1017-2337x2337\n",
      ...answers,
    };
    return { stdout: Buffer.from(known[line] ?? "") };
  };
  return { run, ran };
}

const noHelpers: AndroidHelpers = { path: () => null, get: () => Promise.reject(new Error("no helper")), close: () => {} };

// started false makes every control session fail to start.
function fakeControls(started = true) {
  const sent: Buffer[] = [];
  const controls: ScrcpyControls = {
    get: async () => {
      if (!started) throw new Error("adb forward failed");
      return {
        send: async (bytes) => {
          sent.push(bytes);
        },
        paste: async () => {},
        alive: () => true,
      };
    },
    close: () => {},
  };
  return { controls, sent };
}

function driver(answers: Record<string, string | Buffer> = {}, options: { controls?: ScrcpyControls; helpers?: AndroidHelpers; emulator?: string } = {}) {
  const adb = fakeAdb(answers);
  const made = createAndroidDriver({ run: adb.run, adb: "adb", emulator: options.emulator ?? "/missing/emulator", helpers: options.helpers ?? noHelpers, controls: options.controls ?? fakeControls(false).controls });
  test.after(() => made.close());
  return { driver: made, ran: adb.ran };
}

test("the list holds running devices by their AVD name and the emulators that are not running", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x-bench-android-"));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const emulator = path.join(dir, "emulator");
  fs.writeFileSync(emulator, "");
  const { driver: android } = driver(
    {
      "adb devices -l": "List of devices attached\nemulator-5554          device model:sdk_gphone64_arm64 transport_id:2\n192.168.1.9:5555       unauthorized transport_id:3\n",
      "adb -s emulator-5554 emu avd name": "Pixel_9\nOK\n",
      "emulator -list-avds": "Pixel_9\nTablet_11\n",
    },
    { emulator },
  );
  assert.deepEqual(await android.list(), [
    { ...PIXEL },
    { id: "192.168.1.9:5555", platform: "android", name: "192.168.1.9:5555", os: "Android", booted: false, state: "unauthorized" },
    { id: "avd:Tablet_11", platform: "android", name: "Tablet 11", os: "Android", booted: false, state: "stopped" },
  ]);
  await assert.rejects(android.boot({ ...PIXEL, id: "192.168.1.9:5555", booted: false, state: "unauthorized" }), /Connect it over adb first/);
});

test("touches, keys and text go through scrcpy in pixels", async () => {
  const { controls, sent } = fakeControls();
  const { driver: android, ran } = driver({}, { controls });
  await android.tap(PIXEL, { x: 100, y: 200 }, 0);
  const touch = (action: "down" | "move" | "up") => encodeTouch({ action, x: 262.5, y: 525, width: 1080, height: 2400, pointer: 1n });
  assert.deepEqual(sent.splice(0), [touch("down"), touch("move"), touch("up")]);
  await android.press(PIXEL, "home", 0);
  await android.type(PIXEL, "hi");
  assert.deepEqual(sent, [Buffer.concat([keyEvent(3, "down"), keyEvent(3, "up")]), encodeText("hi")]);
  assert.equal(ran.some((line) => line.includes("input")), false);
});

test("a landscape screen gets its touches at its turned size", async () => {
  const { controls, sent } = fakeControls();
  const { driver: android } = driver({ "adb -s emulator-5554 shell dumpsys window displays": "    init=1080x2400 420dpi cur=2400x1080 app=2337x1080\n" }, { controls });
  await android.tap(PIXEL, { x: 100, y: 200 }, 0);
  assert.deepEqual([sent[0]?.readUInt16BE(18), sent[0]?.readUInt16BE(20)], [2400, 1080]);
});

test("without scrcpy, touches and keys fall back to adb input, and two fingers say why they cannot", async () => {
  const { driver: android, ran } = driver();
  await android.tap(PIXEL, { x: 100, y: 200 }, 0);
  await android.press(PIXEL, "home", 0);
  await android.type(PIXEL, "a b");
  const inputs = ran.filter((line) => line.includes(" input "));
  assert.deepEqual(inputs, ["adb -s emulator-5554 shell input tap 263 525", "adb -s emulator-5554 shell input keyevent 3", "adb -s emulator-5554 shell input text 'a%sb'"]);
  const points = [
    { x: 10, y: 10 },
    { x: 20, y: 20 },
  ];
  await assert.rejects(android.touchPath(PIXEL, points, points), /need scrcpy, which could not start: adb forward failed/);
  await assert.rejects(android.type(PIXEL, "Grüße"), /beyond plain ASCII/);
});

test("without the helper, a screenshot comes from screencap at one pixel per dp", async () => {
  const { driver: android, ran } = driver({ "adb -s emulator-5554 exec-out screencap -p": png() });
  const shot = await android.screenshot(PIXEL);
  assert.deepEqual([shot.width, shot.height, shot.data.toString()], [411, 914, "jpeg"]);
  assert.ok(ran.some((line) => line.startsWith("sips") && line.includes("-Z 914")));
});

test("a frame is the helper's picture at full size, with the screen in dp", async () => {
  const asked: Record<string, unknown>[] = [];
  const helper: AndroidHelper = {
    async call(op, args = {}) {
      asked.push({ op, ...args });
      return { jpeg: Buffer.from("frame").toString("base64"), width: 1080, height: 2400 };
    },
    display: async () => ({ width: 1080, height: 2400, rotation: 0, density: 420 }),
    alive: () => true,
    close: () => {},
  };
  const { driver: android, ran } = driver({}, { helpers: { path: () => "/fake/xbench-android.jar", get: async () => helper, close: () => {} } });
  const shot = await android.frame(PIXEL);
  assert.deepEqual([shot.width, shot.height, shot.data.toString()], [411, 914, "frame"]);
  assert.deepEqual(asked, [{ op: "shot", scale: 1, quality: 85 }]);
  assert.equal(ran.length, 0);
});

test("without the helper, the screen's tree comes from uiautomator in dp", async () => {
  const { driver: android } = driver({ "adb -s emulator-5554 shell uiautomator dump /sdcard/x-bench-ui.xml >/dev/null 2>&1; cat /sdcard/x-bench-ui.xml; rm -f /sdcard/x-bench-ui.xml": XML });
  const { lines } = writeTree(await android.tree(PIXEL, 10_000), true);
  assert.deepEqual(lines, ['- Button "Network & internet" id=row (0,120 411.4×73.1) [e1]']);
});

test("the helper's tree waits for the screen to idle within half the read's time", async () => {
  const asked: Record<string, unknown>[] = [];
  const helper: AndroidHelper = {
    async call(op, args = {}) {
      asked.push({ op, ...args });
      return { xml: XML };
    },
    display: async () => ({ width: 1080, height: 2400, rotation: 0, density: 420 }),
    alive: () => true,
    close: () => {},
  };
  const { driver: android, ran } = driver({}, { helpers: { path: () => "/fake/xbench-android.jar", get: async () => helper, close: () => {} } });
  assert.ok(android.settles);
  const { lines } = writeTree(await android.tree(PIXEL, 4700), true);
  assert.deepEqual(lines, ['- Button "Network & internet" id=row (0,120 411.4×73.1) [e1]']);
  await android.tree(PIXEL, 45_000);
  assert.deepEqual(asked, [{ op: "tree", idleMs: 2350 }, { op: "tree", idleMs: 3000 }]);
  assert.equal(ran.length, 0);
});

test("a launch starts the app's launcher activity and its log follows its process", async () => {
  const { driver: android, ran } = driver({
    "adb -s emulator-5554 shell monkey -p 'com.example.sample' -c android.intent.category.LAUNCHER 1": "Events injected: 1\n",
    "adb -s emulator-5554 shell pidof 'com.example.sample'": "4242\n",
  });
  assert.deepEqual(await android.launch(PIXEL, "com.example.sample"), { name: "com.example.sample", pid: 4242 });
  assert.equal(ran[0], "adb -s emulator-5554 shell am force-stop 'com.example.sample'");
  await android.appLog(PIXEL, "com.example.sample", 30);
  assert.ok(ran.at(-1)?.endsWith("--pid=4242"));
});
