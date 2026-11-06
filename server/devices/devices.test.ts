import assert from "node:assert/strict";
import test from "node:test";
import { containedPoint, devicePoint, findDevice, jpegSize, parseAdbDevices, parseSimctl, parseSimctlAll, pngSize } from "./deviceMath.ts";
import { createDevices } from "./devices.ts";

const IPHONE = "16CCC597-962C-4BF1-902E-8C412D8C45C2";

test("booted simulators keep a name and id", () => {
  const devices = parseSimctl({
    devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-26-2": [
        { udid: IPHONE, name: "iPhone 17 Pro", state: "Booted" },
        { udid: "AAAAAAAAAAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE", name: "Off", state: "Shutdown" },
      ],
      "com.apple.CoreSimulator.SimRuntime.iOS-26-4": [],
    },
  });
  assert.deepEqual(devices, [{ id: IPHONE, platform: "ios", name: "iPhone 17 Pro · iOS 26.2", state: "booted" }]);
});

test("adb rows keep the emulator and an unauthorized phone", () => {
  const devices = parseAdbDevices(`List of devices attached
emulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:2
192.168.1.9:5555       unauthorized transport_id:3
junk
`);
  assert.deepEqual(devices, [
    { id: "emulator-5554", platform: "android", name: "Android emulator 5554", state: "device" },
    { id: "192.168.1.9:5555", platform: "android", name: "192.168.1.9:5555", state: "unauthorized" },
  ]);
});

test("a click lands on the fitted screen and misses the bars beside it", () => {
  const image = containedPoint({
    containerWidth: 200,
    containerHeight: 200,
    imageWidth: 100,
    imageHeight: 200,
    clientX: 100,
    clientY: 40,
  });
  assert.deepEqual(image, { x: 50, y: 40 });
  const bar = containedPoint({
    containerWidth: 200,
    containerHeight: 200,
    imageWidth: 100,
    imageHeight: 200,
    clientX: 10,
    clientY: 40,
  });
  assert.equal(bar, null);
});

test("a shrunk frame still maps onto the device pixels", () => {
  const fitted = containedPoint({
    containerWidth: 405,
    containerHeight: 900,
    imageWidth: 405,
    imageHeight: 900,
    clientX: 100,
    clientY: 200,
  });
  assert.deepEqual(devicePoint(fitted, { width: 405, height: 900 }, { width: 1080, height: 2400 }), { x: 267, y: 533 });
});

test("png size is read from the header", () => {
  const buffer = Buffer.alloc(24);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(1080, 16);
  buffer.writeUInt32BE(2400, 20);
  assert.deepEqual(pngSize(buffer), { width: 1080, height: 2400 });
  assert.equal(pngSize(Buffer.from("nope")), null);
});

test("only a listed device that is running is ready for the Device tab", async () => {
  const devices = createDevices({
    adb: "adb",
    xcrun: "xcrun",
    run: async (_command, args) => {
      if (args.includes("booted")) return { stdout: Buffer.from(JSON.stringify({ devices: {} })) };
      if (args.includes("emu")) return { stdout: Buffer.from("") };
      return { stdout: Buffer.from("List of devices attached\nemulator-5554          device model:sdk_gphone64_arm64\n192.168.1.9:5555       offline\n") };
    },
  });
  assert.deepEqual(await devices.ready("emulator-5554"), { id: "emulator-5554", platform: "android", name: "Android emulator 5554", state: "device", os: "", booted: true });
  await assert.rejects(devices.ready("nope"), /not available/);
  await assert.rejects(devices.ready(IPHONE), /not available/);
  await assert.rejects(devices.ready("192.168.1.9:5555"), /not available/);
  assert.equal(findDevice([{ id: "emulator-5554" }], "other"), null);
});

test("an unauthorized emulator is reconnected once", async () => {
  let lists = 0;
  const calls: string[] = [];
  const devices = createDevices({
    adb: "adb",
    xcrun: "xcrun",
    run: async (_command, args) => {
      calls.push(args.join(" "));
      if (args.includes("booted")) return { stdout: Buffer.from(JSON.stringify({ devices: {} })) };
      if (args[0] === "reconnect") return { stdout: Buffer.from("") };
      lists += 1;
      const state = lists === 1 ? "unauthorized" : "device";
      return { stdout: Buffer.from(`List of devices attached\nemulator-5554          ${state} model:sdk_gphone64_arm64\n`) };
    },
  });
  const first = await devices.list();
  assert.equal(first.devices[0]?.state, "device");
  await devices.list();
  assert.equal(calls.filter((line) => line === "reconnect").length, 1);
});

test("the full simctl list keeps every available simulator with its state and device type", () => {
  const devices = parseSimctlAll({
    devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-26-2": [
        { udid: IPHONE, name: "iPhone 17 Pro", state: "Booted", isAvailable: true, deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro" },
        { udid: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE", name: "Gone", state: "Shutdown", isAvailable: false },
      ],
      "com.apple.CoreSimulator.SimRuntime.watchOS-26-0": [{ udid: "BBBBBBBB-BBBB-CCCC-DDDD-EEEEEEEEEEEE", name: "Watch", state: "Shutdown" }],
    },
  });
  assert.deepEqual(devices, [
    { id: IPHONE, name: "iPhone 17 Pro", os: "iOS 26.2", state: "booted", typeId: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro" },
    { id: "BBBBBBBB-BBBB-CCCC-DDDD-EEEEEEEEEEEE", name: "Watch", os: "watchOS 26.0", state: "shutdown", typeId: "" },
  ]);
});

test("a JPEG's size comes from its start-of-frame marker", () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x0a, 0x3e, 0x04, 0xb6, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  assert.deepEqual(jpegSize(jpeg), { width: 1206, height: 2622 });
  assert.equal(jpegSize(Buffer.from("not a jpeg")), null);
});
