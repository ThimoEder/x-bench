import assert from "node:assert/strict";
import test from "node:test";
import { cycleIn, finishes, needsOf, nextStarts, type PlanItem } from "./queuePlan.ts";

function item(id: string, needs: string[] = [], state: PlanItem["state"] = "queued"): PlanItem {
  return { id, needs, state };
}

const ids = (items: PlanItem[]) => items.map((entry) => entry.id);

test("a ticket's needs are the tickets it is blocked by or follows", () => {
  const related = [
    { id: 1, relation: "blocked_by" },
    { id: "APP-2", relation: "follows" },
    { id: 3, relation: "blocks" },
    { id: 4, relation: "relates" },
    { id: 5, relation: null },
    { id: 1, relation: "follows" },
  ];
  assert.deepEqual(needsOf(related), ["1", "APP-2"]);
});

test("a sub-ticket starts once none of its needs is open", () => {
  const items = [item("1"), item("2", ["1"]), item("3", ["2"])];
  assert.deepEqual(ids(nextStarts(items, new Set(), 3, 0)), ["1"]);
  assert.deepEqual(ids(nextStarts([item("1", [], "started"), items[1]!, items[2]!], new Set(), 3, 1)), []);
  assert.deepEqual(ids(nextStarts([item("1", [], "done"), items[1]!, items[2]!], new Set(), 3, 0)), ["2"]);
});

test("a failed ticket holds back only the tickets that wait on it", () => {
  const items = [item("1", [], "failed"), item("2", ["1"]), item("3")];
  assert.deepEqual(ids(nextStarts(items, new Set(), 3, 0)), ["3"]);
});

test("an open prerequisite outside the queue holds its ticket back", () => {
  const items = [item("1", ["90"]), item("2")];
  assert.deepEqual(ids(nextStarts(items, new Set(["90"]), 3, 0)), ["2"]);
  assert.deepEqual(ids(nextStarts(items, new Set(), 3, 0)), ["1", "2"]);
});

test("tickets without relations start in list order, as many as there are free slots", () => {
  const items = [item("1"), item("2"), item("3"), item("4")];
  assert.deepEqual(ids(nextStarts(items, new Set(), 2, 0)), ["1", "2"]);
  assert.deepEqual(ids(nextStarts(items, new Set(), 2, 1)), ["1"]);
  assert.deepEqual(ids(nextStarts(items, new Set(), 2, 2)), []);
  assert.deepEqual(ids(nextStarts(items, new Set(), 2, 5)), []);
});

test("a cycle is named along its tickets", () => {
  assert.equal(cycleIn([item("1"), item("2", ["1"]), item("3", ["1", "2"])]), null);
  assert.deepEqual(cycleIn([item("1", ["3"]), item("2", ["1"]), item("3", ["2"])]), ["1", "3", "2", "1"]);
  assert.deepEqual(cycleIn([item("1"), item("2", ["2"])]), ["2", "2"]);
  assert.equal(cycleIn([item("1", ["90"])]), null);
});

test("a pull request finishes its ticket by the run's mode", () => {
  const pr = (status: string, draft = false) => ({ status, ...(draft ? { draft } : {}) });
  assert.equal(finishes("merged", pr("ready")), false);
  assert.equal(finishes("merged", pr("merged")), true);
  assert.equal(finishes("pr", pr("ready")), true);
  assert.equal(finishes("pr", pr("failing")), true);
  assert.equal(finishes("pr", pr("draft", true)), false);
  assert.equal(finishes("pr", pr("draft")), false);
  // A draft's status reads as its checks while they run.
  assert.equal(finishes("pr", pr("running", true)), false);
  assert.equal(finishes("pr", pr("closed")), false);
  assert.equal(finishes("pr", pr("merged")), true);
  assert.equal(finishes("pr", undefined), false);
});
