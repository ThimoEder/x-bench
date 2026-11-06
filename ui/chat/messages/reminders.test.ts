import assert from "node:assert/strict";
import test from "node:test";
import { userMessageView } from "./reminders.ts";

const finished = `<system-reminder>
Background task "01a0cb49-1cb3-7972-a2d8-0dac42e6430e" completed (exit code: 0).
Description: Start a fresh app server on port 8799 | Duration: 159.6s
Use get_command_or_subagent_output("01a0cb49-1cb3-7972-a2d8-0dac42e6430e") to see the full output.
</system-reminder>`;

test("a finished background task becomes a completion chip", () => {
  assert.deepEqual(userMessageView(finished), {
    spoken: "",
    harnessOnly: true,
    notice: { title: "Task completed", tone: "ok", detail: "Start a fresh app server on port 8799 · 159.6s" },
  });
});

test("a nonzero exit and a killed task get their own chip titles", () => {
  const failed = `<system-reminder>
Background task "call-1" completed (exit code: 137).
Description: Start the X Bench dev server | Duration: 887.4s
Use get_command_or_subagent_output("call-1") to see the full output.
</system-reminder>`;
  const stopped = `<system-reminder>
Background task "call-2" completed (terminated by signal killed).
Command: ./sak serve --db sak.db --bind 127.0.0.1 --port 4345 | Duration: 1242.7s
This task was killed by the user — do not restart it.
Use get_command_or_subagent_output("call-2") to see the full output.
</system-reminder>`;
  assert.equal(userMessageView(failed).notice?.title, "Task failed");
  assert.equal(userMessageView(failed).notice?.tone, "fail");
  assert.equal(userMessageView(failed).notice?.detail, "Start the X Bench dev server · 887.4s");
  assert.equal(userMessageView(stopped).notice?.title, "Task stopped");
  assert.equal(userMessageView(stopped).notice?.tone, "quiet");
  assert.equal(userMessageView(stopped).notice?.detail, "./sak serve --db sak.db --bind 127.0.0.1 --port 4345 · 1242.7s");
});

test("a wrapped task header and a monitor ending still parse", () => {
  const wrapped = `<system-reminder>
Background task "01a0cb49-1cb3-7972-a2d8-0dac42e6430e"
completed (exit code: 0).
Description: Start a fresh app server on port 8799 | Duration: 159.6s
</system-reminder>`;
  const monitor = `<system-reminder>
Monitor "01a0c697-b119-7ee1-abc1-7e7f085ea1b4" ended: [monitor ended: killed by signal signal 15].
Description: Watch x_bench UI on :8787 | Duration: 1533.6s
Use get_command_or_subagent_output("01a0c697-b119-7ee1-abc1-7e7f085ea1b4") for full output.
</system-reminder>`;
  assert.equal(userMessageView(wrapped).notice?.title, "Task completed");
  assert.equal(userMessageView(wrapped).notice?.tone, "ok");
  assert.equal(userMessageView(monitor).notice?.title, "Monitor ended");
  assert.equal(userMessageView(monitor).notice?.tone, "quiet");
  assert.equal(userMessageView(monitor).notice?.detail, "Watch x_bench UI on :8787 · 1533.6s");
});

test("a skills reminder stays out of the thread and a real prompt stays a prompt", () => {
  const skills = "<system-reminder>\nThe following skills are available for use:\n- find-skills\n</system-reminder>";
  assert.deepEqual(userMessageView(skills), { spoken: "", notice: null, harnessOnly: true });
  assert.deepEqual(userMessageView("please look at the port"), {
    spoken: "please look at the port",
    notice: null,
    harnessOnly: false,
  });
});

test("a prompt that also carries a task note keeps the prompt and the chip", () => {
  const mixed = `restarted, thanks\n\n${finished}`;
  const view = userMessageView(mixed);
  assert.equal(view.spoken, "restarted, thanks");
  assert.equal(view.harnessOnly, false);
  assert.equal(view.notice?.title, "Task completed");
});

const notification = (status: string, summary: string) => `<task-notification>
<task-id>ba1r74y0j</task-id>
<tool-use-id>toolu_01</tool-use-id>
<output-file>/tmp/tasks/ba1r74y0j.output</output-file>
<status>${status}</status>
<summary>${summary}</summary>
</task-notification>`;

test("Claude Code's task notification becomes a chip named after the command", () => {
  assert.deepEqual(userMessageView(notification("completed", 'Background command "Wait 20 seconds" completed (exit code 0)')), {
    spoken: "",
    harnessOnly: true,
    notice: { title: "Task completed", tone: "ok", detail: "Wait 20 seconds" },
  });
});

test("a task notification with a nonzero exit, a failure, a kill or a stop gets its own chip title", () => {
  const nonzero = userMessageView(notification("completed", 'Background command "npm test" completed (exit code 1)')).notice;
  const failed = userMessageView(notification("failed", 'Background command "npm run build" failed with exit code 2')).notice;
  const killed = userMessageView(notification("killed", 'Background command "Start the dev server" was stopped')).notice;
  const stopped = userMessageView(notification("stopped", 'Background command "Watch the build" was stopped')).notice;
  assert.deepEqual(nonzero, { title: "Task failed", tone: "fail", detail: "npm test" });
  assert.deepEqual(failed, { title: "Task failed", tone: "fail", detail: "npm run build" });
  assert.deepEqual(killed, { title: "Task stopped", tone: "quiet", detail: "Start the dev server" });
  assert.deepEqual(stopped, { title: "Task stopped", tone: "quiet", detail: "Watch the build" });
});

test("a task notification keeps quotes in the command name and reads escaped characters", () => {
  const view = userMessageView(notification("completed", 'Background command "grep &quot;a &amp; b&quot; &lt; in.txt" completed (exit code 0)'));
  assert.equal(view.notice?.detail, 'grep "a & b" < in.txt');
});

test("a task notification beside system reminders is still a harness note", () => {
  const reminder = "<system-reminder>\nThe following skills are available for use:\n- find-skills\n</system-reminder>";
  const view = userMessageView(`${reminder}\n${notification("completed", 'Background command "Wait 20 seconds" completed (exit code 0)')}\n${reminder}`);
  assert.equal(view.harnessOnly, true);
  assert.equal(view.spoken, "");
  assert.equal(view.notice?.title, "Task completed");
});

test("a subagent's task notification shows nothing and a monitor's shows a monitor chip", () => {
  const agent = userMessageView(notification("completed", 'Agent "Review the diff" finished'));
  const monitor = userMessageView(notification("completed", 'Monitor "Watch the log" stream ended'));
  assert.deepEqual(agent, { spoken: "", notice: null, harnessOnly: true });
  assert.deepEqual(monitor.notice, { title: "Monitor ended", tone: "quiet", detail: "Watch the log" });
  assert.equal(monitor.harnessOnly, true);
});

test("a task notification inside a system reminder still becomes a chip", () => {
  const wrapped = `<system-reminder>\n${notification("failed", 'Background command "npm test" failed with exit code 1')}\n</system-reminder>`;
  assert.deepEqual(userMessageView(wrapped), {
    spoken: "",
    harnessOnly: true,
    notice: { title: "Task failed", tone: "fail", detail: "npm test" },
  });
});
