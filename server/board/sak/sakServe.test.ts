import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { readConnection, type SakConnection } from "./sakClient.ts";
import { createSakServe, sakIsUp, sakLocations, serveCommand, setUpLocalSak, type SakServeOptions } from "./sakServe.ts";

const on: SakConnection = { baseUrl: "http://127.0.0.1:4345", token: "sak_testtoken", enabled: true, database: "/tmp/sak.db", website: "" };

test("the packaged app's paths win, then SAK_ROOT, a built SAK checkout next to this repo, and the vendored copy", () => {
  const src = mkdtempSync(path.join(os.tmpdir(), "x-bench-src-"));
  const repo = path.join(src, "x_bench");
  const vendored = { binary: path.join(repo, "vendor", "sak", "sak"), assets: path.join(repo, "vendor", "sak", "assets") };
  assert.deepEqual(sakLocations(repo, {}), vendored);
  mkdirSync(path.join(src, "sak"));
  assert.deepEqual(sakLocations(repo, {}), vendored);
  writeFileSync(path.join(src, "sak", "sak"), "");
  assert.deepEqual(sakLocations(repo, {}), { binary: path.join(src, "sak", "sak"), assets: path.join(src, "sak", "web", "dist") });
  assert.equal(sakLocations(repo, { SAK_ROOT: "/opt/sak" }).binary, "/opt/sak/sak");
  assert.deepEqual(sakLocations(repo, { SAK_BINARY: "/App/sak/sak", SAK_ASSETS: "/App/sak/assets", SAK_ROOT: "/opt/sak" }), {
    binary: "/App/sak/sak",
    assets: "/App/sak/assets",
  });
  // Both or neither: a binary alone does not mix with a checkout's website.
  assert.equal(sakLocations(repo, { SAK_BINARY: "/bundle/sak" }).binary, path.join(src, "sak", "sak"));
  rmSync(src, { recursive: true, force: true });
});

test("sak serve gets the saved database and port, never the token, needs the binary, and runs without the website", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "x-bench-sak-"));
  const database = path.join(root, "sak.db");
  const locations = { binary: path.join(root, "sak"), assets: path.join(root, "assets") };
  writeFileSync(database, "");
  writeFileSync(locations.binary, "");
  mkdirSync(locations.assets);
  writeFileSync(path.join(locations.assets, "index.html"), "");
  const saved = { ...on, database };
  try {
    const command = serveCommand(saved, locations);
    assert.deepEqual(command, {
      binary: locations.binary,
      args: ["serve", "--db", database, "--bind", "127.0.0.1", "--port", "4345", "--assets", locations.assets, "--log-level", "quiet"],
    });
    assert.equal(command?.args.join(" ").includes("sak_"), false);
    assert.equal(serveCommand({ ...saved, database: "" }, locations), null);
    assert.equal(serveCommand({ ...saved, database: path.join(root, "gone.db") }, locations), null);
    assert.equal(serveCommand(saved, { ...locations, binary: path.join(root, "nope") }), null);
    assert.deepEqual(serveCommand(saved, { ...locations, assets: path.join(root, "nope") })?.args, ["serve", "--db", database, "--bind", "127.0.0.1", "--port", "4345", "--log-level", "quiet"]);
    assert.equal(serveCommand({ ...saved, baseUrl: "http://127.0.0.1" }, locations), null);
    const website = path.join(root, "web");
    mkdirSync(website);
    writeFileSync(path.join(website, "index.html"), "");
    assert.deepEqual(serveCommand({ ...saved, website }, { ...locations, assets: path.join(root, "nope") })?.args.slice(7, 9), ["--assets", website]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a local setup mints a token into sak.db next to sak.json and saves both", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "x-bench-sak-"));
  const connection = path.join(root, "new", "sak.json");
  const locations = { binary: path.join(root, "sak"), assets: path.join(root, "assets") };
  const runs: string[][] = [];
  try {
    await assert.rejects(setUpLocalSak(connection, locations, async () => ({ stdout: "" })), /not installed/);
    writeFileSync(locations.binary, "");
    await assert.rejects(setUpLocalSak(connection, locations, async () => ({ stdout: "error\n" })), /did not create a token/);
    await setUpLocalSak(connection, locations, async (binary, args) => {
      runs.push([binary, ...args]);
      return { stdout: "sak_0123abcd\n" };
    });
    const database = path.join(root, "new", "sak.db");
    assert.ok(existsSync(path.dirname(database)));
    assert.deepEqual(runs, [[locations.binary, "token", "create", "--db", database, "--name", "X Bench"]]);
    assert.deepEqual(readConnection(connection), { baseUrl: "http://127.0.0.1:4345", token: "sak_0123abcd", enabled: true, database, website: "" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("any answer at the saved address counts as up, and a refused connection does not", async () => {
  const probed: string[] = [];
  const refusal = (async (url: string, init: RequestInit) => {
    probed.push(`${url} ${(init.headers as Record<string, string>).Authorization}`);
    return { status: 401 };
  }) as unknown as typeof fetch;
  assert.equal(await sakIsUp(on, refusal), true);
  assert.deepEqual(probed, ["http://127.0.0.1:4345/api/health Bearer sak_testtoken"]);
  assert.equal(await sakIsUp(on, (async () => Promise.reject(new Error("refused"))) as typeof fetch), false);
});

// Real processes in their own group, so stopping signals a group as it does for SAK.
function harness(overrides: Partial<SakServeOptions> = {}) {
  const launched: ChildProcess[] = [];
  const events: string[] = [];
  let saved = on;
  const serve = createSakServe({
    connection: () => saved,
    command: () => ({ binary: "/bin/sleep", args: ["30"] }),
    launch: ({ binary, args }) => {
      const child = spawn(binary, args, { detached: true, stdio: "ignore" });
      launched.push(child);
      return child;
    },
    isUp: async () => launched.length > 0,
    onProcess: (pid, running) => events.push(`${pid} ${running}`),
    log: () => {},
    startTimeout: 300,
    stopTimeout: 1000,
    ...overrides,
  });
  return {
    serve,
    launched,
    events,
    save(next: SakConnection) {
      saved = next;
    },
  };
}

function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("a SAK that is down is started once, and stopped again when Setup turns it off", async () => {
  const { serve, launched, events, save } = harness();
  try {
    await serve.sync();
    await serve.sync();
    assert.equal(launched.length, 1);
    const pid = launched[0]?.pid;
    assert.equal(alive(pid), true);
    save({ ...on, enabled: false });
    await serve.sync();
    await delay(50);
    assert.equal(alive(pid), false);
    assert.deepEqual(events, [`${pid} true`, `${pid} false`]);
  } finally {
    await serve.close();
  }
});

test("a SAK that something else runs is left alone", async () => {
  const { serve, launched } = harness({ isUp: async () => true });
  await serve.sync();
  assert.equal(launched.length, 0);
  await serve.close();
});

test("quitting stops the SAK this host started, and a check still running starts nothing", async () => {
  const started = harness();
  await started.serve.sync();
  const pid = started.launched[0]?.pid;
  await started.serve.close();
  assert.equal(alive(pid), false);

  let answer: (up: boolean) => void = () => {};
  const pending = harness({
    isUp: () =>
      new Promise<boolean>((resolve) => {
        answer = resolve;
      }),
  });
  const sync = pending.serve.sync();
  await delay(10);
  const closing = pending.serve.close();
  answer(false);
  await Promise.all([sync, closing]);
  assert.equal(pending.launched.length, 0);
});
