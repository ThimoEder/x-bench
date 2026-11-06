import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLaunchToken, injectToken, removeTokenFile, writeTokenFile } from "./launchToken.ts";
import { xBenchPaths } from "./paths.ts";

test("each launch gets a new token", () => {
  const token = createLaunchToken();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(createLaunchToken(), token);
});

test("the token goes into the page head as a meta tag", () => {
  const html = injectToken("<html>\n  <head>\n    <title>X</title>\n  </head>\n</html>", "abc");
  assert.match(html, /<meta name="x-bench-token" content="abc" \/>\n {2}<\/head>/);
  assert.match(injectToken("<p>no head</p>", "abc"), /^<meta name="x-bench-token" content="abc" \/>/);
});

test("the token file is readable only by the user, and a newer host's file is left alone", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "x-bench-token-"));
  try {
    const file = xBenchPaths(home).launchToken(8787);
    assert.equal(file, path.join(home, ".x-bench", "launch-token-8787"));
    writeTokenFile(file, "first");
    assert.equal(fs.readFileSync(file, "utf8"), "first\n");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    writeTokenFile(file, "second");
    removeTokenFile(file, "first");
    assert.equal(fs.readFileSync(file, "utf8"), "second\n");
    removeTokenFile(file, "second");
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
