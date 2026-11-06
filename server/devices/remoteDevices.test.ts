import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDeviceStore, PAIRING_MS, PAIRING_TRIES } from "./remoteDevices.ts";

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-devices-"));
  return path.join(dir, "remote-devices.json");
}

test("a pairing code pairs one device, once, and the file keeps only a hash of its secret", () => {
  const file = tempFile();
  const store = createDeviceStore({ file });
  const { code } = store.startPairing();
  const paired = store.pair(code.toLowerCase().replace(/(.{5})/, "$1-"), " My  iPhone ");
  assert.equal(paired.ok, true);
  if (!paired.ok) return;
  assert.equal(paired.device.name, "My iPhone");
  assert.deepEqual(store.pair(code, "Second"), { ok: false, error: "Show a new pairing code on the Mac" });

  const secret = paired.cookie.split(".")[1] ?? "";
  const text = fs.readFileSync(file, "utf8");
  assert.ok(!text.includes(secret));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  assert.equal(store.verify(paired.cookie)?.id, paired.device.id);
  assert.equal(createDeviceStore({ file }).verify(paired.cookie)?.id, paired.device.id);
  assert.equal(store.verify(`${paired.device.id}.wrong`), null);
  assert.equal(store.verify(`${paired.cookie}.extra`), null);
  assert.equal(store.verify(""), null);
});

test("a code expires, and too many wrong tries void it", () => {
  let now = 1_000;
  const store = createDeviceStore({ file: tempFile(), now: () => now });
  const first = store.startPairing();
  now += PAIRING_MS;
  assert.equal(store.pairing(), null);
  assert.equal(store.pair(first.code, "Late").ok, false);

  const second = store.startPairing();
  for (let index = 1; index < PAIRING_TRIES; index += 1) assert.deepEqual(store.pair("WRONGCODE1", "x"), { ok: false, error: "Wrong code" });
  assert.deepEqual(store.pair("WRONGCODE1", "x"), { ok: false, error: "Too many wrong codes. Show a new one on the Mac" });
  assert.equal(store.pair(second.code, "x").ok, false);
});

test("a removed device no longer verifies", () => {
  const store = createDeviceStore({ file: tempFile() });
  const paired = store.pair(store.startPairing().code, "Phone");
  assert.ok(paired.ok);
  if (!paired.ok) return;
  assert.equal(store.remove(paired.device.id), true);
  assert.equal(store.verify(paired.cookie), null);
  assert.deepEqual(store.list(), []);
  assert.equal(store.remove(paired.device.id), false);
});

test("a change starts from the file, so another process's device stays", () => {
  const file = tempFile();
  const app = createDeviceStore({ file });
  const dev = createDeviceStore({ file });
  assert.deepEqual(dev.list(), []);
  const first = app.pair(app.startPairing().code, "Phone");
  const second = dev.pair(dev.startPairing().code, "Tablet");
  assert.ok(first.ok && second.ok);
  assert.deepEqual(app.list().map((device) => device.name).sort(), ["Phone", "Tablet"]);
  if (first.ok) assert.ok(dev.remove(first.device.id));
  assert.deepEqual(app.list().map((device) => device.name), ["Tablet"]);
});

test("a removal that cannot be written keeps the device listed, and works once the file can be written", () => {
  const file = tempFile();
  const store = createDeviceStore({ file });
  const paired = store.pair(store.startPairing().code, "Phone");
  assert.ok(paired.ok);
  if (!paired.ok) return;
  fs.chmodSync(path.dirname(file), 0o500);
  try {
    assert.throws(() => store.remove(paired.device.id));
    assert.equal(store.list().length, 1);
    assert.equal(store.verify(paired.cookie)?.id, paired.device.id);
  } finally {
    fs.chmodSync(path.dirname(file), 0o700);
  }
  assert.ok(store.remove(paired.device.id));
  assert.equal(store.verify(paired.cookie), null);
});
