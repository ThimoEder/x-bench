import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createHeldInput, createInputQueue, findPipeline, readPipeline, serverFor } from "./unityRules.js";

const DESCRIPTOR = path.join("Library", "Pipeline", ".unity-pipeline-port");

// A file tree of project folders, each with its descriptor when its Editor runs.
function tree(projects) {
  const read = (file) => {
    const project = Object.keys(projects).find((folder) => file === path.join(folder, DESCRIPTOR));
    if (!project) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return JSON.stringify(projects[project]);
  };
  const list = (parent) =>
    [...new Set(Object.keys(projects).filter((folder) => folder.startsWith(parent + "/")).map((folder) => folder.slice(parent.length + 1).split("/")[0]))].sort();
  return { read, list, isAlive: (pid) => pid !== 999 };
}

const running = (port) => ({ port, evalToken: `token-${port}`, pid: port });

test("the chat's folder itself is the Unity project", () => {
  const found = findPipeline("/work/game", tree({ "/work/game": running(7800) }));
  assert.deepEqual(found, { project: "/work/game", url: "http://127.0.0.1:7800/api/exec", token: "token-7800" });
});

test("a Unity project up to two folders under the chat's folder is found, the nearest first", () => {
  const files = tree({ "/repo/a/unity": running(7801), "/repo/game": running(7802) });
  assert.equal(findPipeline("/repo", files)?.project, "/repo/game");
  assert.equal(findPipeline("/other", files), null);
});

test("the project and its Game view's server are named the way Unity reports the project's path", () => {
  const found = readPipeline("/link/game", tree({ "/link/game": { ...running(7800), projectPath: "/real/game" } }));
  assert.equal(found?.project, "/real/game");
  assert.equal(serverFor(found.project), "X Bench Game View: /real/game");
});

test("an Editor that quit, or a descriptor that makes no sense, is no Editor", () => {
  assert.equal(readPipeline("/p", tree({ "/p": { port: 7800, evalToken: "t", pid: 999 } })), null);
  assert.equal(readPipeline("/p", tree({ "/p": { port: "7800", evalToken: "t", pid: 1 } })), null);
  assert.equal(findPipeline("relative/path", tree({})), null);
});

test("the keys and finger still down are let go once, and what was let go is not held", () => {
  const held = createHeldInput();
  held.sent("simulate_key", { key: "W", action: "down" });
  held.sent("simulate_key", { key: "A", action: "down" });
  held.sent("simulate_key", { key: "A", action: "up" });
  held.sent("xbench_touch", { x: 10, y: 20, action: "down" });
  held.sent("xbench_touch", { x: 30, y: 40, action: "move" });
  assert.deepEqual(held.release(), [
    { command: "simulate_key", parameters: { key: "W", action: "up" } },
    { command: "xbench_touch", parameters: { x: 30, y: 40, action: "up" } },
  ]);
  assert.deepEqual(held.release(), []);
});

test("an Editor that hangs loses its waiting input, and another Editor still gets its own", async () => {
  const hung = { url: "http://127.0.0.1:7800/api/exec" };
  const fresh = { url: "http://127.0.0.1:7801/api/exec" };
  const sent = [];
  const failed = [];
  const queue = createInputQueue({
    post: async (target, command, parameters) => {
      if (target.url === hung.url) throw new Error("timed out");
      sent.push(`${command} ${parameters.action}`);
    },
    failed: (target, lost) => failed.push(`${target.url} ${lost.map((item) => item.parameters.action).join(",")}`),
  });
  queue.push(hung, "simulate_key", { key: "W", action: "down" });
  // The same Editor found again by the next lookup is a new object with the same url.
  queue.push({ ...hung }, "simulate_key", { key: "W", action: "up" });
  await queue.push(fresh, "simulate_key", { key: "D", action: "down" });
  assert.deepEqual(sent, ["simulate_key down"]);
  assert.deepEqual(failed, [`${hung.url} down,up`]);
});

test("moves to one Editor wait as the latest one only", async () => {
  const target = { url: "http://127.0.0.1:7800/api/exec" };
  const sent = [];
  let release;
  const queue = createInputQueue({
    post: async (_target, _command, parameters) => {
      sent.push(`${parameters.action} ${parameters.x}`);
      if (sent.length === 1) await new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  queue.push(target, "xbench_touch", { x: 0, y: 0, action: "down" });
  queue.push(target, "xbench_touch", { x: 1, y: 0, action: "move" });
  queue.push(target, "xbench_touch", { x: 2, y: 0, action: "move" });
  const done = queue.push(target, "xbench_touch", { x: 3, y: 0, action: "up" });
  release();
  await done;
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  assert.deepEqual(sent, ["down 0", "move 2", "up 3"]);
});

test("a key-up or lifted finger that never arrived keeps that key and finger held until they are let go", () => {
  const held = createHeldInput();
  held.sent("simulate_key", { key: "W", action: "down" });
  held.sent("simulate_key", { key: "W", action: "up" });
  held.lost("simulate_key", { key: "W", action: "up" });
  held.lost("xbench_touch", { x: 5, y: 6, action: "up" });
  assert.deepEqual(held.release(), [
    { command: "simulate_key", parameters: { key: "W", action: "up" } },
    { command: "xbench_touch", parameters: { x: 5, y: 6, action: "up" } },
  ]);
});
