// Live check that the bridge can speak to `grok agent serve`.
// One short prompt, then the process and its session directory are removed.

import os from "node:os";
import path from "node:path";
import { mkdirSync, readdirSync, rmSync, existsSync } from "node:fs";
import { GrokProvider } from "./grok/provider.ts";

const cwd = path.join(os.tmpdir(), "x-bench-bridge-smoke");
mkdirSync(cwd, { recursive: true });

const bridge = new GrokProvider({
  promptTimeoutMs: 90000,
  readyTimeoutMs: 20000,
});

let sessionId = null;
try {
  await bridge.start();
  const session = await bridge.createSession({ cwd });
  sessionId = session.id;
  const finished = await bridge.prompt(session.id, "Reply with exactly: pong\nDo not use any tools.");
  const assistant = finished.transcript
    .filter((item) => item.type === "assistant")
    .map((item) => item.text)
    .join("");
  if (finished.stopReason !== "end_turn" || !assistant.includes("pong")) {
    console.error(JSON.stringify({ stopReason: finished.stopReason, assistant, status: finished.status }, null, 2));
    process.exitCode = 1;
  } else {
    console.log(`session ${session.id}`);
    console.log(`stop ${finished.stopReason}`);
    console.log(`assistant ${JSON.stringify(assistant)}`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await bridge.stop();
  if (sessionId) removeSession(sessionId);
}

function removeSession(sessionId) {
  const root = path.join(os.homedir(), ".grok", "sessions");
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root)) {
    const dir = path.join(root, entry, sessionId);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
}
