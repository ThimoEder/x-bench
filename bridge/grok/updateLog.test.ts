import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { imagesFromUpdates, readSessionUpdateLog } from "./updateLog.ts";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("readSessionUpdateLog returns one session's update messages", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-images-"));
  try {
    const dir = path.join(root, "group", "sess");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "updates.jsonl"), '{"method":"session/update"}\nnot-json\n');
    assert.equal((await readSessionUpdateLog(root, "sess")).length, 1);
    assert.equal((await readSessionUpdateLog(root, "missing")).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("imagesFromUpdates keeps a screenshot stored on a tool result", () => {
  const { byTool } = imagesFromUpdates([
    {
      method: "session/update",
      params: {
        sessionId: "s",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-shot",
          status: "completed",
          content: [{ type: "content", content: { type: "image", data: png, mimeType: "image/png" } }],
        },
      },
    },
  ]);
  assert.equal(byTool.get("call-shot")?.[0]?.mimeType, "image/png");
  assert.equal(byTool.get("call-shot")?.[0]?.data, png);
});

test("imagesFromUpdates keeps a picture sent with no caption", () => {
  const { byPrompt } = imagesFromUpdates([
    {
      method: "session/update",
      params: {
        sessionId: "s",
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "image", data: png, mimeType: "image/png" },
          _meta: { promptIndex: 10 },
        },
      },
    },
  ]);
  assert.equal(byPrompt.get(10)?.[0]?.data, png);
  assert.equal(byPrompt.get(10)?.[0]?.mimeType, "image/png");
});
