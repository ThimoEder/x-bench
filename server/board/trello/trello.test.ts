import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isRecord } from "../../../bridge/lenient.ts";
import { boardHref } from "../boardLink.ts";
import { handleBoard } from "../board.ts";
import { canonicalCwd } from "../../chat/sessions.ts";
import { bindBoard, readTickets, writeTickets } from "../tickets.ts";
import type { BoardFiles } from "../boardAdapter.ts";
import type { TrelloBinding } from "./trelloSource.ts";
import {
  labelColor,
  presentComments,
  presentTrelloBoard,
  resolveColumn,
  trelloStatus,
  writeTrelloConnection,
} from "./trello.ts";
import type { BoardCallOptions, BoardFetch } from "../boardAdapter.ts";

const board = "a".repeat(24);
const open = "b".repeat(24);
const active = "c".repeat(24);
const review = "1".repeat(24);
const done = "2".repeat(24);
const card = "d".repeat(24);
const label = "e".repeat(24);
const listIds: Record<string, string> = { Open: open, Active: active, Review: review, Done: done };

interface Call {
  method: string;
  path: string;
  body: unknown;
}

interface Sent {
  status: number;
  body: unknown;
}

interface TestContext {
  files: BoardFiles;
  isDirectory: () => boolean;
  fetchOptions: BoardCallOptions;
  publish(): void;
  sendJson(res: unknown, status: number, body: unknown): void;
  sessions?: () => { id: string; cwd: string; working: boolean }[];
  origin?: string;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value), "not an object");
  return value;
}

// Walks down a response body. Fails the test when a step is not an object.
function at(value: unknown, ...keys: string[]): unknown {
  return keys.reduce((current, key) => record(current)[key], value);
}

function trelloBinding(file: string): TrelloBinding {
  const binding = Object.values(readTickets(file).bindings)[0];
  assert.ok(binding?.provider === "trello", "no Trello binding");
  return binding;
}

function sampleBoard() {
  return {
    id: board,
    name: "Remote",
    shortUrl: "https://trello.com/b/remote",
    dateLastActivity: "2026-09-23T22:00:00.000Z",
    labels: [{ id: label, name: "bug", color: "red" }],
    lists: [
      { id: active, name: "Active", pos: 32768, closed: false },
      { id: open, name: "Open", pos: 16384, closed: false },
    ],
    cards: [
      {
        id: card,
        name: "Probe",
        desc: "From Trello",
        idList: open,
        idBoard: board,
        dateLastActivity: "2026-09-23T22:00:00.000Z",
        idShort: 7,
        labels: [{ id: label, name: "bug", color: "red_light" }],
      },
      { id: "f".repeat(24), name: "Other", desc: "skip", idList: active, idBoard: board, closed: false },
    ],
  };
}

test("a Trello board maps lists in order, colors labels, and filters the search", () => {
  const loaded = presentTrelloBoard(sampleBoard(), "probe");
  assert.deepEqual(loaded.payload.columns, [
    { value: open, title: "Open" },
    { value: active, title: "Active" },
  ]);
  assert.equal(loaded.payload.tasks.length, 1);
  assert.equal(loaded.payload.tasks[0]?.id, card);
  assert.equal(loaded.payload.tasks[0]?.reference, 7);
  assert.equal(loaded.payload.tasks[0]?.attributes.status, open);
  assert.equal(loaded.payload.tasks[0]?.linkStatus, "Open");
  assert.equal(loaded.payload.tasks[0]?.note, null);
  assert.equal(loaded.payload.tasks[0]?.labels[0]?.color, "#eb5a46");
  const colored = presentTrelloBoard({
    ...sampleBoard(),
    lists: [
      { id: open, name: "Open", pos: 1, closed: false, color: "blue" },
      { id: active, name: "Active", pos: 2, closed: false, color: "nope" },
    ],
  });
  assert.equal(colored.payload.columns[0]?.colorName, "blue");
  assert.equal(colored.payload.columns[0]?.color, "#0079bf");
  const plain = colored.payload.columns[1];
  assert.ok(plain, "no second column");
  assert.equal(plain.color, undefined);
  const byId = presentTrelloBoard({
    ...sampleBoard(),
    cards: [{ id: card, name: "Probe", desc: "", idList: open, idLabels: [label] }],
  });
  assert.equal(byId.payload.tasks[0]?.labels[0]?.title, "bug");
  assert.equal(labelColor("blue_dark"), "#0079bf");
  assert.deepEqual(presentComments([
    { id: "2", data: { text: "second" } },
    { id: "1", data: { text: "first" } },
  ]), [
    { id: "1", body: "first", author: null, created: null, mine: false },
    { id: "2", body: "second", author: null, created: null, mine: false },
  ]);
});

test("a list is found by its id, or by its name as a board reply spells it, without hidden characters", () => {
  const columns = [{ id: open, title: "Open" }, { id: active, title: "\u{1F6E0}\uFE0F Act\u200Bive" }];
  assert.equal(resolveColumn(columns, active), columns[1]);
  assert.equal(resolveColumn(columns, "\u{1F6E0}\uFE0F active"), columns[1]);
  assert.equal(resolveColumn(columns, "Review"), null);
});

test("a list color is written to Trello and remembered on the board", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-trello-"));
  const calls: Call[] = [];
  const fetchImpl: BoardFetch = async (url, options = {}) => {
    const parsed = new URL(url);
    const body: unknown = typeof options.body === "string" ? JSON.parse(options.body) : null;
    calls.push({ method: options.method || "GET", path: parsed.pathname, body });
    if (parsed.pathname === `/1/lists/${open}`) return json(200, { id: open, color: "blue" });
    return json(404, { message: "missing" });
  };
  try {
    const tickets = path.join(root, "tickets.json");
    const sent: Sent[] = [];
    writeTrelloConnection({ apiKey: "key", token: "token" }, path.join(root, "trello.json"));
    writeTickets(bindBoard({ bindings: {}, links: [] }, root, {
      provider: "trello",
      boardId: board,
      title: "Remote",
      columns: [{ id: open, title: "Open" }, { id: active, title: "Active" }],
    }), tickets);
    await handleBoard({ method: "POST" }, {}, new URL("/api/board/lists", "http://127.0.0.1"), {
      cwd: root,
      listId: open,
      color: "blue",
    }, {
      files: { tickets, connections: { sak: path.join(root, "sak.json"), trello: path.join(root, "trello.json"), jira: path.join(root, "jira.json") } },
      isDirectory: () => true,
      fetchOptions: { fetchImpl },
      publish() {},
      sendJson(_res: unknown, status: number, body: unknown) {
        sent.push({ status, body });
      },
    });
    assert.equal(sent[0]?.status, 200);
    assert.equal(at(sent[0]?.body, "column", "color"), "#0079bf");
    assert.deepEqual(calls[0]?.body, { color: "blue" });
    assert.equal(trelloBinding(tickets).columns[0]?.color, "blue");
    sent.length = 0;
    await handleBoard({ method: "POST" }, {}, new URL("/api/board/lists", "http://127.0.0.1"), {
      cwd: root,
      listId: open,
      color: "pink",
    }, {
      files: { tickets, connections: { sak: path.join(root, "sak.json"), trello: path.join(root, "trello.json"), jira: path.join(root, "jira.json") } },
      isDirectory: () => true,
      fetchOptions: { fetchImpl },
      publish() {},
      sendJson(_res: unknown, status: number, body: unknown) {
        sent.push({ status, body });
      },
    });
    assert.equal(sent[0]?.status, 400);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the Trello connection file stays private and the status hides the token", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-trello-"));
  const file = path.join(root, "trello.json");
  try {
    writeTrelloConnection({ apiKey: "key", token: "token" }, file);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const calls: string[] = [];
    const status = await trelloStatus({ apiKey: "key", token: "token", enabled: true }, {
      fetchImpl: async (url) => {
        calls.push(url);
        return json(200, { fullName: "Ada", username: "ada" });
      },
    });
    assert.equal(status.reachable, true);
    assert.equal(status.username, "ada");
    assert.equal(Object.hasOwn(status, "token"), false);
    assert.equal(Object.hasOwn(status, "apiKey"), false);
    assert.equal(calls[0]?.includes("token=token"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("creating, moving, and commenting on a Trello card stays off SAK, and its text arrives without hidden characters", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-trello-"));
  const state: { calls: Call[]; card: Record<string, unknown> | null; activity: string } = {
    calls: [],
    card: null,
    activity: "2026-09-23T22:00:00.000Z",
  };
  const fetchImpl: BoardFetch = async (url, options = {}) => {
    const parsed = new URL(url);
    const method = options.method || "GET";
    const body: unknown = typeof options.body === "string" ? JSON.parse(options.body) : null;
    state.calls.push({ method, path: parsed.pathname, body });
    if (parsed.searchParams.get("key") !== "key" || parsed.searchParams.get("token") !== "token") return json(401, { message: "no" });
    if (method === "POST" && parsed.pathname === "/1/boards") {
      assert.equal(record(body).defaultLists, false);
      return json(200, { id: board, name: record(body).name });
    }
    if (method === "POST" && parsed.pathname === `/1/boards/${board}/lists`) {
      const list = record(body);
      return json(200, { id: listIds[String(list.name)], name: list.name, pos: list.pos });
    }
    if (method === "GET" && parsed.pathname === `/1/boards/${board}` && parsed.searchParams.get("fields") === "dateLastActivity") {
      return json(200, { dateLastActivity: state.activity });
    }
    if (method === "GET" && parsed.pathname === `/1/boards/${board}`) return json(200, sampleBoard());
    if (method === "POST" && parsed.pathname === "/1/cards") {
      const created = record(body);
      state.card = {
        id: card,
        name: created.name,
        desc: created.desc || "",
        idList: created.idList,
        idBoard: board,
        dateLastActivity: state.activity,
        idShort: 1,
        labels: [],
      };
      return json(200, state.card);
    }
    if (method === "GET" && parsed.pathname === `/1/cards/${card}/checklists`) return json(200, []);
    if (method === "PUT" && parsed.pathname === `/1/cards/${card}`) {
      const patch = record(body);
      const current = record(state.card);
      state.card = { ...current, ...patch, name: patch.name || current.name, desc: patch.desc ?? current.desc, idList: patch.idList || current.idList };
      if (patch.idList) state.card.idList = patch.idList;
      state.activity = "2026-09-23T22:05:00.000Z";
      state.card.dateLastActivity = state.activity;
      return json(200, state.card);
    }
    if (method === "GET" && parsed.pathname === `/1/cards/${card}/labels`) return json(200, state.card?.labels || []);
    if (method === "GET" && parsed.pathname === `/1/cards/${card}`) return json(200, state.card);
    if (method === "GET" && parsed.pathname === `/1/cards/${card}/actions`) {
      return json(200, [{ id: "9".repeat(24), data: { text: "second" } }, { id: "8".repeat(24), data: { text: "first" } }]);
    }
    if (method === "POST" && parsed.pathname === `/1/cards/${card}/actions/comments`) {
      return json(200, { id: "7".repeat(24), data: { text: record(body).text } });
    }
    return json(404, { message: "missing" });
  };
  try {
    const tickets = path.join(root, "tickets.json");
    const sent: Sent[] = [];
    const ctx: TestContext = {
      files: { tickets, connections: { sak: path.join(root, "sak.json"), trello: path.join(root, "trello.json"), jira: path.join(root, "jira.json") } },
      isDirectory: () => true,
      fetchOptions: { fetchImpl },
      publish() {},
      sendJson(_res: unknown, status: number, body: unknown) {
        sent.push({ status, body });
      },
    };
    writeTrelloConnection({ apiKey: "key", token: "token" }, ctx.files.connections.trello);
    await handleBoard({ method: "POST" }, {}, new URL("/api/board/boards", "http://127.0.0.1"), {
      cwd: root,
      provider: "trello",
      title: "Remote",
    }, ctx);
    assert.equal(sent[0]?.status, 201);
    const binding = trelloBinding(tickets);
    assert.equal(binding.boardId, board);
    assert.deepEqual(binding.columns.map((column) => column.title), ["Open", "Active", "Review", "Done"]);
    assert.deepEqual(state.calls.filter((call) => call.path.endsWith("/lists")).map((call) => record(call.body).pos), [16384, 32768, 49152, 65536]);
    sent.length = 0;
    await handleBoard({ method: "POST" }, {}, new URL("/api/board/tasks", "http://127.0.0.1"), {
      cwd: root,
      title: "Probe",
      description: "Hello",
      sessionId: "sess-1",
    }, ctx);
    assert.equal(sent[0]?.status, 201);
    assert.equal(at(sent[0]?.body, "task", "attributes", "status"), open);
    assert.equal(at(sent[0]?.body, "link", "taskId"), card);
    ctx.sessions = () => [{ id: "sess-2", cwd: root, working: true }];
    ctx.origin = "http://127.0.0.1:8787";
    sent.length = 0;
    await handleBoard({ method: "POST" }, {}, new URL("/api/board/links", "http://127.0.0.1"), {
      cwd: root,
      taskId: card,
    }, ctx);
    assert.equal(sent[0]?.status, 200);
    assert.equal(at(sent[0]?.body, "link", "sessionId"), "sess-2");
    assert.equal(at(sent[0]?.body, "boardUrl"), boardHref("http://127.0.0.1:8787", canonicalCwd(root), card));
    const created = state.calls.find((call) => call.method === "POST" && call.path === "/1/cards");
    assert.equal(record(created?.body).idList, open);
    sent.length = 0;
    await handleBoard({ method: "POST" }, {}, new URL("/api/board/move", "http://127.0.0.1"), {
      cwd: root,
      taskId: card,
      status: "Active",
    }, ctx);
    assert.equal(sent[0]?.status, 200);
    assert.equal(at(sent[0]?.body, "task", "attributes", "status"), active);
    const moved = state.calls.filter((call) => call.method === "PUT" && call.path === `/1/cards/${card}`);
    assert.deepEqual(moved[0]?.body, { idList: active });
    assert.equal(readTickets(tickets).links[0]?.status, "Active");
    sent.length = 0;
    state.card = { ...record(state.card), desc: `Fix\u200B the\u202E login\u{E0041}\u{E0042}\r\nnow` };
    await handleBoard({ method: "GET" }, {}, new URL(`/api/board/tasks/${card}`, "http://127.0.0.1"), {}, ctx);
    assert.equal(at(sent[0]?.body, "task", "description"), "Fix the login\nnow");
    assert.deepEqual(at(sent[0]?.body, "comments"), [
      { id: "8".repeat(24), body: "first", author: null, created: null, mine: false },
      { id: "9".repeat(24), body: "second", author: null, created: null, mine: false },
    ]);
    sent.length = 0;
    await handleBoard({ method: "POST" }, {}, new URL(`/api/board/tasks/${card}/comments`, "http://127.0.0.1"), { body: "Noted" }, ctx);
    assert.equal(at(sent[0]?.body, "body"), "Noted");
    sent.length = 0;
    await handleBoard({ method: "POST" }, {}, new URL(`/api/board/tasks/${card}/comments`, "http://127.0.0.1"), { body: "First line\n\nSecond line" }, ctx);
    assert.equal(at(sent[0]?.body, "body"), "First line\n\nSecond line");
    sent.length = 0;
    await handleBoard({ method: "GET" }, {}, new URL(`/api/board/board?cwd=${encodeURIComponent(root)}&activity=${encodeURIComponent(state.activity)}`, "http://127.0.0.1"), {}, ctx);
    assert.equal(at(sent[0]?.body, "unchanged"), true);
    sent.length = 0;
    await handleBoard({ method: "PATCH" }, {}, new URL(`/api/board/tasks/${card}`, "http://127.0.0.1"), {
      title: "Probe",
      description: "Changed",
      revision: "2026-09-23T21:00:00.000Z",
    }, ctx);
    assert.equal(sent[0]?.status, 409);
    assert.equal(at(sent[0]?.body, "error"), "Someone else edited this ticket");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
