import assert from "node:assert/strict";
import test from "node:test";
import { stderrTail } from "../adapter.ts";
import { INFO_LOG } from "./provider.ts";

const infoLogs = [
  "[session/create] sessionId=f2107a94-1c2d phase=ultracode durationMs=87 totalMs=1573",
  "[session/query] sessionId=b663c712 resume=none apiType=native baseUrl=native",
  "[authStatus] discarding a probe that predates the latest auth change",
].join("\n");

test("claude: the stopped reason skips the adapter's info logs and keeps its errors", () => {
  assert.equal(stderrTail(`${infoLogs}\n`, INFO_LOG), "");
  assert.equal(stderrTail(`[providers/set] Model listing failed\n${infoLogs}\n`, INFO_LOG), ": [providers/set] Model listing failed");
});
