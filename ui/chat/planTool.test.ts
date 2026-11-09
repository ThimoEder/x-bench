import assert from "node:assert/strict";
import test from "node:test";
import { isPlanTool } from "./planTool.ts";

test("the host's update_plan rows are known under each harness's name, and no other tool is", () => {
  for (const title of ["mcp__x_bench__update_plan", "x_bench.update_plan", "X Bench Update Plan"]) assert.equal(isPlanTool(title), true, title);
  for (const title of ["update_plan", "mcp__other__update_plan", "mcp__x_bench__suggest_task", "rg mcp__x_bench__update_plan server ui", "Read x_bench/update_plan.ts", undefined]) assert.equal(isPlanTool(title), false, String(title));
});
