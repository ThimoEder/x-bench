import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { xBenchPaths } from "./paths.ts";

test("every file sits in ~/.x-bench unless its variable moves it", () => {
  const paths = xBenchPaths("/home/me", { X_BENCH_TICKETS: "/tmp/tickets.json" });
  assert.equal(paths.sidebar, path.join("/home/me", ".x-bench", "sidebar.json"));
  assert.equal(paths.launchToken(8787), path.join("/home/me", ".x-bench", "launch-token-8787"));
  assert.equal(paths.tickets, "/tmp/tickets.json");
  assert.equal(paths.sak, path.join("/home/me", ".x-bench", "sak.json"));
});

test("a dev host keeps its own secret files", () => {
  const paths = xBenchPaths("/home/me", { X_BENCH_JIRA: "/tmp/jira.json" }, true);
  assert.equal(paths.trello, path.join("/home/me", ".x-bench", "dev", "trello.json"));
  assert.equal(paths.remoteSettings, path.join("/home/me", ".x-bench", "dev", "remote.json"));
  assert.equal(paths.jira, "/tmp/jira.json");
  assert.equal(paths.sidebar, path.join("/home/me", ".x-bench", "sidebar.json"));
});
