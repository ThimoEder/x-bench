// The Claude adapter stand-in for tests: the fake agent on stdin and stdout, like claude-agent-acp.
// Run: node bridge/testing/fakeClaude.ts <store.json>

import { CLAUDE_DIALECT } from "./fakeAgent.ts";
import { runFakeAdapter } from "./fakeAdapter.ts";

runFakeAdapter(CLAUDE_DIALECT, process.argv[2] ?? "", (store) => {
  // Which account this start runs on, so a test can see that a restart keeps it.
  store.configDirs = [...(store.configDirs ?? []), process.env.CLAUDE_CONFIG_DIR ?? ""];
});
