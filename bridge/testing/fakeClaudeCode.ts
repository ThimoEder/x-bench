// The Claude Code stand-in for usage reads: it answers the Agent SDK's control requests on stdin and stdout.
// Run: node bridge/testing/fakeClaudeCode.ts <starts file> <mode>. The mode is the 5-hour percent, "slow" for
// 29% after 400 ms, "apikey" for an account without plan limits, "fail" for an error answer, or "silent" for
// no answer to get_usage.

import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [file = "", mode = "12"] = process.argv.slice(2);
if (file) appendFileSync(file, "start\n");

const send = (message: object) => process.stdout.write(`${JSON.stringify(message)}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line) as { type?: string; request_id?: string; request?: { subtype?: string } };
  if (message.type !== "control_request") return;
  const id = message.request_id;
  if (message.request?.subtype !== "get_usage") {
    send({ type: "control_response", response: { subtype: "success", request_id: id, response: {} } });
    return;
  }
  if (mode === "silent") return;
  if (mode === "fail") {
    send({ type: "control_response", response: { subtype: "error", request_id: id, error: "usage endpoint failed" } });
    return;
  }
  const percent = mode === "slow" ? 29 : Number(mode);
  const usage = mode === "apikey"
    ? { subscription_type: null, rate_limits_available: false, rate_limits: null }
    : {
        subscription_type: "max",
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: percent, resets_at: "2026-10-05T03:40:00.077835+00:00" },
          seven_day: { utilization: 49, resets_at: "2026-10-10T11:00:00.077856+00:00" },
          seven_day_opus: { utilization: 95, resets_at: "2026-10-10T11:00:00+00:00" },
        },
      };
  const answer = () => send({ type: "control_response", response: { subtype: "success", request_id: id, response: usage } });
  if (mode === "slow") setTimeout(answer, 400);
  else answer();
});
