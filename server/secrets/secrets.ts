// Secrets are stored as "sealed:v1:<base64>", AES-256-GCM under the key the main process keeps in safeStorage.
// Without a key, sealed values read as "", and only a dev host saves plaintext.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { isRecord } from "../../bridge/lenient.ts";

const PREFIX = "sealed:v1:";
let key: Buffer | null = null;
let plaintext = true;

export function setSecretKey(base64: string | null, dev: boolean): void {
  const bytes = base64 ? Buffer.from(base64, "base64") : null;
  key = bytes?.length === 32 ? bytes : null;
  plaintext = dev && !key;
}

export function sealSecret(plain: string): string {
  if (!plain || (!key && plaintext)) return plain;
  if (!key) throw new Error("X Bench could not read its key from the Keychain, so it does not save tokens. Unlock the Keychain and restart X Bench.");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

export function openSecret(stored: unknown): string {
  if (typeof stored !== "string") return "";
  if (!stored.startsWith(PREFIX)) return stored;
  if (!key) return "";
  try {
    const data = Buffer.from(stored.slice(PREFIX.length), "base64");
    const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}

export function sealFile(file: string, fields: readonly string[]): void {
  if (!key) return;
  let stored: unknown;
  try {
    stored = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return;
  }
  if (!isRecord(stored)) return;
  const plain = fields.flatMap((field) => {
    const value = stored[field];
    return typeof value === "string" && value && !value.startsWith(PREFIX) ? [[field, sealSecret(value)]] : [];
  });
  if (!plain.length) return;
  const next = { ...stored, ...Object.fromEntries(plain) };
  const temp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, file);
  } catch (error) {
    console.error(`Could not seal the secrets in ${file}. ${error instanceof Error ? error.message : ""}`);
  }
}
