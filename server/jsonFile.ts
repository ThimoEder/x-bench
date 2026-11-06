// Durable JSON files in ~/.x-bench. A write goes to a temp file in the same folder
// and is renamed over the old one, so a crash cannot leave a cut-off file. A file
// that is present but cannot be read is copied to <name>.bak once, logged, and
// left in place until a later read succeeds.

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ServiceNotice } from "./snapshot.ts";

const blocked = new Map<string, ServiceNotice>();

interface Parsed {
  status: "ok";
  value: unknown;
}

interface Failed {
  status: "bad";
  error: unknown;
}

export function loadDurable<T>(file: string, parse: (value: unknown) => T | null, empty: T): T {
  if (!existsSync(file)) {
    blocked.delete(file);
    return empty;
  }
  const loaded = readParsed(file);
  if (loaded.status === "bad") {
    hold(file, loaded.error);
    return empty;
  }
  const parsed = accept(parse, loaded.value);
  if (parsed === undefined) {
    hold(file, new Error(`${path.basename(file)} does not match its schema`));
    return empty;
  }
  blocked.delete(file);
  return parsed;
}

// Returns false when the file on disk cannot be read. The temp file is only
// created for a write that is allowed to replace it.
export function saveDurable(file: string, text: string, parse: (value: unknown) => unknown): boolean {
  // A failed read keeps the file blocked until loadDurable succeeds, so a repaired
  // file is not replaced by the empty state that read returned.
  if (blocked.has(file) && existsSync(file)) return false;
  if (existsSync(file)) {
    const loaded = readParsed(file);
    if (loaded.status === "bad" || accept(parse, loaded.value) === undefined) {
      hold(file, loaded.status === "bad" ? loaded.error : new Error(`${path.basename(file)} does not match its schema`));
      return false;
    }
  }
  blocked.delete(file);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, file);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // The temp file may not have been created.
    }
    throw error;
  }
  return true;
}

// When and how big the file was last written, or "missing".
export function fileStamp(file: string): string {
  try {
    const stat = statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "missing";
  }
}

export function durableNotices(): ServiceNotice[] {
  return [...blocked.values()];
}

// True while a file that did not read is held, until loadDurable reads it again.
export function unreadable(file: string): boolean {
  return blocked.has(file);
}

function readParsed(file: string): Parsed | Failed {
  try {
    return { status: "ok", value: JSON.parse(readFileSync(file, "utf8")) };
  } catch (error) {
    return { status: "bad", error };
  }
}

// null and a thrown parse both mean the file cannot be read.
function accept<T>(parse: (value: unknown) => T | null, value: unknown): T | undefined {
  try {
    const parsed = parse(value);
    return parsed === null ? undefined : parsed;
  } catch {
    return undefined;
  }
}

function hold(file: string, error: unknown): void {
  const bak = `${file}.bak`;
  const name = path.basename(file);
  const bakName = path.basename(bak);
  if (!existsSync(bak)) {
    try {
      copyFileSync(file, bak);
    } catch (copyError) {
      console.error(`Could not copy ${name} to ${bakName}. ${errorText(copyError)}`);
    }
  }
  const copied = existsSync(bak);
  if (!blocked.has(file)) {
    const detail = errorText(error);
    const outcome = copied
      ? `Left ${name} unchanged and copied it to ${bakName}.`
      : `Left ${name} unchanged. Copying it to ${bakName} failed.`;
    console.error(`${name} could not be read. ${outcome}${detail ? ` ${detail}` : ""}`);
  }
  blocked.set(file, {
    id: `unreadable:${file}`,
    severity: "error",
    title: `Could not read ${name}`,
    message: copied
      ? `${name} was left unchanged and copied to ${bakName}. It will not be overwritten until it can be read.`
      : `${name} was left unchanged. Copying it to ${bakName} failed, and it will not be overwritten until it can be read.`,
    url: "",
    link: "",
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "";
}
