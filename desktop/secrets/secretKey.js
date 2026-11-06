// safeStorage's Keychain item opens without a prompt only for an app with this app's Developer ID signature.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function secretKey(file, storage) {
  if (!storage.isEncryptionAvailable()) return null;
  try {
    return storage.decryptString(fs.readFileSync(file));
  } catch (error) {
    // A key that exists but does not open is kept, so the secrets it sealed can open again later.
    if (error?.code !== "ENOENT") {
      console.error(`Could not open ${file}, so secrets stay as stored. ${error?.message ?? ""}`);
      return null;
    }
  }
  const key = randomBytes(32).toString("base64");
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, storage.encryptString(key), { mode: 0o600, flag: "wx" });
  } catch (error) {
    console.error(`Could not write ${file}, so secrets stay in plaintext. ${error?.message ?? ""}`);
    return null;
  }
  return key;
}
