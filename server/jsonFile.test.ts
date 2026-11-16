import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { durableNotices, watchedJson } from "./jsonFile.ts";
import { emptySidebar, readSidebar, writeSidebar } from "./sidebar/sidebar.ts";
import { emptyTickets, readTickets, writeTickets } from "./board/tickets.ts";

function scratch(): string {
  return mkdtempSync(path.join(os.tmpdir(), "grok-json-"));
}

function namesEnding(dir: string, suffix: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith(suffix));
}

test("a normal sidebar or tickets write leaves no temp file", () => {
  const dir = scratch();
  const sidebar = path.join(dir, "sidebar.json");
  const tickets = path.join(dir, "tickets.json");
  try {
    writeSidebar({ ...emptySidebar(), titles: { a: "Alpha" } }, sidebar);
    writeTickets({ ...emptyTickets(), links: [] }, tickets);
    assert.equal(namesEnding(dir, ".tmp").length, 0);
    assert.equal(existsSync(`${sidebar}.bak`), false);
    assert.equal(readSidebar(sidebar).titles.a, "Alpha");
    assert.deepEqual(readTickets(tickets), emptyTickets());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a sidebar that fails its schema is copied once and then left alone", () => {
  const dir = scratch();
  const file = path.join(dir, "sidebar.json");
  const original = JSON.stringify({ projects: {}, archived: [] });
  const errors: unknown[][] = [];
  const log = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  try {
    writeFileSync(file, original);
    assert.deepEqual(readSidebar(file), emptySidebar());
    assert.equal(readFileSync(file, "utf8"), original);
    assert.equal(readFileSync(`${file}.bak`, "utf8"), original);
    writeFileSync(`${file}.bak`, "keep this backup");
    assert.deepEqual(readSidebar(file), emptySidebar());
    assert.equal(readFileSync(`${file}.bak`, "utf8"), "keep this backup");
    writeSidebar(emptySidebar(), file);
    assert.equal(readFileSync(file, "utf8"), original);
    assert.equal(namesEnding(dir, ".tmp").length, 0);
    assert.equal(errors.length, 1);
    assert.equal(durableNotices().filter((notice) => notice.id === `unreadable:${file}`).length, 1);
    const notice = durableNotices().find((item) => item.id === `unreadable:${file}`);
    assert.match(notice?.title || "", /sidebar\.json/);
    assert.match(notice?.message || "", /sidebar\.json\.bak/);
  } finally {
    console.error = log;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a repaired sidebar is kept until a later read succeeds", () => {
  const dir = scratch();
  const file = path.join(dir, "sidebar.json");
  const repaired = `${JSON.stringify({ ...emptySidebar(), titles: { a: "Kept" } }, null, 2)}\n`;
  try {
    writeFileSync(file, "{");
    assert.deepEqual(readSidebar(file), emptySidebar());
    writeFileSync(file, repaired);
    writeSidebar({ ...emptySidebar(), hidden: ["stale"] }, file);
    assert.equal(readFileSync(file, "utf8"), repaired);
    assert.equal(readSidebar(file).titles.a, "Kept");
    writeSidebar({ ...readSidebar(file), hidden: ["stale"] }, file);
    assert.deepEqual(readSidebar(file).hidden, ["stale"]);
    assert.equal(durableNotices().some((notice) => notice.id === `unreadable:${file}`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a watched file notices a change another host wrote once, and its own write is not news", () => {
  const dir = scratch();
  try {
    const file = path.join(dir, "list.json");
    const parse = (value: unknown) => (Array.isArray(value) ? value : null);
    const json = watchedJson<unknown[]>(file, parse, [], "keep the list");
    assert.equal(json.changedOnDisk(), false);
    json.write(["one"]);
    assert.equal(json.changedOnDisk(), false);
    assert.equal(readFileSync(file, "utf8"), '[\n  "one"\n]\n');
    watchedJson<unknown[]>(file, parse, [], "keep the list").write(["one", "from the other host"]);
    assert.equal(json.changedOnDisk(), true);
    assert.equal(json.changedOnDisk(), false);
    assert.deepEqual(json.read(), ["one", "from the other host"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a watched file that does not read is left alone, and a write says what to fix", () => {
  const dir = scratch();
  try {
    const file = path.join(dir, "list.json");
    writeFileSync(file, "{ not json");
    const json = watchedJson<unknown[]>(file, (value) => (Array.isArray(value) ? value : null), [], "keep the list");
    assert.deepEqual(json.read(), []);
    assert.throws(() => json.write(["one"]), /list\.json does not read\. Fix or remove it to keep the list\./);
    assert.equal(readFileSync(file, "utf8"), "{ not json");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
