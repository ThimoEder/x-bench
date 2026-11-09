import assert from "node:assert/strict";
import test from "node:test";
import { adapterEnvironment, setShellEnvironment, stderrTail } from "./adapter.ts";

test("stderrTail keeps the last two lines that skip does not match", () => {
  assert.equal(stderrTail("one\n\ntwo\nthree\n"), ": two three");
  assert.equal(stderrTail("  \n"), "");
  assert.equal(stderrTail("error\nnoise 1\nnoise 2\n", /^noise/), ": error");
});

test("agents start from the login shell's environment, under the app's PATH, HOME, X_BENCH_* and extra", () => {
  process.env.X_BENCH_TEST_OWN = "app";
  setShellEnvironment({ PATH: "/shell/bin", HOME: "/Users/shell", X_BENCH_TEST_OWN: "shell", CLAUDE_CODE_OAUTH_TOKEN: "secret", NODE_OPTIONS: "--inspect", CLAUDE_CONFIG_DIR: "/shell/claude" });
  try {
    const env = adapterEnvironment({ CLAUDE_CONFIG_DIR: "/settings/claude" });
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "secret");
    assert.equal(env.NODE_OPTIONS, "--inspect");
    assert.equal(env.CLAUDE_CONFIG_DIR, "/settings/claude");
    assert.equal(env.PATH, process.env.PATH);
    assert.equal(env.HOME, process.env.HOME);
    assert.equal(env.X_BENCH_TEST_OWN, "app");
  } finally {
    delete process.env.X_BENCH_TEST_OWN;
    setShellEnvironment({});
  }
});
