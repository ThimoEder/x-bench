// The Codex adapter stand-in for tests: the fake agent on stdin and stdout, like codex-acp.
// Run: node bridge/testing/fakeChatGpt.ts <store.json>

import { CHATGPT_DIALECT } from "./fakeAgent.ts";
import { runFakeAdapter } from "./fakeAdapter.ts";

runFakeAdapter(CHATGPT_DIALECT, process.argv[2] ?? "");
