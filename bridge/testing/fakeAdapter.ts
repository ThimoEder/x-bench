// Runs the fake agent on stdin and stdout, one JSON message per line, like an ACP adapter
// (claude-agent-acp, codex-acp). The store file keeps its sessions across a restart.

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createFakeAgent, emptyStore, type FakeDialect, type FakeStore } from "./fakeAgent.ts";

export function runFakeAdapter(dialect: FakeDialect, file: string, onStart: (store: FakeStore) => void = () => {}) {
  let store: FakeStore;
  try {
    store = JSON.parse(readFileSync(file, "utf8")) as FakeStore;
  } catch {
    store = emptyStore();
  }

  // Written by rename, so a test reading the store never sees half a file.
  const save = () => {
    writeFileSync(`${file}.tmp`, JSON.stringify(store));
    renameSync(`${file}.tmp`, file);
  };
  const handle = createFakeAgent(dialect, store, {
    // Saved before each message goes out, so a test that reads the store after a reply sees the call.
    send: (message) => {
      save();
      process.stdout.write(`${JSON.stringify(message)}\n`);
    },
    crash: () => {
      save();
      process.stderr.write("fake adapter crashed\n");
      process.exit(1);
    },
  });

  onStart(store);
  save();
  process.stderr.write("fake adapter ready\n");
  createInterface({ input: process.stdin }).on("line", (line) => {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    handle(message as Parameters<typeof handle>[0]);
    save();
  });
}
