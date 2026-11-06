import { test } from "node:test";
import assert from "node:assert/strict";
import { composerRoutine } from "./routineLink.ts";

const projects = [{ cwd: "/repo", sessions: [{ id: "s1", cwd: "/repo/.worktrees/a" }] }];
const options = (model: string, effort = "") => [{ id: "model", currentValue: model }, { id: "effort", currentValue: effort }];

test("a routine from an open chat names its provider's model, its effort, its mode and its project", () => {
  const session = { id: "s1", cwd: "/repo/.worktrees/a", provider: "claude", modeId: "auto", configOptions: options("opus", "high") };
  assert.deepEqual(composerRoutine(session, "Check the build", false, projects), {
    prompt: "Check the build",
    chat: false,
    cwd: "/repo",
    picks: { model: "claude:opus", effort: "high" },
    mode: "auto",
  });
});

test("a routine from a draft takes the menu's own model value and no mode", () => {
  const draft = { id: "draft", cwd: "/repo", modeId: "full", configOptions: options("grok:grok-4") };
  assert.deepEqual(composerRoutine(draft, "Hi", true, projects), { prompt: "Hi", chat: true, cwd: "/repo", picks: { model: "grok:grok-4" } });
  assert.deepEqual(composerRoutine({ ...draft, configOptions: [] }, "Hi", false, []), { prompt: "Hi", chat: false, cwd: "/repo" });
});
