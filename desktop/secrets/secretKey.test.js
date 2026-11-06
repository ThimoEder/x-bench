import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { secretKey } from "./secretKey.js";

// safeStorage's shape, with a reversible stand-in for the Keychain's encryption.
const storage = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (text) => Buffer.from(`wrapped:${text}`),
  decryptString: (buffer) => {
    const text = buffer.toString();
    if (!text.startsWith("wrapped:")) throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString.");
    return text.slice("wrapped:".length);
  },
});

test("the key is made once, stored wrapped, and read back", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "x-bench-key-")), ".x-bench", "secret-key");
  const key = secretKey(file, storage());
  assert.equal(Buffer.from(key, "base64").length, 32);
  assert.equal(fs.readFileSync(file, "utf8"), `wrapped:${key}`);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(secretKey(file, storage()), key);
});

test("a key that does not open is left in place and secrets stay as stored", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "x-bench-key-")), "secret-key");
  fs.writeFileSync(file, "from another keychain");
  const error = console.error;
  console.error = () => {};
  try {
    assert.equal(secretKey(file, storage()), null);
  } finally {
    console.error = error;
  }
  assert.equal(fs.readFileSync(file, "utf8"), "from another keychain");
  assert.equal(secretKey(path.join(path.dirname(file), "other"), storage(false)), null);
});
