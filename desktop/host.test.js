import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { branchLabel, devAppEnv, devAppName, groupUpdate, hostNote, hostOrigin, importGraph, keepAwakeOf, labelArg, keepTail, listeningPort, logFile, envCommand, envFromShell, envMarker, hostShellEnv, loginShellEnv, route, watchedFolders } from "./host.js";

test("X_BENCH_URL accepts only http://127.0.0.1:<port>", () => {
  assert.equal(hostOrigin("http://127.0.0.1:8834"), "http://127.0.0.1:8834");
  assert.equal(hostOrigin("http://127.0.0.1:8834/"), "http://127.0.0.1:8834");
  for (const value of [
    "https://127.0.0.1:8834",
    "http://localhost:8834",
    "http://127.0.0.1",
    "http://127.0.0.1:8834/x",
    "http://127.0.0.1:8834/?a=1",
    "http://user@127.0.0.1:8834",
    "file:///etc/hosts",
    "not a url",
  ]) {
    assert.equal(hostOrigin(value), null, value);
  }
});

test("links to the host stay inside, other web links go outside, the rest is denied", () => {
  const origin = "http://127.0.0.1:8797";
  assert.equal(route("http://127.0.0.1:8797/api/state", origin), "inside");
  assert.equal(route("http://127.0.0.1:8787/", origin), "outside");
  assert.equal(route("https://github.com/x/y/pull/1", origin), "outside");
  assert.equal(route("file:///etc/hosts", origin), "deny");
  assert.equal(route("mailto:a@example.com", origin), "deny");
  assert.equal(route("javascript:alert(1)", origin), "deny");
  assert.equal(route("::", origin), "deny");
});

test("only a listening message with a valid port counts", () => {
  assert.equal(listeningPort({ type: "listening", port: 8797 }), 8797);
  assert.equal(listeningPort({ type: "listening", port: "8797" }), null);
  assert.equal(listeningPort({ type: "listening", port: 0 }), null);
  assert.equal(listeningPort({ type: "listening", port: 70000 }), null);
  assert.equal(listeningPort({ type: "stop" }), null);
  assert.equal(listeningPort(null), null);
});

test("only a grok or sak message with a real pid and a running flag counts, never 0, 1 or a group", () => {
  assert.deepEqual(groupUpdate({ type: "sak", pid: 4343, running: true }), { pid: 4343, running: true });
  assert.equal(groupUpdate({ type: "sak", pid: 1, running: true }), null);
  assert.equal(groupUpdate({ type: "other", pid: 4343, running: true }), null);
  assert.deepEqual(groupUpdate({ type: "grok", pid: 4242, running: true }), { pid: 4242, running: true });
  assert.deepEqual(groupUpdate({ type: "grok", pid: 4242, running: false }), { pid: 4242, running: false });
  assert.equal(groupUpdate({ type: "grok", pid: 4242 }), null);
  assert.equal(groupUpdate({ type: "grok", pid: 4242, running: "yes" }), null);
  assert.equal(groupUpdate({ type: "grok", pid: "4242", running: true }), null);
  assert.equal(groupUpdate({ type: "grok", pid: 0, running: true }), null);
  assert.equal(groupUpdate({ type: "grok", pid: 1, running: true }), null);
  assert.equal(groupUpdate({ type: "grok", pid: -4242, running: true }), null);
  assert.equal(groupUpdate({ type: "listening", port: 8797 }), null);
  assert.equal(groupUpdate(null), null);
});

test("the login environment is read between the markers, ignoring profile output and the shell's own variables", () => {
  assert.ok(envCommand().includes(envMarker));
  const zero = `Welcome back!\n${envMarker}PATH=/opt/homebrew/bin:/usr/bin\0NOTE=two\nlines\0EMPTY=\0PWD=/Users/me\0SHLVL=2\0_=/usr/bin/env\0DISABLE_AUTO_UPDATE=true\0${envMarker}`;
  assert.deepEqual(envFromShell(zero), { PATH: "/opt/homebrew/bin:/usr/bin", NOTE: "two\nlines", EMPTY: "" });
  const lines = `${envMarker}PATH=/usr/bin:/bin\nTOKEN=a=b\nOLDPWD=/tmp\n${envMarker}`;
  assert.deepEqual(envFromShell(lines), { PATH: "/usr/bin:/bin", TOKEN: "a=b" });
  assert.equal(envFromShell("no markers here"), null);
  assert.equal(envFromShell(`${envMarker}HOME=/Users/me\n${envMarker}`), null);
});

test("the login shell starts with a short environment that keeps profiles from asking", () => {
  assert.deepEqual(loginShellEnv({ HOME: "/Users/me", PATH: "/usr/bin", SHELL: "/bin/zsh", USER: "me", ZDOTDIR: "/Users/me/.config/zsh", NODE_OPTIONS: "--inspect", TMPDIR: "/tmp" }), {
    HOME: "/Users/me",
    PATH: "/usr/bin",
    SHELL: "/bin/zsh",
    USER: "me",
    ZDOTDIR: "/Users/me/.config/zsh",
    DISABLE_AUTO_UPDATE: "true",
    ZSH_DISABLE_COMPFIX: "true",
    SSH_ASKPASS_REQUIRE: "never",
  });
});

test("the host gets the login PATH and missing certificate settings, and the agents keep the rest", () => {
  const shell = { PATH: "/opt/homebrew/bin:/usr/bin", NODE_OPTIONS: "--inspect", CLAUDE_CODE_OAUTH_TOKEN: "secret", NODE_EXTRA_CA_CERTS: "/certs/shell.pem", SSL_CERT_FILE: "/certs/file.pem", ELECTRON_RUN_AS_NODE: "1" };
  assert.deepEqual(hostShellEnv(shell, { PATH: "/usr/bin", SSL_CERT_FILE: "/certs/app.pem" }), { PATH: "/opt/homebrew/bin:/usr/bin", NODE_EXTRA_CA_CERTS: "/certs/shell.pem" });
  assert.deepEqual(hostShellEnv(null, { PATH: "/usr/bin" }), { PATH: "/usr/bin" });
});

test("the output tail keeps the last characters", () => {
  assert.equal(keepTail("abc", "def", 4), "cdef");
  assert.equal(keepTail("", "hi"), "hi");
});

test("the log file is private and rolls over to .old once it passes its limit", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x-bench-log-"));
  try {
    const file = path.join(dir, "Logs", "output.log");
    const log = logFile(file, 10, () => "T");
    log("0123456789\n");
    log(Buffer.from("next\n"));
    assert.equal(fs.readFileSync(`${file}.old`, "utf8"), "T 0123456789\n");
    assert.equal(fs.readFileSync(file, "utf8"), "T next\n");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    logFile(file, 20, () => "T")("again\n");
    assert.equal(fs.readFileSync(file, "utf8"), "T next\nT again\n");
    logFile(file, 10, () => "T")("third\n");
    assert.equal(fs.readFileSync(`${file}.old`, "utf8"), "T next\nT again\n");
    assert.equal(fs.readFileSync(file, "utf8"), "T third\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("each log line starts with its time, also when a line or a character arrives in two chunks", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x-bench-log-"));
  try {
    const file = path.join(dir, "output.log");
    const log = logFile(file, 1000, () => "T");
    log("a\nb");
    log("c\n\nd\n");
    log(Buffer.from([0xc3]));
    log(Buffer.from([0xbc, 0x0a]));
    assert.equal(fs.readFileSync(file, "utf8"), "T a\nT bc\n\nT d\nT ü\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the import graph follows relative imports, static and dynamic, and keeps missing files", () => {
  const sources = {
    "/repo/server/index.ts": [
      'import http from "node:http";',
      'import { createApp } from "./app.ts";',
      'import type { Snapshot } from "./snapshot.ts";',
      'export { refs } from "../ui/refs.ts";',
      'const later = await import("./later.ts");',
      'import "./side.ts";',
    ].join("\n"),
    "/repo/server/app.ts": 'import { a } from "../bridge/acp.ts";\nimport { b } from "./index.ts";',
    "/repo/server/snapshot.ts": "",
    "/repo/ui/refs.ts": 'import { vite } from "vite";',
    "/repo/server/later.ts": "",
    "/repo/bridge/acp.ts": "",
  };
  const read = (file) => {
    if (!(file in sources)) throw new Error(`ENOENT ${file}`);
    return sources[file];
  };
  const files = importGraph("/repo/server/index.ts", read);
  assert.deepEqual([...files].sort(), [
    "/repo/bridge/acp.ts",
    "/repo/server/app.ts",
    "/repo/server/index.ts",
    "/repo/server/later.ts",
    "/repo/server/side.ts",
    "/repo/server/snapshot.ts",
    "/repo/ui/refs.ts",
  ]);
  assert.deepEqual(watchedFolders(files, "/repo").sort(), ["/repo/bridge", "/repo/server", "/repo/ui"]);
});

test("the watched folders leave out files outside the repo and at its top level", () => {
  assert.deepEqual(watchedFolders(new Set(["/elsewhere/x.ts", "/repo/vite.config.ts", "/repo/server/a/b.ts"]), "/repo"), ["/repo/server"]);
});

test("a branch name becomes the feature label, and the default branch has none", () => {
  assert.equal(branchLabel("worktree/browser-support-open-messaging-8759d3"), "Browser Support Open Messaging");
  assert.equal(branchLabel("ticket-124-browser"), "Ticket 124 Browser");
  assert.equal(branchLabel("feature/dark_mode"), "Dark Mode");
  assert.equal(branchLabel("fix-cafe12"), "Fix");
  assert.equal(branchLabel("main"), "");
  assert.equal(branchLabel("HEAD"), "");
  assert.equal(branchLabel(""), "");
});

test("the label argument takes both forms", () => {
  assert.equal(labelArg(["main.js", "--watch", "--label", "Browser Support"]), "Browser Support");
  assert.equal(labelArg(["main.js", "--label=Browser Support"]), "Browser Support");
  assert.equal(labelArg(["main.js", "--label="]), "");
  assert.equal(labelArg(["main.js", "--watch"]), null);
});

test("X Bench Dev is named after its label, and keeps its own name without one", () => {
  assert.equal(devAppName("Browser Support"), "Browser Support");
  assert.equal(devAppName("  "), "X Bench Dev");
  assert.equal(devAppName(""), "X Bench Dev");
  assert.equal(devAppName("Fix a/b: c"), "Fix a-b- c");
});

test("X Bench Dev starts without the installed app's Electron and page settings and keeps the rest of the environment", () => {
  const env = {
    PATH: "/usr/bin",
    HOME: "/Users/me",
    ELECTRON_RUN_AS_NODE: "1",
    X_BENCH_UI: "dist",
    X_BENCH_UI_DIR: "/Applications/X Bench.app/Contents/Resources/app.asar/dist/ui",
    X_BENCH_URL: "http://127.0.0.1:8834",
  };
  assert.deepEqual(devAppEnv(env, "/nowhere"), { PATH: "/usr/bin", HOME: "/Users/me", X_BENCH_URL: "http://127.0.0.1:8834" });
  assert.equal(env.X_BENCH_UI, "dist");
  assert.deepEqual(devAppEnv({ PATH: "/usr/bin" }, "/nowhere"), { PATH: "/usr/bin" });
});

test("X Bench Dev uses the installed app's helpers until the checkout builds its own", () => {
  const installed = "/Applications/X Bench.app/Contents/Resources";
  const env = {
    PATH: "/usr/bin",
    X_BENCH_SIM_HELPER: `${installed}/sim-helper/xbench-sim`,
    X_BENCH_ANDROID_HELPER: `${installed}/android-helper/xbench-android.jar`,
    X_BENCH_ANDROID_ENCODER: `${installed}/android-helper/xbench-encode`,
  };
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "x-bench-dev-env-"));
  try {
    assert.deepEqual(devAppEnv(env, repo), env);
    fs.mkdirSync(path.join(repo, "desktop", "devices", "sim-helper", "build"), { recursive: true });
    fs.writeFileSync(path.join(repo, "desktop", "devices", "sim-helper", "build", "xbench-sim"), "");
    fs.mkdirSync(path.join(repo, "desktop", "devices", "android-helper", "build"), { recursive: true });
    fs.writeFileSync(path.join(repo, "desktop", "devices", "android-helper", "build", "xbench-encode"), "");
    assert.deepEqual(devAppEnv(env, repo), { PATH: "/usr/bin", X_BENCH_ANDROID_HELPER: env.X_BENCH_ANDROID_HELPER });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("the host's routine notifications and keep-awake reach the app only in their own shape", () => {
  assert.deepEqual(hostNote({ type: "notify", title: "Dependency check", body: "Finished.", sessionId: "s1" }), { title: "Dependency check", body: "Finished.", sessionId: "s1" });
  assert.deepEqual(hostNote({ type: "notify", title: "Nightly", body: "Did not start: Grok is off in Settings" }), { title: "Nightly", body: "Did not start: Grok is off in Settings" });
  assert.equal(hostNote({ type: "notify", title: "", body: "x" }), null);
  assert.equal(hostNote({ type: "notify", title: 3, body: "x" }), null);
  assert.equal(hostNote({ type: "grok", pid: 4 }), null);
  assert.equal(hostNote({ type: "notify", title: "x".repeat(400), body: "y" })?.title.length, 200);
  assert.equal(keepAwakeOf({ type: "keep-awake", on: true }), true);
  assert.equal(keepAwakeOf({ type: "keep-awake", on: false }), false);
  assert.equal(keepAwakeOf({ type: "keep-awake", on: "yes" }), null);
  assert.equal(keepAwakeOf(null), null);
});
