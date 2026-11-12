import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { answerMcp } from "../mcp/mcp.ts";
import type { PageBody } from "./board.ts";
import { boardCall, boardTools, type BoardCall, type BoardReply } from "./boardTools.ts";
import { BOARD_TOOLS } from "./sharedRules.ts";

type Sent = [method: string, route: string, body: PageBody];

function recorder(answer: (method: string, route: string) => BoardReply = () => ({ status: 200, body: { ok: true } })) {
  const sent: Sent[] = [];
  const call: BoardCall = (method, route, body = {}) => {
    sent.push([method, route, body]);
    return Promise.resolve(answer(method, route));
  };
  return { sent, call };
}

async function run(call: BoardCall, name: string, args: unknown, sessionId: string | null = "chat-1") {
  const reply = await answerMcp(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    boardTools(call, (id) => (id === "chat-1" ? "/work/my app" : null)).tools,
    { sessionId, signal: new AbortController().signal },
  );
  assert.ok(reply && "result" in reply, "no result");
  const result = reply.result as { content: { text: string }[]; isError: boolean };
  return { text: result.content[0]?.text ?? "", isError: result.isError };
}

const CWD = "cwd=%2Fwork%2Fmy%20app";

test("each board tool sends the board route its request, for the calling chat's folder", async () => {
  const { sent, call } = recorder();
  await run(call, BOARD_TOOLS.read, { search: "login bug" });
  await run(call, BOARD_TOOLS.readTicket, { id: "app-12" });
  await run(call, BOARD_TOOLS.create, { title: "Fix it", description: "Why." });
  await run(call, BOARD_TOOLS.edit, { id: "41", revision: 3, description: "New text" });
  await run(call, BOARD_TOOLS.move, { id: 41, status: "review" });
  await run(call, BOARD_TOOLS.move, { id: 41, unset: true });
  await run(call, BOARD_TOOLS.comment, { id: "41", body: "Done in #7." });
  await run(call, BOARD_TOOLS.relate, { id: "41", otherId: "40", kind: "parent" });
  await run(call, BOARD_TOOLS.relate, { id: "41", otherId: "40", kind: "blocked_by", remove: true });
  await run(call, BOARD_TOOLS.files, { id: "41" });
  await run(call, BOARD_TOOLS.deleteFile, { id: "41", fileId: "9" });
  await run(call, BOARD_TOOLS.link, { id: "41" });
  assert.deepEqual(sent, [
    ["GET", `/api/board/board?${CWD}&search=login%20bug`, {}],
    ["GET", "/api/board/tasks/APP-12", {}],
    ["POST", "/api/board/tasks", { cwd: "/work/my app", title: "Fix it", description: "Why." }],
    ["PATCH", "/api/board/tasks/41", { revision: "3", description: "New text" }],
    ["POST", "/api/board/move", { cwd: "/work/my app", taskId: 41, status: "review" }],
    ["POST", "/api/board/move", { cwd: "/work/my app", taskId: 41, status: null }],
    ["POST", "/api/board/tasks/41/comments", { body: "Done in #7." }],
    ["PUT", "/api/board/tasks/41/relations", { cwd: "/work/my app", otherTaskId: 40, kind: "parent" }],
    ["DELETE", "/api/board/tasks/41/relations/40/blocked_by", { cwd: "/work/my app" }],
    ["GET", `/api/board/tasks/41/files?${CWD}`, {}],
    ["DELETE", `/api/board/tasks/41/files/9?${CWD}`, {}],
    ["POST", "/api/board/links", { cwd: "/work/my app", taskId: 41, sessionId: "chat-1" }],
  ]);
});

test("a board tool answers what the board answered, and refuses a malformed call before it reaches the board", async () => {
  const { sent, call } = recorder((_method, route) =>
    route.includes("/board?")
      ? { status: 200, body: { columns: [{ value: "open", title: "Open", color: "#fff" }], tasks: [{ id: 41, title: "Fix it", description: "long", attributes: { status: "open" } }], truncated: false, labels: [] } }
      : { status: 409, body: { error: "Someone else edited this ticket", code: null } });
  assert.deepEqual(await run(call, BOARD_TOOLS.read, {}), {
    text: JSON.stringify({ columns: [{ status: "open", title: "Open" }], tickets: [{ id: 41, title: "Fix it", status: "open" }], truncated: false }),
    isError: false,
  });
  assert.deepEqual(await run(call, BOARD_TOOLS.edit, { id: "41", revision: "3", title: "New" }), {
    text: 'The board answered 409: {"error":"Someone else edited this ticket","code":null}',
    isError: true,
  });
  sent.length = 0;
  assert.deepEqual(await run(call, BOARD_TOOLS.readTicket, { id: "../status" }), { text: "Give the ticket's id.", isError: true });
  assert.deepEqual(await run(call, BOARD_TOOLS.relate, { id: "41", otherId: "40", kind: "../x" }), { text: "Choose a relation kind, such as parent, subtask or blocks.", isError: true });
  assert.deepEqual(await run(call, BOARD_TOOLS.deleteFile, { id: "41", fileId: "9/../.." }), { text: `Give the fileId from ${BOARD_TOOLS.files}.`, isError: true });
  assert.deepEqual(await run(call, BOARD_TOOLS.move, { id: "41" }), { text: "Give the status of the column to move to.", isError: true });
  assert.deepEqual(await run(call, BOARD_TOOLS.move, { id: "41", status: "done" }, null), { text: "This chat is still opening. Try again in a moment.", isError: true });
  assert.deepEqual(sent, []);
});

test("only attaching and deleting a file ask in the harness, and the tools stay out of the Chat tab", () => {
  const group = boardTools(recorder().call, () => "/work");
  assert.deepEqual(group.tools.filter((tool) => !tool.trusted).map((tool) => tool.spec.name), [BOARD_TOOLS.attach, BOARD_TOOLS.deleteFile]);
  assert.deepEqual(group.tools.map((tool) => tool.spec.name).sort(), Object.values(BOARD_TOOLS).sort());
  assert.equal(group.builderOnly, true);
});

test("a file goes up from its path with its own name, and comes down under the name the board keeps", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "x-bench-board-test-"));
  try {
    const shot = path.join(root, "shot.png");
    writeFileSync(shot, "PNG-bytes");
    const up = recorder(() => ({ status: 201, body: { id: 9, name: "shot.png" } }));
    assert.deepEqual(await run(up.call, BOARD_TOOLS.attach, { id: "41", path: shot }), { text: '{"id":9,"name":"shot.png"}', isError: false });
    const [method, route, body] = up.sent[0] ?? [];
    assert.deepEqual([method, route], ["POST", `/api/board/tasks/41/files?name=shot.png&${CWD}`]);
    assert.equal(await body?.file?.text(), "PNG-bytes");
    assert.deepEqual(await run(up.call, BOARD_TOOLS.attach, { id: "41", path: root }), { text: `No file at ${root}.`, isError: true });

    const down = recorder((_method, route) =>
      route.includes("/files/9")
        ? { status: 200, body: null, file: { status: 200, headers: { "content-type": "image/png" }, bytes: Buffer.from("PNG-bytes") } }
        : { status: 200, body: { files: [{ id: 9, name: "../../evil/shot.png" }] } });
    const read = await run(down.call, BOARD_TOOLS.readFile, { id: "41", fileId: "9" });
    const saved = /^Saved to (.+) \(image\/png, 9 bytes\)\.$/.exec(read.text)?.[1] ?? "";
    assert.equal(path.basename(saved), "shot.png");
    assert.equal(path.dirname(path.dirname(saved)), os.tmpdir());
    assert.equal(readFileSync(saved, "utf8"), "PNG-bytes");
    rmSync(path.dirname(saved), { recursive: true, force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a board call runs the board routes in the host and answers their reply", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "x-bench-board-test-"));
  try {
    let changes = 0;
    const call = boardCall({
      files: { tickets: path.join(root, "tickets.json"), connections: { sak: path.join(root, "sak.json"), trello: path.join(root, "trello.json"), jira: path.join(root, "jira.json") } },
      changed() {
        changes += 1;
      },
    });
    assert.deepEqual(await call("POST", "/api/board/tasks", { cwd: root, title: "Fix it" }), { status: 404, body: { error: "This folder has no board", code: null } });
    assert.deepEqual(await call("GET", "/api/board/nothing"), { status: 404, body: { error: "Not found" } });
    assert.equal(changes, 0);
    assert.equal((await call("DELETE", "/api/board/links", { sessionId: "chat-1", taskId: 41 })).status, 200);
    assert.equal(changes, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
