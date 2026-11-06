// The phones paired for remote access. ~/.x-bench/remote-devices.json keeps each device's id, name, dates and a
// SHA-256 hash of its secret. The secret itself lives only in the device's cookie. The installed app and a dev
// host share the file: every check reads it, and every change starts from the file as it is, so a device removed
// in one process is refused by the other.
//
// A pairing code is shown on the Mac while its sheet is open. It is single use, expires after two minutes, and is
// voided after a few wrong tries, so a short code typed by hand stays safe.

import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const PAIRING_MS = 2 * 60_000;
export const PAIRING_TRIES = 5;
// Unambiguous letters and digits, so a code reads and types without mixing up 0 and O or 1 and I.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 10;
// Last use is written at most this often, so every request does not rewrite the file.
const LAST_USED_MS = 60_000;

export interface RemoteDevice {
  id: string;
  name: string;
  pairedAt: number;
  lastUsed: number;
}

interface StoredDevice extends RemoteDevice {
  hash: string;
}

export interface Pairing {
  code: string;
  expiresAt: number;
}

export type PairResult = { ok: true; device: RemoteDevice; cookie: string } | { ok: false; error: string };

export interface DeviceStore {
  list(): RemoteDevice[];
  startPairing(): Pairing;
  cancelPairing(): void;
  pairing(): Pairing | null;
  pair(code: string, name: string): PairResult;
  // The device a cookie value belongs to, or null.
  verify(cookie: string): RemoteDevice | null;
  // Whether the device is still paired, also after another process removed it.
  has(id: string): boolean;
  remove(id: string): boolean;
}

export function createDeviceStore({ file, now = Date.now }: { file: string; now?: () => number }): DeviceStore {
  let pending: (Pairing & { tries: number }) | null = null;
  let written = now();

  // Applies change to the file as it is now. A failed write leaves the file as it was and throws.
  function update(change: (current: StoredDevice[]) => StoredDevice[]) {
    write(file, change(read(file)));
    written = now();
  }

  function current(): (Pairing & { tries: number }) | null {
    if (pending && pending.expiresAt <= now()) pending = null;
    return pending;
  }

  return {
    list: () => read(file).map(publicDevice),
    startPairing() {
      pending = { code: pairingCode(), expiresAt: now() + PAIRING_MS, tries: 0 };
      return { code: pending.code, expiresAt: pending.expiresAt };
    },
    cancelPairing() {
      pending = null;
    },
    pairing() {
      const open = current();
      return open ? { code: open.code, expiresAt: open.expiresAt } : null;
    },
    pair(code, name) {
      const open = current();
      if (!open) return { ok: false, error: "Show a new pairing code on the Mac" };
      if (!sameText(normalCode(code), open.code)) {
        open.tries += 1;
        if (open.tries >= PAIRING_TRIES) pending = null;
        return { ok: false, error: pending ? "Wrong code" : "Too many wrong codes. Show a new one on the Mac" };
      }
      pending = null;
      const id = randomBytes(9).toString("base64url");
      const secret = randomBytes(32).toString("base64url");
      const at = now();
      const device: StoredDevice = { id, name: cleanName(name), pairedAt: at, lastUsed: at, hash: hashOf(secret) };
      update((devices) => [...devices, device]);
      return { ok: true, device: publicDevice(device), cookie: `${id}.${secret}` };
    },
    verify(cookie) {
      const [id, secret, extra] = cookie.split(".");
      if (!id || !secret || extra !== undefined) return null;
      const device = read(file).find((item) => item.id === id);
      if (!device || !sameText(hashOf(secret), device.hash)) return null;
      const at = now();
      if (at - written >= LAST_USED_MS) {
        try {
          update((devices) => devices.map((item) => (item.id === id ? { ...item, lastUsed: at } : item)));
        } catch {
          // Last use is a convenience. An unwritable file does not refuse the device.
        }
      }
      return publicDevice({ ...device, lastUsed: at });
    },
    has: (id) => read(file).some((item) => item.id === id),
    remove(id) {
      if (!read(file).some((item) => item.id === id)) return false;
      update((devices) => devices.filter((item) => item.id !== id));
      return true;
    },
  };
}

export function normalCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function pairingCode(): string {
  let code = "";
  for (let index = 0; index < CODE_LENGTH; index += 1) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

function cleanName(name: string): string {
  return name.replace(/\s+/g, " ").trim().slice(0, 60) || "Phone";
}

function hashOf(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function sameText(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function publicDevice({ id, name, pairedAt, lastUsed }: StoredDevice): RemoteDevice {
  return { id, name, pairedAt, lastUsed };
}

function read(file: string): StoredDevice[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isStored);
  } catch {
    return [];
  }
}

function isStored(value: unknown): value is StoredDevice {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === "string" && typeof item.name === "string" && typeof item.hash === "string" && typeof item.pairedAt === "number" && typeof item.lastUsed === "number";
}

function write(file: string, devices: StoredDevice[]) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(devices, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(temp, 0o600);
  fs.renameSync(temp, file);
}
