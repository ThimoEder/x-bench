import assert from "node:assert/strict";
import test from "node:test";
import { workingLine } from "./activity.ts";

const now = 1_700_000_075_000;

test("a visible thought is thinking, counted from when it started", () => {
  const line = workingLine(
    {
      status: "running",
      transcript: [
        { id: "t1", type: "thought", text: "Looking", streaming: true, durationMs: 75_000 },
      ],
    },
    now,
  );
  assert.equal(line.label, "Thinking...");
  assert.equal(line.since, now - 75_000);
});

test("the bridge phase wins, including a clock that was already running", () => {
  const line = workingLine(
    {
      status: "running",
      activity: { label: "Reading", since: 1_700_000_000_000 },
      transcript: [{ id: "t1", type: "thought", text: "old", streaming: true, durationMs: 1_000 }],
    },
    now,
  );
  assert.equal(line.label, "Reading");
  assert.equal(line.since, 1_700_000_000_000);
});

test("a live command is not described as waiting", () => {
  const line = workingLine(
    {
      status: "running",
      transcript: [
        { id: "t1", type: "thought", text: "done", streaming: false, durationMs: 4_000 },
        {
          id: "tool:1",
          type: "tool",
          toolCallId: "1",
          title: "npm test",
          kind: "execute",
          status: "in_progress",
          rawInput: { command: "npm test" },
          role: "shell",
          command: "npm test",
          diffs: [],
          outputPreview: "",
        },
      ],
    },
    now,
  );
  assert.equal(line.label, "Running command");
});
