import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { boardRoute, handleBoard, isBoardPath, type BoardContext } from "./board.ts";

interface Sent {
  status: number;
  body: unknown;
}

test("/api/sak is another name for /api/board, apart from SAK's own connection routes", () => {
  assert.equal(boardRoute("/api/sak/tasks/41/comments"), "/api/board/tasks/41/comments");
  assert.equal(boardRoute("/api/sak"), "/api/board");
  assert.equal(boardRoute("/api/sakx"), "/api/sakx");
  assert.equal(boardRoute("/api/board/move"), "/api/board/move");
  assert.equal(boardRoute("/api/sak/status"), "/api/sak/status");
  assert.equal(boardRoute("/api/sak/connection"), "/api/sak/connection");
  assert.equal(boardRoute("/api/sak/projects"), "/api/sak/projects");
  assert.equal(boardRoute("/api/trello/status"), "/api/trello/status");
  assert.equal(isBoardPath("/api/board/move"), true);
  assert.equal(isBoardPath("/api/sak/move"), true);
  assert.equal(isBoardPath("/api/trello/boards"), true);
  assert.equal(isBoardPath("/api/boards"), false);
  assert.equal(isBoardPath("/api/session"), false);
});

test("a board route answers the same under /api/board and /api/sak", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-board-"));
  try {
    const sent: Sent[] = [];
    const ctx: BoardContext = {
      files: { tickets: path.join(root, "tickets.json"), connections: { sak: path.join(root, "sak.json"), trello: path.join(root, "trello.json"), jira: path.join(root, "jira.json") } },
      sendJson(_res, status, body) {
        sent.push({ status, body });
      },
    };
    await handleBoard({ method: "POST" }, {}, new URL("/api/board/move", "http://127.0.0.1"), {}, ctx);
    await handleBoard({ method: "POST" }, {}, new URL("/api/sak/move", "http://127.0.0.1"), {}, ctx);
    await handleBoard({ method: "GET" }, {}, new URL("/api/board/status", "http://127.0.0.1"), {}, ctx);
    assert.equal(sent[0]?.status, 400);
    assert.deepEqual(sent[1], sent[0]);
    assert.deepEqual(sent[2], { status: 404, body: { error: "Not found" } });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a write that goes through tells the host the board changed, and a read or a refused write does not", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-board-"));
  try {
    let changes = 0;
    const ctx: BoardContext = {
      files: { tickets: path.join(root, "tickets.json"), connections: { sak: path.join(root, "sak.json"), trello: path.join(root, "trello.json"), jira: path.join(root, "jira.json") } },
      sendJson() {},
      changed() {
        changes += 1;
      },
    };
    await handleBoard({ method: "POST" }, {}, new URL("/api/board/move", "http://127.0.0.1"), {}, ctx);
    await handleBoard({ method: "GET" }, {}, new URL("/api/board/status", "http://127.0.0.1"), {}, ctx);
    assert.equal(changes, 0);
    await handleBoard({ method: "DELETE" }, {}, new URL("/api/board/boards", "http://127.0.0.1"), { cwd: root }, ctx);
    assert.equal(changes, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("each source answers its own board list route, and only a source that makes boards takes a POST there", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-board-"));
  try {
    const sent: Sent[] = [];
    const ctx: BoardContext = {
      files: { tickets: path.join(root, "tickets.json"), connections: { sak: path.join(root, "sak.json"), trello: path.join(root, "trello.json"), jira: path.join(root, "jira.json") } },
      fetchOptions: { fetchImpl: async () => Promise.reject(new Error("offline")) },
      sendJson(_res, status, body) {
        sent.push({ status, body });
      },
    };
    await handleBoard({ method: "POST" }, {}, new URL("/api/sak/projects", "http://127.0.0.1"), { title: " " }, ctx);
    await handleBoard({ method: "POST" }, {}, new URL("/api/trello/boards", "http://127.0.0.1"), { title: "Remote" }, ctx);
    await handleBoard({ method: "GET" }, {}, new URL("/api/jira/projects", "http://127.0.0.1"), {}, ctx);
    await handleBoard({ method: "GET" }, {}, new URL("/api/trello/boards", "http://127.0.0.1"), {}, ctx);
    assert.deepEqual(sent[0], { status: 400, body: { error: "Name the board", code: null } });
    assert.deepEqual(sent[1], { status: 404, body: { error: "Not found" } });
    assert.deepEqual(sent[2], { status: 404, body: { error: "Not found" } });
    assert.notEqual(sent[3]?.status, 404);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
