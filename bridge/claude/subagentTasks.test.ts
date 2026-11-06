// Checks the adapter patch in patches/: a background subagent is reported as a background task.
import assert from "node:assert/strict";
import test from "node:test";
import { AsyncTaskRuntime } from "@agentclientprotocol/claude-agent-acp/dist/async-tasks.js";

type Sent = { update: { sessionUpdate: string; asyncTaskId?: string; state?: unknown } };

function runtime(nativeSubagents: boolean) {
  const sent: Sent[] = [];
  const tasks = new AsyncTaskRuntime(true, "s1", async (notification: Sent) => void sent.push(notification), { nativeSubagents });
  return { tasks, sent };
}

const started = (task_id: string, is_backgrounded: boolean) => ({ task_id, task_type: "local_agent", subagent_type: "general-purpose", description: "Port the AI", is_backgrounded, tool_use_id: `toolu_${task_id}` });

test("claude: a background subagent runs as a background task until it ends", async () => {
  const { tasks, sent } = runtime(false);
  await tasks.taskStarted(started("a1", true));
  await tasks.taskNotification({ task_id: "a1", status: "completed", summary: "done" });
  assert.deepEqual(
    sent.map(({ update }) => [update.sessionUpdate, update.asyncTaskId, update.state]),
    [
      ["async_task_spawned", "a1", undefined],
      ["async_task_state_update", "a1", "completed"],
    ],
  );
});

test("claude: a finished subagent that Claude resumes runs again until it ends", async () => {
  const { tasks, sent } = runtime(false);
  await tasks.taskStarted(started("a4", true));
  await tasks.taskNotification({ task_id: "a4", status: "completed" });
  await tasks.taskResumed("a4");
  await tasks.taskNotification({ task_id: "a4", status: "completed" });
  assert.deepEqual(
    sent.map(({ update }) => update.state ?? update.sessionUpdate),
    ["async_task_spawned", "completed", "running", "completed"],
  );
});

test("claude: a foreground subagent stays its tool call's row", async () => {
  const { tasks, sent } = runtime(false);
  await tasks.taskStarted(started("a2", false));
  await tasks.backgroundTasksChanged([{ task_id: "a2", task_type: "local_agent" }]);
  await tasks.taskNotification({ task_id: "a2", status: "completed" });
  assert.deepEqual(sent, []);
});

test("claude: with native subagent sessions the adapter leaves subagents out of the tasks", async () => {
  const { tasks, sent } = runtime(true);
  await tasks.taskStarted(started("a3", true));
  assert.deepEqual(sent, []);
});
