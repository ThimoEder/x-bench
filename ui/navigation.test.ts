import { test } from "node:test";
import assert from "node:assert/strict";
import { DESK, NEEDS, ROUTINES, navigate, pageFromSearch, searchFor, viewFromSearch, type View } from "./navigation.ts";

const board = (cwd: string, taskId: unknown = null): View => ({ page: "board", cwd, taskId, settings: null });

test("going to a page closes settings", () => {
  const view: View = { ...DESK, settings: "general" };
  assert.deepEqual(navigate(view, { type: "go", to: ROUTINES }), { page: "routines", settings: null });
  assert.deepEqual(navigate(view, { type: "go", to: { page: "board", cwd: "/repo", taskId: 7 } }), { page: "board", cwd: "/repo", taskId: 7, settings: null });
});

test("settings opened after a move began stay open when it lands", () => {
  const opened: View = { ...ROUTINES, settings: "remote" };
  assert.deepEqual(navigate(opened, { type: "go", to: DESK, settingsAtStart: null }), { page: "desk", settings: "remote" });
  assert.deepEqual(navigate(opened, { type: "go", to: DESK, settingsAtStart: "remote" }), { page: "desk", settings: null });
  assert.deepEqual(navigate({ ...ROUTINES, settings: null }, { type: "go", to: DESK, settingsAtStart: "general" }), { page: "desk", settings: null });
});

test("leaving goes back to the desk, and a board leaves only for its own folder", () => {
  assert.deepEqual(navigate({ ...board("/repo", 3), settings: "boards" }, { type: "leave" }), { page: "desk", settings: null });
  const shown = board("/repo", 3);
  assert.equal(navigate(shown, { type: "leave", board: "/other" }), shown);
  assert.deepEqual(navigate(shown, { type: "leave", board: "/repo" }), { page: "desk", settings: null });
  const routines: View = { ...ROUTINES, settings: null };
  assert.equal(navigate(routines, { type: "leave", board: "/repo" }), routines);
});

test("settings open and close over the page", () => {
  const shown = board("/repo", 3);
  assert.deepEqual(navigate(shown, { type: "settings", tab: "providers" }), { ...shown, settings: "providers" });
  assert.deepEqual(navigate({ ...shown, settings: "providers" }, { type: "settings", tab: null }), shown);
});

test("a ticket is picked only on a board", () => {
  assert.deepEqual(navigate(board("/repo"), { type: "task", taskId: "abc" }), board("/repo", "abc"));
  const desk: View = { ...DESK, settings: null };
  assert.equal(navigate(desk, { type: "task", taskId: "abc" }), desk);
});

test("the address names the page, and reading it back gives the page", () => {
  for (const page of [DESK, ROUTINES, { page: "board", cwd: "/repo", taskId: 12 }, { page: "board", cwd: "/repo", taskId: null }] as const) {
    assert.deepEqual(pageFromSearch(searchFor(page)), page);
  }
  assert.equal(searchFor(DESK), "");
  assert.equal(searchFor(ROUTINES), "?routines");
  assert.deepEqual(pageFromSearch(searchFor(NEEDS)), NEEDS);
  assert.deepEqual(viewFromSearch("?cwd=%2Frepo&routines"), board("/repo"));
  assert.deepEqual(viewFromSearch("?routines"), { page: "routines", settings: null });
});
