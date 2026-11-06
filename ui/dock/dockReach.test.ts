import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAT_MIN,
  DOCK_LIMIT,
  DOCK_MIN,
  dockCap,
  shownDock,
  storedDock,
  REACH_DETENT,
  REACH_GIVE,
  dockWidthForPull,
  pullForDockWidth,
  reachDim,
  settleDockWidth,
} from "./dockReach.ts";

const FULL = 1400;

test("below the limit the dock follows the pointer", () => {
  assert.equal(dockWidthForPull(500, FULL), 500);
  assert.equal(dockWidthForPull(100, FULL), DOCK_MIN);
});

test("at the limit the edge holds and gives only a little", () => {
  assert.equal(dockWidthForPull(DOCK_LIMIT, FULL), DOCK_LIMIT);
  const held = dockWidthForPull(DOCK_LIMIT + REACH_DETENT / 2, FULL);
  assert.ok(held > DOCK_LIMIT && held < DOCK_LIMIT + REACH_GIVE);
  assert.equal(dockWidthForPull(DOCK_LIMIT + REACH_DETENT, FULL), DOCK_LIMIT + REACH_GIVE);
});

test("past the detent the dock follows the pointer again, up to the sidebar's edge", () => {
  assert.equal(dockWidthForPull(DOCK_LIMIT + REACH_DETENT + 100, FULL), DOCK_LIMIT + REACH_GIVE + 100);
  assert.equal(dockWidthForPull(5000, FULL), FULL);
});

test("a narrow workspace keeps the dock at the limit", () => {
  assert.equal(dockWidthForPull(DOCK_LIMIT + 300, 700), DOCK_LIMIT);
});

test("a drag that starts across the chat picks up where the dock is", () => {
  for (const width of [440, DOCK_LIMIT, 1000]) assert.equal(dockWidthForPull(pullForDockWidth(width), FULL), width);
});

test("a drag let go inside the detent falls back to the limit", () => {
  assert.equal(settleDockWidth(DOCK_LIMIT + REACH_GIVE / 2), DOCK_LIMIT);
  assert.equal(settleDockWidth(1000), 1000);
  assert.equal(settleDockWidth(500), 500);
});

test("the chat darkens as the dock reaches across it", () => {
  assert.equal(reachDim(DOCK_LIMIT, FULL), 0);
  assert.ok(reachDim(DOCK_LIMIT + 100, FULL) > 0);
  assert.equal(reachDim(FULL, FULL), reachDim(DOCK_LIMIT + 1000, FULL));
});

test("beside the chat the dock stops where the chat would drop below its minimum", () => {
  assert.equal(dockCap(2000), DOCK_LIMIT);
  assert.equal(dockCap(1000), 1000 - CHAT_MIN);
  assert.equal(dockCap(600), DOCK_MIN);
  assert.equal(dockCap(0), DOCK_LIMIT);
});

test("in a narrow window the edge holds where the dock stops, then the dock reaches across the chat", () => {
  const workspace = 1000;
  const cap = dockCap(workspace);
  assert.ok(cap < DOCK_LIMIT);
  assert.equal(dockWidthForPull(cap, workspace, cap), cap);
  const held = dockWidthForPull(cap + REACH_DETENT / 2, workspace, cap);
  assert.ok(held > cap && held < cap + REACH_GIVE);
  assert.equal(dockWidthForPull(cap + REACH_DETENT + 100, workspace, cap), cap + REACH_GIVE + 100);
});

test("a stored width beside the chat gives way to a narrower window and comes back in a wider one", () => {
  assert.equal(shownDock(DOCK_LIMIT, 1000), 1000 - CHAT_MIN);
  assert.equal(shownDock(DOCK_LIMIT, 2000), DOCK_LIMIT);
  assert.equal(shownDock(500, 2000), 500);
});

test("a reach is stored by its depth past the cap, so it reads back the same", () => {
  for (const workspace of [1000, 2000]) {
    const cap = dockCap(workspace);
    for (const shown of [400, cap, cap + 120]) assert.equal(shownDock(storedDock(shown, workspace), workspace), shown);
  }
  assert.equal(storedDock(dockCap(1000) + 120, 1000), DOCK_LIMIT + 120);
  assert.equal(shownDock(DOCK_LIMIT + 120, 2000), DOCK_LIMIT + 120);
});
