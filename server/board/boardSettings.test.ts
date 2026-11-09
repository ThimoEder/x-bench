import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { columnStatus, NO_SETTINGS, orderColumns, resolveMoves } from "./boardSettings.ts";
import { normalizeSettings, readSettings, saveSettings, settingsFile } from "./boardSettingsFile.ts";

const columns = [
  { status: "todo", title: "To Do" },
  { status: "doing", title: "In Progress" },
  { status: "cr", title: "Code Review" },
  { status: "done", title: "Done" },
];

test("a move goes to the column picked for it, nowhere when turned off, and else to the first column with a name it looks for", () => {
  assert.deepEqual(resolveMoves(columns, NO_SETTINGS), { create: null, start: columns[1], review: columns[2], done: columns[3] });
  const picked = resolveMoves(columns, { ...NO_SETTINGS, moves: { create: columns[0], review: null, done: columns[2] } });
  assert.deepEqual(picked, { create: columns[0], start: columns[1], review: null, done: columns[2] });
});

test("a column without a status and one with an empty status keep their settings apart", () => {
  assert.deepEqual([null, undefined, "", "open", 3].map(columnStatus), ["", "", '""', "open", "3"]);
});

test("columns keep the board's order, with the rest after them", () => {
  assert.deepEqual(orderColumns(columns, ["done", "gone", "todo"], (column) => column.status).map((column) => column.status), ["done", "todo", "doing", "cr"]);
});

test("stored settings keep only what they can use", () => {
  const settings = normalizeSettings({
    columns: { a: { hidden: true, collapsed: true, color: "Green" }, b: { color: "url(x)", hidden: false }, c: "hidden", ["x".repeat(201)]: { hidden: true } },
    order: ["a", 3, "a", "b"],
    moves: { create: { status: " a ", title: "" }, start: null, review: { title: "no status" }, done: { status: "d", title: `Done\n\u200bnow ${"x".repeat(100)}` }, other: { status: "x" } },
  });
  assert.deepEqual(settings, {
    columns: { a: { hidden: true, collapsed: true, color: "green" } },
    order: ["a", "b"],
    moves: { create: { status: "a", title: "a" }, start: null, done: { status: "d", title: `Done now ${"x".repeat(71)}` } },
  });
  assert.deepEqual(normalizeSettings("junk"), NO_SETTINGS);
});

test("each folder keeps its own settings, and a reset drops them", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-board-settings-"));
  try {
    const tickets = path.join(root, "tickets.json");
    assert.deepEqual(readSettings(tickets, "/repo"), NO_SETTINGS);
    assert.deepEqual(saveSettings(tickets, "/repo", { columns: { done: { collapsed: true } } }).columns, { done: { collapsed: true } });
    assert.deepEqual(readSettings(tickets, "/other"), NO_SETTINGS);
    assert.deepEqual(saveSettings(tickets, "/repo", null), NO_SETTINGS);
    writeFileSync(settingsFile(tickets), "{ cut off");
    assert.deepEqual(readSettings(tickets, "/repo"), NO_SETTINGS);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
