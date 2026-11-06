import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { spawnStdioAgent } from "./stdio.ts";

const ignoresStdinEnd = "process.stdin.resume(); setInterval(() => {}, 1000)";
const agent = `
const child = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(ignoresStdinEnd)}], { stdio: ["pipe", "ignore", "ignore"] });
process.stdout.write(JSON.stringify({ grandchild: child.pid }) + "\\n", () => process.exit(0));
`;

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("an agent that exits on its own takes the processes it started with it", async (t) => {
  const stdio = spawnStdioAgent({ command: process.execPath, args: ["-e", agent], env: process.env });
  const { promise: started, resolve } = Promise.withResolvers<number>();
  stdio.transport.setHandlers({ onMessage: (line) => resolve(JSON.parse(String(line)).grandchild), onClose() {} });
  const pid = await started;
  t.after(() => {
    if (alive(pid)) process.kill(pid, "SIGKILL");
  });
  await stdio.exited;
  const deadline = Date.now() + 3000;
  while (alive(pid) && Date.now() < deadline) await delay(50);
  assert.equal(alive(pid), false);
});
