import assert from "node:assert/strict";
import test from "node:test";
import { openFolder, revealFile } from "./folder.ts";

test("open folder asks Finder to show that directory", async () => {
  const calls: { command: string; args: string[]; timeout: number }[] = [];
  const folder = await openFolder("project", {
    isDirectory: () => true,
    platform: "darwin",
    execFile: (command, args, options, callback) => {
      calls.push({ command, args, timeout: options.timeout });
      callback(null);
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.command, "open");
  assert.equal(calls[0]?.args.length, 1);
  assert.equal(calls[0]?.args[0], folder);
  assert.equal(calls[0]?.timeout, 10000);
  assert.equal(folder.endsWith("/project"), true);
});

test("open folder refuses a missing directory", async () => {
  let called = false;
  await assert.rejects(
    () => openFolder("/missing", {
      isDirectory: () => false,
      platform: "darwin",
      execFile: () => {
        called = true;
      },
    }),
    /Folder does not exist/,
  );
  assert.equal(called, false);
});

test("open folder stays on macOS", async () => {
  let called = false;
  await assert.rejects(
    () => openFolder("/tmp/project", {
      isDirectory: () => true,
      platform: "linux",
      execFile: () => {
        called = true;
      },
    }),
    /only available on macOS/,
  );
  assert.equal(called, false);
});

test("open folder reports a Finder failure", async () => {
  await assert.rejects(
    () => openFolder("/tmp/project", {
      isDirectory: () => true,
      platform: "darwin",
      execFile: (_command, _args, _options, callback) => callback(new Error("Finder failed")),
    }),
    /Finder failed/,
  );
});

test("reveal file asks Finder to select the file, without opening it", async () => {
  const calls: string[][] = [];
  const file = await revealFile("/repo/notes.md", {
    isFile: () => true,
    platform: "darwin",
    execFile: (_command, args, _options, callback) => {
      calls.push(args);
      callback(null);
    },
  });
  assert.equal(file, "/repo/notes.md");
  assert.deepEqual(calls, [["-R", "/repo/notes.md"]]);
});

test("reveal file refuses a relative path or a file that is not there", async () => {
  const never = () => {
    throw new Error("must not run");
  };
  await assert.rejects(() => revealFile("notes.md", { isFile: () => true, platform: "darwin", execFile: never }), /File does not exist/);
  await assert.rejects(() => revealFile("/repo/gone.md", { isFile: () => false, platform: "darwin", execFile: never }), /File does not exist/);
});
