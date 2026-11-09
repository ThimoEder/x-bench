import assert from "node:assert/strict";
import test from "node:test";
import { runningTasks } from "./tasks.ts";

const prompt = { type: "user", text: "please launch a subtask so i can see it working in the task list" };

test("a running subagent is listed by its description", () => {
  const started = {
    id: "tool:call-1",
    type: "tool",
    status: "in_progress",
    title: "spawn_subagent",
    role: "subagent" as const,
    label: "Example running subtask",
  };
  const named = { ...started, title: "Example running subtask" };
  const session = { status: "running", transcript: [prompt, named] };
  assert.deepEqual(runningTasks({ status: "running", transcript: [prompt, started] }), [
    { id: "tool:call-1", label: "Example running subtask", agent: true, rowId: "tool:call-1" },
  ]);
  assert.deepEqual(runningTasks(session), [{ id: "tool:call-1", label: "Example running subtask", agent: true, rowId: "tool:call-1" }]);
  assert.deepEqual(runningTasks({ ...session, transcript: [prompt, { ...named, status: "completed" }] }), []);
  assert.deepEqual(runningTasks({ ...session, status: "idle" }), []);
});

test("a background command still in progress is listed from the transcript", () => {
  const session = {
    status: "running",
    transcript: [
      {
        id: "tool:restart",
        type: "tool",
        status: "in_progress",
        title: "Execute `npm run dev`",
        role: "shell" as const,
        command: "npm run dev",
        label: "Restart the X Bench dev server",
        background: true,
      },
    ],
  };
  assert.deepEqual(runningTasks(session), [{ id: "tool:restart", label: "Restart the X Bench dev server", agent: false }]);
  const tool = session.transcript[0];
  assert.ok(tool);
  assert.deepEqual(runningTasks({ ...session, transcript: [{ ...tool, status: "completed" }] }), []);
});

test("a background server stays listed after the turn goes idle", () => {
  const session = {
    status: "idle",
    transcript: [
      {
        id: "tool:run",
        type: "tool",
        status: "completed",
        title: "npm run dev",
        role: "shell" as const,
        command: "npm run dev",
        background: true,
      },
    ],
    backgroundTasks: [
      { id: "task-1", status: "running", kind: "bash", label: "Start the UI server" },
      { id: "task-2", status: "completed", kind: "bash", label: "Finished build" },
      { id: "task-3", status: "running", kind: "monitor", label: "Watch the UI on port 8787", canStop: false as const },
    ],
  };
  assert.deepEqual(runningTasks(session), [
    { id: "task-1", label: "Start the UI server", agent: false },
    { id: "task-3", label: "Watch the UI on port 8787", agent: false, canStop: false },
  ]);
});

test("a subagent in the background is listed once, by its task, with its newest step", () => {
  const agent = { id: "tool:agent-1", type: "tool", toolCallId: "agent-1", status: "completed", title: "Port the AI", role: "subagent" as const, label: "Port the AI", background: true };
  const step = (id: string, title: string) => ({ id: `tool:${id}`, type: "tool", toolCallId: id, status: "completed", role: "read" as const, title, parentId: "agent-1" });
  const session = {
    status: "running",
    transcript: [prompt, agent, step("read-1", "Read driver.c"), step("read-2", "Read path.c")],
    backgroundTasks: [
      { id: "a1b2", status: "running", kind: "local_agent", label: "Reading path.c", toolCallId: "agent-1" },
      { id: "a3c4", status: "running", kind: "local_agent", label: "Review the HUD" },
    ],
  };
  assert.deepEqual(runningTasks(session), [
    { id: "a1b2", label: "Port the AI", agent: true, step: "Read path.c", rowId: "tool:agent-1" },
    { id: "a3c4", label: "Review the HUD", agent: true },
  ]);
  // A subagent inside it shows in its card, so its entry leads there.
  const inner = { ...agent, id: "tool:agent-2", toolCallId: "agent-2", title: "Read the tests", label: "Read the tests", status: "in_progress", parentId: "agent-1" };
  assert.equal(runningTasks({ status: "running", transcript: [prompt, agent, inner] }).at(0)?.rowId, "tool:agent-1");
  // Moved to the background while its Agent call still runs: still one entry, stopped by its task.
  const moved = { ...session, transcript: [prompt, { ...agent, status: "in_progress" }] };
  assert.deepEqual(runningTasks(moved).map((task) => task.id), ["a1b2", "a3c4"]);
});

test("the prompt, plan entries, and ordinary tools are not subtasks", () => {
  const session = {
    status: "running",
    plan: [{ content: "Retest the shell fixes", status: "in_progress" }],
    transcript: [
      prompt,
      { id: "tool:read", type: "tool", status: "in_progress", role: "read" as const, title: "Read App.jsx" },
      { id: "tool:run", type: "tool", status: "in_progress", role: "shell" as const, title: "Run npm test", command: "npm test" },
    ],
  };
  assert.deepEqual(runningTasks(session), []);
});
