import assert from "node:assert/strict";
import test from "node:test";
import { AgentProcess } from "./runtime.ts";

test("a grok that is not installed fails to start, and the host keeps running", async () => {
  await assert.rejects(AgentProcess.start({ command: "/nonexistent/grok" }), /exited before listening\nspawn \/nonexistent\/grok ENOENT/);
});
