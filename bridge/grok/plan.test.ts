import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readPlan } from "./plan.ts";

test("readPlan reads plan.md and reports a missing plan", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "x-bench-plan-"));
  const cwd = "/work/app";
  const dir = path.join(root, encodeURIComponent(cwd), "sess");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "summary.json"), JSON.stringify({ info: { id: "sess", cwd } }));
  writeFileSync(path.join(dir, "plan.md"), "# Add hello\n\nOne sentence in the README.\n");

  assert.deepEqual(readPlan(cwd, "missing", root), { text: "", missing: true });
  const plan = readPlan(cwd, "sess", root);
  assert.match(plan.text, /Add hello/);
  assert.equal(plan.missing, false);
  rmSync(root, { recursive: true, force: true });
});
