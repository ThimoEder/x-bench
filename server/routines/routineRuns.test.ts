import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRoutineRunStore, MAX_RUNS } from "./routineRuns.ts";

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x-bench-runs-"));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "routine-runs.json");
}

const started = (sessionId: string) => ({ trigger: "schedule" as const, startedAt: "2026-10-03T07:00:00.000Z", status: "started" as const, sessionId });

test("the history keeps the newest runs, and every run's chat stays known after it leaves", () => {
  const runs = createRoutineRunStore(scratch());
  for (let index = 1; index <= MAX_RUNS + 5; index += 1) runs.add("r1", started(`s${index}`));
  runs.handle("r1", "2026-10-03T09:00", { trigger: "schedule", startedAt: "2026-10-03T07:00:00.000Z", status: "skipped", reason: "The last run is still going" });
  assert.equal(runs.runs("r1").length, MAX_RUNS);
  assert.equal(runs.runs("r1")[0]?.status, "skipped");
  assert.equal(runs.sessionIds().size, MAX_RUNS + 5);
  assert.ok(runs.sessionIds().has("s1"), "the oldest run's chat is still known");
  runs.drop("r1");
  assert.equal(runs.sessionIds().size, 0);
});

test("a file from before the session list names its runs' chats", () => {
  const file = scratch();
  fs.writeFileSync(file, JSON.stringify({ routines: { r1: { runs: [{ id: "a", ...started("old") }] } } }));
  const runs = createRoutineRunStore(file);
  assert.deepEqual([...runs.sessionIds()], ["old"]);
  runs.add("r1", started("new"));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).routines.r1.sessions, ["old", "new"]);
});

test("a deleted chat leaves its run in the history without a link", () => {
  const runs = createRoutineRunStore(scratch());
  runs.add("r1", { ...started("s1"), cwd: "/wt" });
  runs.dropSession("s1");
  const [run] = runs.runs("r1");
  assert.deepEqual([run?.status, run?.sessionId, run?.cwd], ["started", undefined, undefined]);
  assert.equal(runs.findSession("s1"), null);
});
