import assert from "node:assert/strict";
import test from "node:test";
import { planOpensTab, planTabMemory } from "./planTab.ts";

test("a plan that starts while its session is in view and running opens the Plan tab, once", () => {
  const memory = planTabMemory();
  assert.equal(planOpensTab(memory, "a", null, true), false);
  assert.equal(planOpensTab(memory, "a", "plan-1", true), true);
  assert.equal(planOpensTab(memory, "a", "plan-1", true), false);
  assert.equal(planOpensTab(memory, "a", "plan-2", true), true);
});

test("switching to a running session that already has a plan, or has a new one, leaves the tab alone", () => {
  const memory = planTabMemory();
  assert.equal(planOpensTab(memory, "a", null, false), false);
  assert.equal(planOpensTab(memory, "b", "plan-9", true), false);
  assert.equal(planOpensTab(memory, "a", null, false), false);
  // Back on b: the plan it had is known.
  assert.equal(planOpensTab(memory, "b", "plan-9", true), false);
  // A plan b wrote while the dock showed a: a switch, so no jump.
  assert.equal(planOpensTab(memory, "a", null, false), false);
  assert.equal(planOpensTab(memory, "b", "plan-10", true), false);
});

test("a reload of the running session, where the plan id goes away and comes back, does not reopen the tab", () => {
  const memory = planTabMemory();
  planOpensTab(memory, "a", null, true);
  assert.equal(planOpensTab(memory, "a", "plan-1", true), true);
  assert.equal(planOpensTab(memory, "a", null, true), false);
  assert.equal(planOpensTab(memory, "a", "plan-1", true), false);
});

test("a plan that appears while the session is idle does not open the tab", () => {
  const memory = planTabMemory();
  planOpensTab(memory, "a", null, false);
  assert.equal(planOpensTab(memory, "a", "plan-1", false), false);
});
