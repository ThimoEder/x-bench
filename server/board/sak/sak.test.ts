import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isRecord } from "../../../bridge/lenient.ts";
import { boardHref } from "../boardLink.ts";
import { boardFailure, type BoardFetch } from "../boardAdapter.ts";
import { listAllTasks, readConnection, sakFetch, saveConnection, writeConnection } from "./sakClient.ts";
import { handleBoard, labelIdOf, type BoardContext, type BoardThreadRequest, type PageBody } from "../board.ts";
import { canonicalCwd } from "../../chat/sessions.ts";
import { linkTicket, readTickets, writeTickets } from "../tickets.ts";
import type { SakBinding } from "./sakSource.ts";

const statusDef = {
  id: 1,
  name: "status",
  type: "enum",
  options: [
    { id: 1, value: "open", position: 1 },
    { id: 2, value: "active", position: 2 },
    { id: 3, value: "review", position: 3 },
    { id: 4, value: "done", position: 4 },
  ],
};

interface FakeLabel {
  id: number;
  project_id: number;
  title: unknown;
  color: unknown;
}

interface FakeState {
  auth: string[];
  calls: string[];
  tasks: unknown[];
  labels?: FakeLabel[];
  projectId?: number;
  title?: string;
  description?: string | null;
  note?: string | null;
  failStatus?: boolean;
  comment?: unknown;
  created?: Record<string, unknown> | null;
  conflict?: boolean;
  match?: string;
  // What SAK answers a relation write, when it refuses one.
  refuseRelation?: { status: number; error: string } | null;
  relations?: unknown[];
  noSite?: boolean;
}

interface Sent {
  status: number;
  body: unknown;
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value), "not an object");
  return value;
}

// Walks down a response body. Fails the test when a step is not an object.
function at(value: unknown, ...keys: string[]): unknown {
  return keys.reduce((current, key) => record(current)[key], value);
}

function list(value: unknown): unknown[] {
  assert.ok(Array.isArray(value), "not a list");
  return value;
}

async function fakeSak(state: FakeState) {
  const server = http.createServer(async (req, res) => {
    if (req.method === "HEAD" && req.url === "/") {
      res.writeHead(state.noSite ? 404 : 200).end();
      return;
    }
    const auth = req.headers.authorization || "";
    state.auth.push(auth);
    if (auth !== "Bearer sak_testtoken") {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const url = new URL(req.url || "/", "http://127.0.0.1");
    state.calls.push(`${req.method} ${url.pathname}${url.search}`);
    const body = record(await readBody(req));
    if (req.method === "GET" && url.pathname === "/api/health") return json(res, 200, { ok: true, version: "0.2.0" });
    if (req.method === "GET" && url.pathname === "/api/projects/7") return json(res, 200, { id: 7, title: "App" });
    if (req.method === "POST" && url.pathname === "/api/projects") return json(res, 201, { id: 8, title: body.title });
    if (req.method === "GET" && /^\/api\/projects\/\d+\/attributes$/.test(url.pathname)) return json(res, 200, [statusDef]);
    if (req.method === "GET" && /^\/api\/projects\/\d+\/labels$/.test(url.pathname)) return json(res, 200, state.labels || []);
    if (req.method === "POST" && /^\/api\/projects\/(\d+)\/labels$/.test(url.pathname)) {
      const label = { id: (state.labels || []).length + 1, project_id: Number(url.pathname.split("/")[3]), title: body.title, color: body.color ?? null };
      state.labels = [...(state.labels || []), label];
      return json(res, 201, label);
    }
    if (req.method === "DELETE" && /^\/api\/labels\/\d+$/.test(url.pathname)) {
      const id = Number(url.pathname.split("/")[3]);
      if (!(state.labels || []).some((label) => label.id === id)) return json(res, 404, { error: "not_found" });
      state.labels = (state.labels || []).filter((label) => label.id !== id);
      return json(res, 200, { ok: true });
    }
    if (req.method === "PUT" && /^\/api\/tasks\/\d+\/labels\/\d+$/.test(url.pathname)) return json(res, 200, { ok: true });
    if (req.method === "DELETE" && /^\/api\/tasks\/\d+\/labels\/\d+$/.test(url.pathname)) return json(res, 200, { ok: true });
    if (/^\/api\/tasks\/\d+\/relations(\/\d+\/[a-z_]+)?$/.test(url.pathname) && (req.method === "PUT" || req.method === "DELETE")) {
      if (state.refuseRelation) return json(res, state.refuseRelation.status, { error: state.refuseRelation.error });
      if (req.method === "DELETE") return json(res, 200, { ok: true });
      state.relations = [...(state.relations || []), { task: Number(url.pathname.split("/")[3]), ...body }];
      return json(res, 201, { task_id: body.other_task_id, kind: body.kind });
    }
    if (req.method === "DELETE" && /^\/api\/tasks\/\d+$/.test(url.pathname)) return json(res, 200, { ok: true });
    if (req.method === "GET" && /^\/api\/tasks\/\d+\/comments$/.test(url.pathname)) return json(res, 200, state.comment ? [{ id: 1, body: state.comment }] : []);
    if (req.method === "POST" && /^\/api\/tasks\/\d+\/comments$/.test(url.pathname)) {
      state.comment = body.body;
      return json(res, 201, { id: 1, task_id: Number(url.pathname.split("/")[3]), body: body.body });
    }
    if (req.method === "GET" && /^\/api\/tasks\/(\d+)$/.test(url.pathname)) {
      const id = Number(url.pathname.split("/")[3]);
      return json(res, 200, {
        id,
        project_id: state.projectId || 7,
        title: state.title || "Ship",
        description: state.description ?? null,
        note: state.note ?? null,
        revision: 1,
        attributes: { status: "open" },
        labels: state.labels || [],
      });
    }
    if (req.method === "GET" && /^\/api\/projects\/\d+\/tasks$/.test(url.pathname)) {
      const page = Number(url.searchParams.get("page") || 1);
      const perPage = Number(url.searchParams.get("per_page") || 50);
      const start = (page - 1) * perPage;
      const items = state.tasks.slice(start, start + perPage);
      return json(res, 200, { items, total: state.tasks.length, page, per_page: perPage });
    }
    if (req.method === "POST" && /^\/api\/projects\/\d+\/tasks$/.test(url.pathname)) {
      const task = { id: 41, project_id: 7, title: body.title, description: body.description ?? null, revision: 1, attributes: {}, labels: [] };
      state.created = task;
      return json(res, 201, task);
    }
    if (req.method === "PUT" && url.pathname === "/api/tasks/41/attributes/status") {
      if (state.failStatus) return json(res, 500, { error: "status_failed" });
      return json(res, 200, { ...state.created, revision: 1, attributes: { status: body.value } });
    }
    if (req.method === "DELETE" && url.pathname === "/api/tasks/41/attributes/status") {
      return json(res, 200, { id: 41, project_id: 7, title: "Ship", revision: 1, attributes: {} });
    }
    if (req.method === "PATCH" && url.pathname === "/api/tasks/41") {
      state.match = req.headers["if-match"] || "";
      if (state.conflict) return json(res, 409, { error: "conflict" });
      return json(res, 200, { id: 41, project_id: 7, title: body.title || "Ship", revision: 2, attributes: { status: "open" } });
    }
    json(res, 404, { error: "not_found" });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string", "no port");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function harness(baseUrl: string, root: string) {
  const connection = path.join(root, "sak.json");
  const tickets = path.join(root, "tickets.json");
  writeConnection({ baseUrl, token: "sak_testtoken" }, connection);
  const sent: Sent[] = [];
  const ctx: BoardContext = {
    files: { tickets, connections: { sak: connection, trello: path.join(root, "trello.json"), jira: path.join(root, "jira.json") }, savedBoards: path.join(root, "saved") },
    isDirectory: () => true,
    publish() {},
    sendJson(_res, status, body) {
      sent.push({ status, body });
    },
    openThread() {
      return { sessionId: "sess-1", send() {} };
    },
  };
  return { connection, tickets, sent, ctx };
}

function sakBinding(file: string): SakBinding {
  const binding = Object.values(readTickets(file).bindings)[0];
  assert.ok(binding?.provider === "sak", "no SAK binding");
  return binding;
}

test("the client sends the bearer token and refuses a remote address", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-sak-"));
  const state: FakeState = { auth: [], calls: [], tasks: [] };
  const sak = await fakeSak(state);
  try {
    const connection = path.join(root, "sak.json");
    writeConnection({ baseUrl: sak.baseUrl, token: "sak_testtoken" }, connection);
    assert.equal(statSync(connection).mode & 0o777, 0o600);
    assert.throws(() => writeConnection({ baseUrl: "https://example.com", token: "sak_testtoken" }, connection), /this machine/);
    const sent: Sent[] = [];
    await handleBoard({ method: "GET" }, {}, new URL("/api/sak/status", "http://127.0.0.1"), {}, {
      files: { tickets: path.join(root, "tickets.json"), connections: { sak: connection, trello: path.join(root, "trello.json"), jira: path.join(root, "jira.json") } },
      sendJson(_res, status, body) {
        sent.push({ status, body });
      },
    });
    assert.equal(sent[0]?.status, 200);
    assert.equal(at(sent[0]?.body, "version"), "0.2.0");
    assert.equal(at(sent[0]?.body, "reachable"), true);
    assert.equal(state.auth.at(-1), "Bearer sak_testtoken");
    assert.equal(at(sent[0]?.body, "enabled"), true);
    assert.equal(Object.hasOwn(record(sent[0]?.body), "token"), false);
  } finally {
    sak.server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a SAK that times out, cannot be reached or sends a readable code reads as SAK on the page", async () => {
  const connection = { baseUrl: "http://127.0.0.1:4345", token: "sak_testtoken", enabled: true, database: "", website: "" };
  const thrown = (error: Error): BoardFetch => async () => {
    throw error;
  };
  const cases: [BoardFetch, number, string, string | undefined][] = [
    [async () => new Response(JSON.stringify({ error: "invalid" }), { status: 400 }), 400, "invalid", undefined],
    [thrown(Object.assign(new Error("aborted"), { name: "AbortError" })), 504, "The local board did not answer", connection.baseUrl],
    [thrown(new TypeError("fetch failed")), 502, "The local board is not reachable", connection.baseUrl],
  ];
  for (const [fetchImpl, status, message, address] of cases) {
    const failure = await sakFetch(connection, "GET", "/api/health", undefined, { fetchImpl }).then(
      () => assert.fail("SAK did not fail"),
      (error: unknown) => boardFailure(error),
    );
    assert.equal(failure.status, status);
    assert.equal(failure.body.error, message);
    assert.equal(failure.body.address, address);
  }
});

test("setup can turn SAK off without dropping the saved token", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-sak-"));
  const state: FakeState = { auth: [], calls: [], tasks: [] };
  const sak = await fakeSak(state);
  try {
    const connection = path.join(root, "sak.json");
    const sent: Sent[] = [];
    const ctx: BoardContext = {
      files: { tickets: path.join(root, "tickets.json"), connections: { sak: connection, trello: path.join(root, "trello.json"), jira: path.join(root, "jira.json") } },
      sendJson(_res, status, body) {
        sent.push({ status, body });
      },
    };
    await handleBoard({ method: "PUT" }, {}, new URL("/api/sak/connection", "http://127.0.0.1"), {
      baseUrl: sak.baseUrl,
      token: "sak_testtoken",
      enabled: true,
    }, ctx);
    assert.equal(sent.at(-1)?.status, 200);
    assert.equal(at(sent.at(-1)?.body, "enabled"), true);
    assert.equal(at(sent.at(-1)?.body, "reachable"), true);
    assert.equal(Object.hasOwn(record(sent.at(-1)?.body), "token"), false);
    const healthCalls = state.calls.filter((call) => call.startsWith("GET /api/health")).length;
    sent.length = 0;
    await handleBoard({ method: "PUT" }, {}, new URL("/api/sak/connection", "http://127.0.0.1"), { enabled: false }, ctx);
    assert.equal(at(sent[0]?.body, "enabled"), false);
    assert.equal(at(sent[0]?.body, "configured"), true);
    assert.equal(at(sent[0]?.body, "reachable"), false);
    assert.equal(state.calls.filter((call) => call.startsWith("GET /api/health")).length, healthCalls);
    assert.equal(readFileSync(connection, "utf8").includes("sak_testtoken"), true);
    sent.length = 0;
    await handleBoard({ method: "GET" }, {}, new URL("/api/sak/projects", "http://127.0.0.1"), {}, ctx);
    assert.equal(sent[0]?.status, 400);
    assert.match(String(at(sent[0]?.body, "error")), /Enable the local board in Setup/);
  } finally {
    sak.server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("saving the SAK connection starts or stops SAK before the status is sent", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-sak-"));
  const order: string[] = [];
  const ctx: BoardContext = {
    files: { tickets: path.join(root, "tickets.json"), connections: { sak: path.join(root, "sak.json"), trello: path.join(root, "trello.json"), jira: path.join(root, "jira.json") } },
    sendJson(_res, status) {
      order.push(`sent ${status}`);
    },
    async syncSak() {
      order.push("sync");
    },
  };
  try {
    await handleBoard({ method: "PUT" }, {}, new URL("/api/sak/connection", "http://127.0.0.1"), {
      baseUrl: "http://127.0.0.1:4345",
      token: "sak_testtoken",
      enabled: false,
    }, ctx);
    assert.deepEqual(order, ["sync", "sent 200"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("turning SAK on with no token sets up a local SAK, and a token or a saved connection skips it", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-sak-"));
  const connection = path.join(root, "sak.json");
  let setUps = 0;
  const ctx: BoardContext = {
    files: { tickets: path.join(root, "tickets.json"), connections: { sak: connection, trello: path.join(root, "trello.json"), jira: path.join(root, "jira.json") } },
    sendJson() {},
    async setUpSak(baseUrl) {
      assert.equal(baseUrl, "http://127.0.0.1:4345");
      setUps += 1;
      writeConnection({ baseUrl: "http://127.0.0.1:4345", token: "sak_local", database: path.join(root, "sak.db") }, connection);
    },
  };
  const put = (body: Record<string, unknown>) => handleBoard({ method: "PUT" }, {}, new URL("/api/sak/connection", "http://127.0.0.1"), body, ctx);
  try {
    await put({ baseUrl: "http://127.0.0.1:4345", enabled: false });
    assert.equal(setUps, 0);
    await put({ baseUrl: "http://127.0.0.1:4345", token: "  ", enabled: true });
    assert.equal(setUps, 1);
    assert.equal(readConnection(connection).token, "sak_local");
    assert.equal(readConnection(connection).database, path.join(root, "sak.db"));
    await put({ enabled: true });
    assert.equal(setUps, 1);
    rmSync(connection);
    await put({ baseUrl: "http://127.0.0.1:4345", token: "sak_other", enabled: true });
    assert.equal(setUps, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("saving the connection keeps the database and website paths and refuses a relative database", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-sak-"));
  const connection = path.join(root, "sak.json");
  try {
    writeConnection({ baseUrl: "http://127.0.0.1:4345", token: "sak_testtoken", database: "/tmp/sak.db", website: "/tmp/sak-web" }, connection);
    assert.equal(readConnection(connection).database, "/tmp/sak.db");
    saveConnection({ enabled: false }, connection);
    assert.equal(readConnection(connection).database, "/tmp/sak.db");
    assert.equal(readConnection(connection).website, "/tmp/sak-web");
    assert.equal(readConnection(connection).enabled, false);
    assert.equal(readConnection(connection).token, "sak_testtoken");
    assert.throws(() => writeConnection({ baseUrl: "http://127.0.0.1:4345", token: "sak_testtoken", database: "sak.db" }, connection), /this machine/);
    assert.equal(readConnection(connection).database, "/tmp/sak.db");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a board request pages until the total is covered", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-sak-"));
  const tasks = Array.from({ length: 250 }, (_item, index) => ({
    id: index + 1,
    project_id: 7,
    title: `T${index + 1}`,
    attributes: { status: "open" },
    labels: [],
  }));
  const state: FakeState = { auth: [], calls: [], tasks };
  const sak = await fakeSak(state);
  try {
    const kit = harness(sak.baseUrl, root);
    await handleBoard({ method: "POST" }, {}, new URL("/api/board/boards", "http://127.0.0.1"), { cwd: root, projectId: 7 }, kit.ctx);
    kit.sent.length = 0;
    state.calls.length = 0;
    await handleBoard({ method: "GET" }, {}, new URL(`/api/board/board?cwd=${encodeURIComponent(root)}`, "http://127.0.0.1"), {}, kit.ctx);
    assert.equal(kit.sent[0]?.status, 200);
    assert.equal(list(at(kit.sent[0]?.body, "tasks")).length, 250);
    assert.equal(existsSync(path.join(root, "saved")), false);
    assert.equal(at(kit.sent[0]?.body, "truncated"), false);
    assert.deepEqual(list(at(kit.sent[0]?.body, "columns")).map((column) => at(column, "value")), ["open", "active", "review", "done", null]);
    assert.deepEqual(at(kit.sent[0]?.body, "labels"), []);
    assert.equal(state.calls.filter((call) => call.startsWith("GET /api/projects/7/tasks")).length, 2);
    const asked = await listAllTasks(async (_method, sakPath) => {
      const page = Number(new URL(sakPath, "http://127.0.0.1").searchParams.get("page"));
      return { items: Array.from({ length: 200 }, (_item, index) => ({ id: (page - 1) * 200 + index + 1 })), total: 2500 };
    }, 7, "");
    assert.equal(asked.items.length, 2000);
    assert.equal(asked.truncated, true);
  } finally {
    sak.server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("binding or unbinding a folder tells the host, so its open chats take the rules or drop them", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-sak-"));
  const sak = await fakeSak({ auth: [], calls: [], tasks: [] });
  try {
    const kit = harness(sak.baseUrl, root);
    const changed: string[] = [];
    kit.ctx.bindingChanged = (folder) => changed.push(folder);
    await handleBoard({ method: "POST" }, {}, new URL("/api/board/boards", "http://127.0.0.1"), { cwd: root, projectId: 7 }, kit.ctx);
    const [folder] = Object.keys(readTickets(kit.tickets).bindings);
    assert.deepEqual(changed, [folder]);
    await handleBoard({ method: "DELETE" }, {}, new URL("/api/board/boards", "http://127.0.0.1"), { cwd: root }, kit.ctx);
    assert.deepEqual(changed, [folder, folder]);
  } finally {
    sak.server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the board and its tickets link to SAK's pages only while SAK serves its website", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-sak-"));
  const state: FakeState = { auth: [], calls: [], tasks: [{ id: 41, project_id: 7, title: "Ship", attributes: { status: "open" }, labels: [] }] };
  const sak = await fakeSak(state);
  try {
    const kit = harness(sak.baseUrl, root);
    await handleBoard({ method: "POST" }, {}, new URL("/api/board/boards", "http://127.0.0.1"), { cwd: root, projectId: 7 }, kit.ctx);
    const links = async () => {
      kit.sent.length = 0;
      await handleBoard({ method: "GET" }, {}, new URL(`/api/board/board?cwd=${encodeURIComponent(root)}`, "http://127.0.0.1"), {}, kit.ctx);
      await handleBoard({ method: "GET" }, {}, new URL("/api/board/tasks/41", "http://127.0.0.1"), {}, kit.ctx);
      const board = kit.sent[0]?.body;
      return [at(board, "url"), at(list(at(board, "tasks"))[0], "url"), at(kit.sent[1]?.body, "task", "url")];
    };
    assert.deepEqual(await links(), [`${sak.baseUrl}/projects/7?mode=board`, `${sak.baseUrl}/tasks/41`, `${sak.baseUrl}/tasks/41`]);
    state.noSite = true;
    assert.deepEqual(await links(), [null, null, null]);
  } finally {
    sak.server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("creating a ticket sets open before the link and skips the link when status fails", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-sak-"));
  const state: FakeState = { auth: [], calls: [], tasks: [], failStatus: false, created: null };
  const sak = await fakeSak(state);
  try {
    const kit = harness(sak.baseUrl, root);
    await handleBoard({ method: "POST" }, {}, new URL("/api/board/boards", "http://127.0.0.1"), { cwd: root, title: "App" }, kit.ctx);
    assert.equal(sakBinding(kit.tickets).projectId, 8);
    kit.sent.length = 0;
    state.calls.length = 0;
    state.failStatus = true;
    await handleBoard({ method: "POST" }, {}, new URL("/api/board/tasks", "http://127.0.0.1"), {
      cwd: root,
      title: "Ship",
      sessionId: "sess-1",
    }, kit.ctx);
    assert.equal(kit.sent[0]?.status, 500);
    assert.equal(readTickets(kit.tickets).links.length, 0);
    assert.deepEqual(state.calls.map((call) => call.split("?")[0]), [
      "POST /api/projects/8/tasks",
      "PUT /api/tasks/41/attributes/status",
    ]);
  } finally {
    sak.server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a successful ticket links only after status is open", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-sak-"));
  const state: FakeState = { auth: [], calls: [], tasks: [], created: null };
  const sak = await fakeSak(state);
  try {
    const kit = harness(sak.baseUrl, root);
    await handleBoard({ method: "POST" }, {}, new URL("/api/board/boards", "http://127.0.0.1"), { cwd: root, projectId: 7 }, kit.ctx);
    state.calls.length = 0;
    kit.sent.length = 0;
    kit.ctx.origin = "http://127.0.0.1:8787";
    const named: string[][] = [];
    kit.ctx.nameChat = (sessionId, title) => named.push([sessionId, title]);
    await handleBoard({ method: "POST" }, {}, new URL("/api/board/tasks", "http://127.0.0.1"), {
      cwd: root,
      title: "Ship",
      sessionId: "sess-1",
    }, kit.ctx);
    assert.equal(kit.sent[0]?.status, 201);
    assert.deepEqual(named, [["sess-1", "Ship"]]);
    assert.equal(at(kit.sent[0]?.body, "task", "attributes", "status"), "open");
    assert.equal(at(kit.sent[0]?.body, "link", "taskId"), 41);
    assert.equal(at(kit.sent[0]?.body, "boardUrl"), boardHref("http://127.0.0.1:8787", canonicalCwd(root), 41));
    assert.deepEqual(state.calls.map((call) => call.split("?")[0]), [
      "POST /api/projects/7/tasks",
      "PUT /api/tasks/41/attributes/status",
    ]);
    const moved: Sent[] = [];
    kit.ctx.sendJson = (_res, status, body) => moved.push({ status, body });
    await handleBoard({ method: "POST" }, {}, new URL("/api/board/move", "http://127.0.0.1"), { taskId: 41, status: null }, kit.ctx);
    assert.equal(moved[0]?.status, 200);
    assert.equal(state.calls.at(-1)?.startsWith("DELETE /api/tasks/41/attributes/status"), true);
  } finally {
    sak.server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("creating a ticket without a chat leaves it unlinked until that chat starts work", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-sak-"));
  const state: FakeState = { auth: [], calls: [], tasks: [], created: null };
  const sak = await fakeSak(state);
  try {
    const kit = harness(sak.baseUrl, root);
    await handleBoard({ method: "POST" }, {}, new URL("/api/board/boards", "http://127.0.0.1"), { cwd: root, projectId: 7 }, kit.ctx);
    kit.sent.length = 0;
    kit.ctx.origin = "http://127.0.0.1:8787";
    await handleBoard({ method: "POST" }, {}, new URL("/api/board/tasks", "http://127.0.0.1"), {
      cwd: root,
      title: "Ship",
    }, kit.ctx);
    assert.equal(kit.sent[0]?.status, 201);
    assert.equal(at(kit.sent[0]?.body, "link"), null);
    assert.equal(readTickets(kit.tickets).links.length, 0);
    let published = 0;
    kit.ctx.publish = () => { published += 1; };
    kit.ctx.sessions = () => [{ id: "sess-9", cwd: root, working: true }];
    const named: string[][] = [];
    kit.ctx.nameChat = (sessionId, title) => named.push([sessionId, title]);
    kit.sent.length = 0;
    await handleBoard({ method: "POST" }, {}, new URL("/api/board/links", "http://127.0.0.1"), {
      cwd: root,
      taskId: 41,
    }, kit.ctx);
    assert.equal(kit.sent[0]?.status, 200);
    assert.equal(at(kit.sent[0]?.body, "link", "sessionId"), "sess-9");
    assert.equal(at(kit.sent[0]?.body, "link", "taskId"), 41);
    assert.equal(at(kit.sent[0]?.body, "boardUrl"), boardHref("http://127.0.0.1:8787", canonicalCwd(root), 41));
    assert.equal(published, 1);
    assert.deepEqual(named, [["sess-9", at(kit.sent[0]?.body, "link", "title")]]);
    assert.equal(readTickets(kit.tickets).links.length, 1);
  } finally {
    sak.server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a link waits for one working chat and can name that chat itself", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-sak-"));
  const state: FakeState = { auth: [], calls: [], tasks: [], created: null };
  const sak = await fakeSak(state);
  try {
    const kit = harness(sak.baseUrl, root);
    await handleBoard({ method: "POST" }, {}, new URL("/api/board/boards", "http://127.0.0.1"), { cwd: root, projectId: 7 }, kit.ctx);
    kit.sent.length = 0;
    await handleBoard({ method: "POST" }, {}, new URL("/api/board/links", "http://127.0.0.1"), { cwd: root, taskId: 41 }, kit.ctx);
    assert.equal(kit.sent[0]?.status, 400);
    assert.equal(at(kit.sent[0]?.body, "error"), "No chat is working in this folder");
    assert.equal(readTickets(kit.tickets).links.length, 0);
    kit.ctx.sessions = () => [
      { id: "a", cwd: root, working: true },
      { id: "b", cwd: root, working: true },
    ];
    kit.sent.length = 0;
    await handleBoard({ method: "POST" }, {}, new URL("/api/board/links", "http://127.0.0.1"), { cwd: root, taskId: 41 }, kit.ctx);
    assert.equal(kit.sent[0]?.status, 400);
    assert.equal(at(kit.sent[0]?.body, "error"), "More than one chat is working in this folder");
    kit.sent.length = 0;
    await handleBoard({ method: "POST" }, {}, new URL("/api/board/links", "http://127.0.0.1"), {
      cwd: root,
      taskId: 41,
      sessionId: "sess-1",
    }, kit.ctx);
    assert.equal(kit.sent[0]?.status, 200);
    assert.equal(at(kit.sent[0]?.body, "link", "sessionId"), "sess-1");
    state.projectId = 9;
    kit.sent.length = 0;
    await handleBoard({ method: "POST" }, {}, new URL("/api/board/links", "http://127.0.0.1"), {
      cwd: root,
      taskId: 42,
      sessionId: "sess-1",
    }, kit.ctx);
    assert.equal(kit.sent[0]?.status, 404);
    assert.equal(at(kit.sent[0]?.body, "error"), "That ticket is on another board");
    assert.equal(readTickets(kit.tickets).links.length, 1);
  } finally {
    sak.server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a new label is created and attached to the ticket", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-sak-"));
  const state: FakeState = { auth: [], calls: [], tasks: [], labels: [] };
  const sak = await fakeSak(state);
  try {
    const kit = harness(sak.baseUrl, root);
    await handleBoard({ method: "POST" }, {}, new URL("/api/board/boards", "http://127.0.0.1"), { cwd: root, projectId: 7 }, kit.ctx);
    kit.sent.length = 0;
    await handleBoard({ method: "POST" }, {}, new URL("/api/board/labels", "http://127.0.0.1"), { cwd: root, title: "bug", taskId: 41 }, kit.ctx);
    assert.equal(kit.sent[0]?.status, 201);
    assert.equal(at(kit.sent[0]?.body, "label", "title"), "bug");
    assert.equal(at(list(at(kit.sent[0]?.body, "task", "labels"))[0], "title"), "bug");
    assert.equal(state.calls.some((call) => call.startsWith("PUT /api/tasks/41/labels/1")), true);
    kit.sent.length = 0;
    await handleBoard({ method: "DELETE" }, {}, new URL("/api/board/tasks/41/labels/1", "http://127.0.0.1"), {}, kit.ctx);
    assert.equal(kit.sent[0]?.status, 200);
    assert.equal(at(kit.sent[0]?.body, "task", "id"), 41);
  } finally {
    sak.server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a ticket added with labels gets them, a new label keeps its color, and only this board's label is deleted", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-sak-"));
  const state: FakeState = { auth: [], calls: [], tasks: [], created: null, labels: [{ id: 1, project_id: 7, title: "bug", color: null }] };
  const sak = await fakeSak(state);
  try {
    const kit = harness(sak.baseUrl, root);
    await handleBoard({ method: "POST" }, {}, new URL("/api/board/boards", "http://127.0.0.1"), { cwd: root, projectId: 7 }, kit.ctx);
    state.calls.length = 0;
    kit.sent.length = 0;
    await handleBoard({ method: "POST" }, {}, new URL("/api/board/tasks", "http://127.0.0.1"), { cwd: root, title: "Ship", status: "review", labels: [1] }, kit.ctx);
    assert.equal(kit.sent[0]?.status, 201);
    assert.equal(record(kit.sent[0]?.body).refused, undefined);
    assert.ok(state.calls.includes("PUT /api/tasks/41/labels/1"));
    assert.equal(at(kit.sent[0]?.body, "task", "attributes", "status"), "review");
    state.calls.length = 0;
    kit.sent.length = 0;
    await handleBoard({ method: "POST" }, {}, new URL("/api/board/tasks", "http://127.0.0.1"), { cwd: root, title: "Ship", labels: ["a/b"] }, kit.ctx);
    assert.equal(kit.sent[0]?.status, 400);
    await handleBoard({ method: "POST" }, {}, new URL("/api/board/tasks", "http://127.0.0.1"), { cwd: root, title: "Ship", labels: Array.from({ length: 21 }, (_, index) => index + 1) }, kit.ctx);
    assert.deepEqual(kit.sent[1]?.body, { error: "A new ticket takes at most 20 labels", code: null });
    assert.equal(state.calls.length, 0);
    kit.sent.length = 0;
    await handleBoard({ method: "POST" }, {}, new URL("/api/board/labels", "http://127.0.0.1"), { cwd: root, title: "ui", color: "#0079BF" }, kit.ctx);
    assert.equal(at(kit.sent[0]?.body, "label", "color"), "#0079bf");
    await handleBoard({ method: "POST" }, {}, new URL("/api/board/labels", "http://127.0.0.1"), { cwd: root, title: "red", color: "red" }, kit.ctx);
    assert.equal(kit.sent[1]?.status, 400);
    kit.sent.length = 0;
    await handleBoard({ method: "DELETE" }, {}, new URL("/api/board/labels/2", "http://127.0.0.1"), { cwd: root }, kit.ctx);
    assert.deepEqual(kit.sent[0], { status: 200, body: { ok: true } });
    assert.deepEqual((state.labels || []).map((label) => label.title), ["bug"]);
    state.calls.length = 0;
    kit.sent.length = 0;
    await handleBoard({ method: "DELETE" }, {}, new URL("/api/board/labels/9", "http://127.0.0.1"), { cwd: root }, kit.ctx);
    assert.equal(kit.sent[0]?.status, 404);
    assert.equal(state.calls.some((call) => call.startsWith("DELETE")), false);
  } finally {
    sak.server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a comment keeps its line breaks and reads back from the comments route", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-sak-"));
  const state: FakeState = { auth: [], calls: [], tasks: [] };
  const sak = await fakeSak(state);
  try {
    const kit = harness(sak.baseUrl, root);
    const body = "Notes for the split.\n\n1. First point\n- a bullet";
    await handleBoard({ method: "POST" }, {}, new URL("/api/board/tasks/41/comments", "http://127.0.0.1"), { body: `  ${body}\n` }, kit.ctx);
    assert.equal(kit.sent[0]?.status, 201);
    assert.equal(state.comment, body);
    kit.sent.length = 0;
    await handleBoard({ method: "GET" }, {}, new URL("/api/board/tasks/41/comments", "http://127.0.0.1"), {}, kit.ctx);
    assert.equal(kit.sent[0]?.status, 200);
    assert.equal(at(list(at(kit.sent[0]?.body, "comments"))[0], "body"), body);
    kit.sent.length = 0;
    await handleBoard({ method: "POST" }, {}, new URL("/api/board/tasks/41/comments", "http://127.0.0.1"), { body: " \n " }, kit.ctx);
    assert.equal(kit.sent[0]?.status, 400);
    assert.equal(at(kit.sent[0]?.body, "error"), "Write a comment first");
  } finally {
    sak.server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a thread started from a card names that ticket and its column, and carries the prompt", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-sak-"));
  const state: FakeState = { auth: [], calls: [], tasks: [] };
  const sak = await fakeSak(state);
  try {
    const kit = harness(sak.baseUrl, root);
    const opened: BoardThreadRequest[] = [];
    const sent: string[] = [];
    kit.ctx.openThread = (body) => {
      opened.push(body);
      return {
        sessionId: "sess-1",
        // The prompt goes out only after the thread is linked to its ticket.
        send: () => sent.push(readTickets(kit.tickets).links.some((link) => link.sessionId === "sess-1") ? "linked" : "unlinked"),
      };
    };
    await handleBoard({ method: "POST" }, {}, new URL("/api/board/boards", "http://127.0.0.1"), { cwd: root, projectId: 7 }, kit.ctx);
    kit.sent.length = 0;
    state.title = "Ship the board starter";
    state.description = "Show the name.\nThen start.";
    state.note = "Skip comments.";
    await handleBoard({ method: "POST" }, {}, new URL("/api/board/threads", "http://127.0.0.1"), { cwd: root, taskId: 41, prompt: "  " }, kit.ctx);
    assert.deepEqual(kit.sent[0], { status: 400, body: { error: "Write the prompt first", code: null } });
    assert.equal(opened.length, 0);
    kit.sent.length = 0;
    await handleBoard({ method: "POST" }, {}, new URL("/api/board/threads", "http://127.0.0.1"), { cwd: root, taskId: 41, prompt: " Ship it.\n" }, kit.ctx);
    assert.equal(kit.sent[0]?.status, 201);
    assert.equal(opened[0]?.prompt, "Ship it.");
    assert.deepEqual(sent, ["linked"]);
    assert.deepEqual(opened[0]?.ticket, {
      id: 41,
      title: "Ship the board starter",
      status: "open",
      description: "Show the name.\nThen start.",
      note: "Skip comments.",
    });
    assert.equal(opened[0]?.cwd, canonicalCwd(root));
    assert.deepEqual(opened[0]?.picks, { provider: "", model: "", effort: "" });
    // The sheet's picks come under session, since provider in a board body names the board.
    const session = { provider: "claude", model: "opus", effort: "high" };
    await handleBoard({ method: "POST" }, {}, new URL("/api/board/threads", "http://127.0.0.1"), { cwd: root, taskId: 41, provider: "sak", session, prompt: "Go." }, kit.ctx);
    assert.deepEqual(opened[1]?.picks, session);
  } finally {
    sak.server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a conflicting ticket edit is returned as 409", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-sak-"));
  const state: FakeState = { auth: [], calls: [], tasks: [], conflict: true, match: "" };
  const sak = await fakeSak(state);
  try {
    const kit = harness(sak.baseUrl, root);
    await handleBoard({ method: "PATCH" }, {}, new URL("/api/board/tasks/41", "http://127.0.0.1"), { title: "Ship", revision: 3 }, kit.ctx);
    assert.equal(kit.sent[0]?.status, 409);
    assert.equal(state.match, "3");
    assert.equal(readFileSync(kit.connection, "utf8").includes("sak_testtoken"), true);
  } finally {
    sak.server.close();
    rmSync(root, { recursive: true, force: true });
  }
});


test("a card's brief comes back cleaned, and asking for it opens no thread", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-sak-"));
  const state: FakeState = { auth: [], calls: [], tasks: [] };
  const sak = await fakeSak(state);
  try {
    const kit = harness(sak.baseUrl, root);
    let opened = 0;
    kit.ctx.openThread = () => {
      opened += 1;
      return { sessionId: "sess-1", send() {} };
    };
    await handleBoard({ method: "POST" }, {}, new URL("/api/board/boards", "http://127.0.0.1"), { cwd: root, projectId: 7 }, kit.ctx);
    state.title = `Ship${String.fromCodePoint(0x200b)} the board starter`;
    state.description = "Show the name.\nThen start.";
    state.note = "Skip comments.";
    const url = new URL(`/api/board/tasks/41/brief?cwd=${encodeURIComponent(root)}`, "http://127.0.0.1");
    await handleBoard({ method: "GET" }, {}, url, {}, kit.ctx);
    assert.deepEqual(kit.sent.at(-1), {
      status: 200,
      body: {
        draft: [
          "Implement this ticket.",
          "",
          "## Ship the board starter",
          "",
          "Ticket 41, currently in open.",
          "",
          "Show the name.",
          "",
          "Then start.",
          "",
          "## Note",
          "",
          "Skip comments.",
        ].join("\n"),
        hidden: 1,
        title: "Ship the board starter",
      },
    });
    assert.equal(opened, 0);
    await handleBoard({ method: "GET" }, {}, new URL("/api/board/tasks/41/brief?cwd=%2Fnowhere", "http://127.0.0.1"), {}, kit.ctx);
    assert.deepEqual(kit.sent.at(-1)?.status, 404, "a folder without a board has no brief");
  } finally {
    sak.server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a ticket added from a column lands in it, the status menu lists the other columns, and SAK keeps comments as written", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-sak-"));
  const state: FakeState = { auth: [], calls: [], tasks: [], created: null };
  const sak = await fakeSak(state);
  try {
    const kit = harness(sak.baseUrl, root);
    await handleBoard({ method: "POST" }, {}, new URL("/api/board/boards", "http://127.0.0.1"), { cwd: root, projectId: 7 }, kit.ctx);
    state.calls.length = 0;
    kit.sent.length = 0;
    await handleBoard({ method: "POST" }, {}, new URL("/api/board/tasks", "http://127.0.0.1"), { cwd: root, title: "Ship", status: "review" }, kit.ctx);
    assert.equal(kit.sent[0]?.status, 201);
    assert.equal(at(kit.sent[0]?.body, "task", "attributes", "status"), "review");
    assert.equal(record(kit.sent[0]?.body).refused, undefined);
    assert.deepEqual(state.calls.map((call) => call.split("?")[0]), [
      "POST /api/projects/7/tasks",
      "PUT /api/tasks/41/attributes/status",
      "PUT /api/tasks/41/attributes/status",
    ]);
    kit.sent.length = 0;
    await handleBoard({ method: "GET" }, {}, new URL("/api/board/tasks/41/moves", "http://127.0.0.1"), {}, kit.ctx);
    assert.deepEqual(list(at(kit.sent[0]?.body, "moves")).map((move) => at(move, "status")), ["active", "review", "done", null]);
    kit.sent.length = 0;
    await handleBoard({ method: "PATCH" }, {}, new URL("/api/board/tasks/41/comments/1", "http://127.0.0.1"), { body: "Changed" }, kit.ctx);
    assert.deepEqual(kit.sent[0], { status: 400, body: { error: "The local board keeps comments as they were written", code: null } });
    kit.sent.length = 0;
    await handleBoard({ method: "DELETE" }, {}, new URL("/api/board/tasks/41/labels/a%2F..", "http://127.0.0.1"), {}, kit.ctx);
    assert.equal(kit.sent[0]?.status, 400);
    assert.equal(state.calls.some((call) => call.startsWith("DELETE /api/tasks/41 ")), false);
  } finally {
    sak.server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("board settings come with the board, tell open chats, and send a new ticket to the column picked for it", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-sak-"));
  const state: FakeState = { auth: [], calls: [], tasks: [], created: null };
  const sak = await fakeSak(state);
  try {
    const kit = harness(sak.baseUrl, root);
    const changed: string[] = [];
    kit.ctx.bindingChanged = (folder) => changed.push(folder);
    await handleBoard({ method: "POST" }, {}, new URL("/api/board/boards", "http://127.0.0.1"), { cwd: root, projectId: 7 }, kit.ctx);
    const [folder] = Object.keys(readTickets(kit.tickets).bindings);
    changed.length = 0;
    kit.sent.length = 0;
    const settings = { columns: { done: { hidden: true } }, order: ["review"], moves: { create: { status: "review", title: "review" }, start: null } };
    await handleBoard({ method: "PUT" }, {}, new URL("/api/board/settings", "http://127.0.0.1"), { cwd: root, settings: { ...settings, moves: {} } }, kit.ctx);
    assert.deepEqual(changed, [], "the rules name only the moves");
    kit.sent.length = 0;
    await handleBoard({ method: "PUT" }, {}, new URL("/api/board/settings", "http://127.0.0.1"), { cwd: root, settings }, kit.ctx);
    assert.deepEqual(at(kit.sent[0]?.body, "settings"), settings);
    assert.deepEqual(changed, [folder]);
    state.calls.length = 0;
    kit.sent.length = 0;
    await handleBoard({ method: "POST" }, {}, new URL("/api/board/tasks", "http://127.0.0.1"), { cwd: root, title: "Ship" }, kit.ctx);
    assert.equal(at(kit.sent[0]?.body, "task", "attributes", "status"), "review");
    assert.ok(state.calls.some((call) => call.startsWith("PUT /api/tasks/41/attributes/status")));
    state.calls.length = 0;
    await handleBoard({ method: "POST" }, {}, new URL("/api/board/tasks", "http://127.0.0.1"), { cwd: root, title: "Ship", status: null }, kit.ctx);
    assert.equal(state.calls.at(-1)?.startsWith("DELETE /api/tasks/41/attributes/status"), true, "a ticket added to the column without a status goes there");
    kit.sent.length = 0;
    await handleBoard({ method: "GET" }, {}, new URL(`/api/board/board?cwd=${encodeURIComponent(root)}`, "http://127.0.0.1"), {}, kit.ctx);
    assert.deepEqual(at(kit.sent[0]?.body, "settings"), settings);
    kit.sent.length = 0;
    await handleBoard({ method: "DELETE" }, {}, new URL("/api/board/settings", "http://127.0.0.1"), { cwd: root }, kit.ctx);
    assert.deepEqual(at(kit.sent[0]?.body, "settings"), { columns: {}, order: [], moves: {} });
    assert.deepEqual(changed, [folder, folder]);
    await handleBoard({ method: "PUT" }, {}, new URL("/api/board/settings", "http://127.0.0.1"), { cwd: root, settings }, kit.ctx);
    await handleBoard({ method: "POST" }, {}, new URL("/api/board/boards", "http://127.0.0.1"), { cwd: root, projectId: 7 }, kit.ctx);
    kit.sent.length = 0;
    await handleBoard({ method: "GET" }, {}, new URL(`/api/board/board?cwd=${encodeURIComponent(root)}`, "http://127.0.0.1"), {}, kit.ctx);
    assert.deepEqual(at(kit.sent[0]?.body, "settings"), { columns: {}, order: [], moves: {} }, "a folder bound again starts without the last board's settings");
  } finally {
    sak.server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a board load gives a linked chat the color the board settings keep for its ticket's column", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-sak-"));
  const task = { id: 41, project_id: 7, title: "Ship", attributes: { status: "open" }, labels: [] };
  const sak = await fakeSak({ auth: [], calls: [], tasks: [task], created: task });
  try {
    const kit = harness(sak.baseUrl, root);
    await handleBoard({ method: "POST" }, {}, new URL("/api/board/boards", "http://127.0.0.1"), { cwd: root, projectId: 7 }, kit.ctx);
    writeTickets(linkTicket(readTickets(kit.tickets), { sessionId: "sess-1", task }), kit.tickets);
    const load = () => handleBoard({ method: "GET" }, {}, new URL(`/api/board/board?cwd=${encodeURIComponent(root)}`, "http://127.0.0.1"), {}, kit.ctx);
    await load();
    assert.equal(readTickets(kit.tickets).links[0]?.color, undefined);
    await handleBoard({ method: "PUT" }, {}, new URL("/api/board/settings", "http://127.0.0.1"), { cwd: root, settings: { columns: { open: { color: "purple" }, review: { color: "green" } } } }, kit.ctx);
    await load();
    assert.equal(readTickets(kit.tickets).links[0]?.color, "#c377e0");
    await handleBoard({ method: "POST" }, {}, new URL("/api/board/links", "http://127.0.0.1"), { cwd: root, taskId: 41, sessionId: "sess-2" }, kit.ctx);
    assert.equal(readTickets(kit.tickets).links[1]?.color, "#c377e0", "a link made after the load takes the color at once");
    await handleBoard({ method: "POST" }, {}, new URL("/api/board/move", "http://127.0.0.1"), { cwd: root, taskId: 41, status: "review" }, kit.ctx);
    assert.deepEqual(readTickets(kit.tickets).links.map((link) => [link.status, link.color]), [["review", "#61bd4f"], ["review", "#61bd4f"]], "a moved ticket takes its new column's color");
    await handleBoard({ method: "PUT" }, {}, new URL("/api/board/settings", "http://127.0.0.1"), { cwd: root, settings: { columns: { open: { color: "red" } } } }, kit.ctx);
    await handleBoard({ method: "POST" }, {}, new URL("/api/board/links", "http://127.0.0.1"), { cwd: root, taskId: 41, sessionId: "sess-3" }, kit.ctx);
    assert.equal(readTickets(kit.tickets).links[2]?.color, "#eb5a46", "a link made after a color change takes the new color before any load");
  } finally {
    sak.server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a relation is created and removed in the direction SAK stores it, and SAK's refusals read plainly", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-sak-"));
  const state: FakeState = { auth: [], calls: [], tasks: [] };
  const sak = await fakeSak(state);
  try {
    const kit = harness(sak.baseUrl, root);
    const send = async (method: string, route: string, body: PageBody = {}) => {
      kit.sent.length = 0;
      state.calls.length = 0;
      await handleBoard({ method }, {}, new URL(route, "http://127.0.0.1"), body, kit.ctx);
      return kit.sent[0];
    };
    for (const kind of ["blocks", "parent", "follows", "relates", "duplicates"]) {
      const sent = await send("PUT", "/api/board/tasks/205/relations", { otherTaskId: 204, kind });
      assert.equal(sent?.status, 200);
      assert.equal(at(sent?.body, "task", "id"), 205);
    }
    for (const kind of ["subtask", "blocked_by", "precedes"]) await send("PUT", "/api/sak/tasks/204/relations", { otherTaskId: "205", kind });
    assert.deepEqual(state.relations, [
      { task: 205, other_task_id: 204, kind: "blocks" },
      { task: 205, other_task_id: 204, kind: "parent" },
      { task: 205, other_task_id: 204, kind: "follows" },
      { task: 205, other_task_id: 204, kind: "relates" },
      { task: 205, other_task_id: 204, kind: "duplicates" },
      { task: 205, other_task_id: 204, kind: "parent" },
      { task: 205, other_task_id: 204, kind: "blocks" },
      { task: 205, other_task_id: 204, kind: "follows" },
    ]);

    assert.equal((await send("DELETE", "/api/board/tasks/205/relations/204/parent"))?.status, 200);
    assert.deepEqual(state.calls.filter((call) => call.includes("/relations")), ["DELETE /api/tasks/205/relations/204/parent"]);
    assert.equal((await send("DELETE", "/api/board/tasks/204/relations/205/blocked_by"))?.status, 200);
    assert.deepEqual(state.calls.filter((call) => call.includes("/relations")), ["DELETE /api/tasks/205/relations/204/blocks"]);

    const refusals: [number, string, number, string][] = [
      [409, "parent_exists", 409, "This ticket already has a parent"],
      [409, "relation_exists", 409, "These tickets already have that relation"],
      [400, "cycle", 400, "That would make a loop"],
      [404, "not_found", 404, "There is no such ticket"],
      [401, "unauthorized", 401, "The local board refused its token"],
      [409, "conflict", 409, "Someone else edited this ticket"],
      [502, "bad_gateway", 502, "The local board is not reachable"],
      [422, "invalid_value", 422, "The local board refused the request"],
    ];
    for (const [status, error, sentStatus, message] of refusals) {
      state.refuseRelation = { status, error };
      assert.deepEqual(await send("PUT", "/api/board/tasks/205/relations", { otherTaskId: 204, kind: "parent" }), { status: sentStatus, body: { error: message, code: error } });
    }
    state.refuseRelation = { status: 404, error: "not_found" };
    assert.equal(at((await send("DELETE", "/api/board/tasks/205/relations/204/relates"))?.body, "error"), "These tickets have no such relation");
    state.refuseRelation = null;

    const asked: [string, string, PageBody, string][] = [
      ["PUT", "/api/board/tasks/205/relations", { otherTaskId: 204, kind: "child" }, "Choose a relation kind, such as parent, subtask or blocks"],
      ["PUT", "/api/board/tasks/205/relations", { otherTaskId: 204, kind: "constructor" }, "Choose a relation kind, such as parent, subtask or blocks"],
      ["PUT", "/api/board/tasks/205/relations", { otherTaskId: 205, kind: "parent" }, "A ticket can't relate to itself"],
      ["PUT", "/api/board/tasks/205/relations", { kind: "parent" }, "Choose the other ticket"],
      ["PUT", "/api/board/tasks/205/relations", { otherTaskId: "APP-1", kind: "parent" }, "Choose the other ticket"],
      ["DELETE", "/api/board/tasks/205/relations/204/child", {}, "Choose a relation kind, such as parent, subtask or blocks"],
      ["PUT", `/api/board/tasks/${"f".repeat(24)}/relations`, { otherTaskId: "e".repeat(24), kind: "parent" }, "This board has no ticket relations"],
      ["PUT", "/api/board/tasks/APP-2/relations", { otherTaskId: "APP-1", kind: "parent" }, "This board has no ticket relations"],
      ["DELETE", "/api/board/tasks/APP-2/relations/APP-1/subtask", {}, "This board has no ticket relations"],
    ];
    for (const [method, route, body, message] of asked) {
      const sent = await send(method, route, body);
      assert.equal(sent?.status, 400, route);
      assert.equal(at(sent?.body, "error"), message, route);
      assert.equal(state.calls.length, 0, `${route} reached SAK`);
    }
  } finally {
    sak.server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("opening the board's site in the app's pane sends the ticket's page and the storage that signs it in, and needs the app", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-sak-"));
  const state: FakeState = { auth: [], calls: [], tasks: [], created: null };
  const sak = await fakeSak(state);
  try {
    const kit = harness(sak.baseUrl, root);
    await handleBoard({ method: "POST" }, {}, new URL("/api/board/boards", "http://127.0.0.1"), { cwd: root, projectId: 7 }, kit.ctx);
    kit.sent.length = 0;
    await handleBoard({ method: "POST" }, {}, new URL("/api/board/open", "http://127.0.0.1"), { cwd: root, taskId: 41 }, kit.ctx);
    assert.equal(kit.sent[0]?.status, 503);
    const opened: unknown[] = [];
    kit.ctx.openBoardPage = async (page) => {
      opened.push(page);
      return { owner: "board" };
    };
    kit.sent.length = 0;
    await handleBoard({ method: "POST" }, {}, new URL("/api/board/open", "http://127.0.0.1"), { cwd: root, taskId: 41 }, kit.ctx);
    await handleBoard({ method: "POST" }, {}, new URL("/api/board/open", "http://127.0.0.1"), { cwd: root }, kit.ctx);
    assert.deepEqual(kit.sent.map((sent) => sent.body), [{ owner: "board" }, { owner: "board" }]);
    const storage = { from: `${sak.baseUrl}/api/health`, items: { "sak.token": "sak_testtoken" } };
    assert.deepEqual(opened, [
      { url: `${sak.baseUrl}/tasks/41`, storage },
      { url: `${sak.baseUrl}/projects/7?mode=board`, storage },
    ]);
    assert.equal(JSON.stringify(kit.sent).includes("sak_testtoken"), false);
  } finally {
    sak.server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a label in the route keeps its text, so a Jira label that looks like a key or an id still matches", () => {
  assert.equal(labelIdOf("7"), 7);
  assert.equal(labelIdOf("bug-7"), "bug-7");
  assert.equal(labelIdOf("ABCDEF0123456789ABCDEF01"), "ABCDEF0123456789ABCDEF01");
  assert.equal(labelIdOf("5f1a2b3c4d5e6f7a8b9c0d1e"), "5f1a2b3c4d5e6f7a8b9c0d1e");
  assert.equal(labelIdOf(encodeURIComponent("needs review")), null);
  assert.equal(labelIdOf("a%2F.."), null);
});
