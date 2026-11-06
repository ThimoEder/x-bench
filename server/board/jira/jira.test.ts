import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isRecord } from "../../../bridge/lenient.ts";
import { rulesForBoard, threadBrief } from "../boardRules.ts";
import { boardTarget } from "../boardLink.ts";
import { changeJiraLabel, jiraSite, presentColumns, readJiraConnection, resolveJiraColumn, saveJiraConnection } from "./jira.ts";
import { handleBoard, type BoardContext, type PageBody } from "../board.ts";
import { canonicalCwd } from "../../chat/sessions.ts";
import { bindBoard, bindingFor, emptyTickets, linkTicket, readTickets, writeTickets } from "../tickets.ts";
import { ticketId } from "../ticketId.ts";
import type { BoardFetch } from "../boardAdapter.ts";

interface Sent {
  status: number;
  body: unknown;
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value), "not an object");
  return value;
}

function at(value: unknown, ...keys: string[]): unknown {
  return keys.reduce((current, key) => record(current)[key], value);
}

function json(status: number, body: unknown): Response {
  return new Response(body === "" ? null : JSON.stringify(body), { status });
}

test("a Jira key is a ticket id in upper case, and other shapes are not", () => {
  assert.equal(ticketId("app-12"), "APP-12");
  assert.equal(ticketId(" MY_PROJ2-7 "), "MY_PROJ2-7");
  assert.equal(ticketId("APP-0"), null);
  assert.equal(ticketId("-12"), null);
  assert.equal(ticketId("2APP-1"), null);
  assert.equal(ticketId("APP-1-2"), null);
  assert.equal(ticketId(12), 12);
  assert.equal(ticketId("a".repeat(24)), "a".repeat(24));
  assert.equal(boardTarget("?cwd=%2Fwork%2Fapp&task=app-3").taskId, "APP-3");
});

test("the Jira site is an https origin, and plain http only on this machine", () => {
  assert.equal(jiraSite("example.atlassian.net"), "https://example.atlassian.net");
  assert.equal(jiraSite(" https://example.atlassian.net/jira/software/projects/APP/boards/1 "), "https://example.atlassian.net");
  assert.equal(jiraSite("http://127.0.0.1:9000"), "http://127.0.0.1:9000");
  assert.throws(() => jiraSite("http://example.atlassian.net"), /Enter the Jira site/);
  assert.throws(() => jiraSite("https://me:secret@example.atlassian.net"), /Enter the Jira site/);
  assert.throws(() => jiraSite(""), /Enter the Jira site/);
});

test("the Jira connection is stored for this user only and keeps the token only for the same site", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-jira-"));
  const file = path.join(root, "jira.json");
  try {
    assert.deepEqual(readJiraConnection(file), { site: "", email: "", token: "", enabled: false });
    assert.throws(() => saveJiraConnection({ baseUrl: "example.atlassian.net", email: "me@example.com" }, file), /email and API token/);
    saveJiraConnection({ baseUrl: "example.atlassian.net", email: "me@example.com", token: "tok" }, file);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    saveJiraConnection({ enabled: false }, file);
    assert.deepEqual(readJiraConnection(file), { site: "https://example.atlassian.net", email: "me@example.com", token: "tok", enabled: false });
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).token, "tok");
    saveJiraConnection({ baseUrl: "https://example.atlassian.net/jira/software", enabled: true }, file);
    assert.equal(readJiraConnection(file).token, "tok");
    assert.throws(() => saveJiraConnection({ baseUrl: "attacker.example.com" }, file), /email and API token/);
    assert.equal(readJiraConnection(file).site, "https://example.atlassian.net");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("board columns keep Jira's order and get a unique title each", () => {
  assert.deepEqual(presentColumns([
    { name: "To Do", statuses: [{ id: "1" }] },
    { name: "Doing", statuses: [{ id: "2" }, { id: "3" }] },
    { name: "Doing", statuses: [] },
    { name: "  ", statuses: [{ id: "4" }] },
  ]), [
    { title: "To Do", statuses: ["1"] },
    { title: "Doing", statuses: ["2", "3"] },
    { title: "Doing 2", statuses: [] },
  ]);
});

test("a Jira binding round-trips, and a chat can link to an issue key", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-jira-"));
  const file = path.join(root, "tickets.json");
  try {
    const bound = bindBoard(emptyTickets(), "/work/app", { provider: "jira", boardId: "12", title: "App board", projectKey: "app", columns: ["To Do", "Done", 3] });
    const linked = linkTicket(bound, { sessionId: "s", task: { id: "app-4", title: "Probe", linkStatus: "To Do" } });
    writeTickets(linked, file);
    const read = readTickets(file);
    assert.deepEqual(bindingFor(read, "/work/app"), { provider: "jira", boardId: 12, title: "App board", projectKey: "APP", columns: ["To Do", "Done"] });
    assert.equal(read.links[0]?.taskId, "APP-4");
    assert.equal(bindingFor(bindBoard(emptyTickets(), "/work/app", { provider: "jira", boardId: "x" }), "/work/app"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Jira board's rules name only its In Progress and Done columns and say a move can be refused", () => {
  const state = bindBoard(emptyTickets(), "/tmp/app", { provider: "jira", boardId: 12, title: "App", projectKey: "APP", columns: ["To Do", "In Progress", "Done"] });
  const rules = rulesForBoard(state, "/tmp/app", "http://127.0.0.1:8787", { id: "APP-3" }, "/tmp/token");
  assert.match(rules, /Jira board/);
  assert.match(rules, /Do not call Jira directly/);
  assert.doesNotMatch(rules, /To Do/);
  assert.match(rules, /Starting work on a ticket moves it to In Progress\. .*\{"taskId":"<key>","status":"In Progress"\}/);
  assert.match(rules, /"status":"Done"/);
  assert.match(rules, /workflow/);
  assert.match(rules, /POST \/api\/board\/tasks\/<key>\/files\?name=<file name>.*with !<file name>!\./);
  assert.match(rules, /ticket APP-3/);
  assert.match(rules, /X-Bench-Token/);
  assert.match(threadBrief({ id: "APP-3", title: "Ship", status: "To Do" }), /Ticket APP-3, currently in To Do\./);
});

test("a column and a label are found again from the spelling a board reply gives them, without hidden characters", async () => {
  const columns = presentColumns([
    { name: "\u{1F6E0}\uFE0F Re\u200Bview", statuses: [{ id: "3" }] },
    { name: "Done\u200B", statuses: [{ id: "4" }] },
    { name: "Done", statuses: [{ id: "5" }] },
  ]);
  assert.deepEqual(columns.map((column) => column.title), ["\u{1F6E0}\uFE0F Review", "Done", "Done 2"]);
  assert.equal(resolveJiraColumn(columns, "\u{1F6E0}\uFE0F review"), columns[0]);
  assert.equal(resolveJiraColumn(columns, "Done 2"), columns[2]);
  const bodies: unknown[] = [];
  const issue = { key: "APP-7", fields: { summary: "Probe", status: { id: "3" }, labels: ["bug\u200Bfix", "bugfix-later"] } };
  const fetchImpl: BoardFetch = async (_url, init) => {
    if (init?.method === "PUT") bodies.push(JSON.parse(String(init.body)));
    return json(init?.method === "PUT" ? 204 : 200, init?.method === "PUT" ? "" : issue);
  };
  const connection = { site: "https://example.atlassian.net", email: "me@example.com", token: "tok", enabled: true };
  await changeJiraLabel(connection, "APP-7", "bugfix", false, columns, { fetchImpl });
  await changeJiraLabel(connection, "APP-7", "bugfix", true, columns, { fetchImpl });
  issue.fields.labels = ["bug\u200Bfix", "bugfix"];
  await changeJiraLabel(connection, "APP-7", "bugfix", false, columns, { fetchImpl });
  assert.deepEqual(bodies, [
    { update: { labels: [{ remove: "bug\u200Bfix" }] } },
    { update: { labels: [{ add: "bugfix" }] } },
    { update: { labels: [{ remove: "bugfix" }] } },
  ]);
});

test("the board routes bind a folder to a Jira board, load it with its capabilities, and take issue keys", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-jira-route-"));
  const folder = canonicalCwd(root);
  mkdirSync(path.join(root, "tree"));
  const tree = canonicalCwd(path.join(root, "tree"));
  const calls: string[] = [];
  const issue = {
    key: "APP-7",
    fields: {
      summary: "Probe",
      description: "Line one\nLine two",
      status: { id: "1", name: "To Do" },
      labels: [],
      updated: "2026-10-01T10:00:00.000+0000",
      project: { id: "100", key: "APP" },
    },
  };
  const fetchImpl: BoardFetch = async (url, init) => {
    const parsed = new URL(url);
    calls.push(`${init?.method || "GET"} ${parsed.pathname}`);
    if (parsed.pathname === "/rest/api/2/myself") {
      return init?.headers?.Authorization === `Basic ${Buffer.from("me@example.com:tok").toString("base64")}`
        ? json(200, { displayName: "Me" })
        : json(401, {});
    }
    if (parsed.pathname === "/rest/agile/1.0/board") return json(200, { values: [{ id: 12, name: "App board", location: { projectKey: "APP" } }], isLast: true });
    if (parsed.pathname === "/rest/agile/1.0/board/12") return json(200, { id: 12, name: "App board", location: { projectKey: "APP" } });
    if (parsed.pathname === "/rest/agile/1.0/board/12/configuration") {
      return json(200, { columnConfig: { columns: [{ name: "To Do", statuses: [{ id: "1" }] }, { name: "Done", statuses: [{ id: "2" }] }] } });
    }
    if (parsed.pathname === "/rest/agile/1.0/board/12/issue") return json(200, { total: 1, issues: [issue] });
    if (parsed.pathname === "/rest/api/2/issue/APP-7") return json(200, issue);
    if (parsed.pathname === "/rest/api/2/issue/APP-7/comment") return json(200, { total: 1, comments: [{ id: "9", body: "Hi" }] });
    if (parsed.pathname === "/rest/api/2/issue/APP-7/transitions") return json(200, { transitions: [] });
    return json(404, { errorMessages: ["Not found"] });
  };
  const sent: Sent[] = [];
  const ctx: BoardContext = {
    files: { tickets: path.join(root, "tickets.json"), connections: { sak: path.join(root, "sak.json"), trello: path.join(root, "trello.json"), jira: path.join(root, "jira.json") } },
    fetchOptions: { fetchImpl },
    isDirectory: () => true,
    projectHome: (cwd) => (cwd === tree ? folder : cwd),
    sendJson(_res, status, body) {
      sent.push({ status, body });
    },
  };
  const send = async (method: string, route: string, body: PageBody = {}) => {
    await handleBoard({ method }, {}, new URL(route, "http://127.0.0.1"), body, ctx);
    const last = sent.at(-1);
    assert.ok(last, "no reply");
    return last;
  };
  try {
    const off = await send("GET", "/api/jira/status");
    assert.deepEqual(off.body, { configured: false, enabled: false, site: "", email: "", reachable: false, name: null });
    const saved = await send("PUT", "/api/jira/connection", { baseUrl: "example.atlassian.net", email: "me@example.com", token: "tok" });
    assert.equal(at(saved.body, "reachable"), true);
    assert.equal(at(saved.body, "name"), "Me");
    assert.equal(JSON.stringify(saved.body).includes("tok\""), false);
    assert.deepEqual((await send("GET", "/api/jira/boards")).body, [{ id: 12, title: "App board", project: "APP" }]);
    assert.equal((await send("POST", "/api/board/boards", { cwd: folder, provider: "jira", title: "New" })).status, 400);
    const bound = await send("POST", "/api/board/boards", { cwd: folder, provider: "jira", boardId: 12 });
    assert.deepEqual(bound, { status: 201, body: { provider: "jira", boardId: 12, title: "App board" } });
    const board = await send("GET", `/api/board/board?cwd=${encodeURIComponent(folder)}`);
    assert.equal(at(board.body, "provider"), "jira");
    assert.equal(at(board.body, "source"), "Jira");
    assert.equal(at(board.body, "url"), "https://example.atlassian.net/secure/RapidBoard.jspa?rapidView=12");
    assert.deepEqual(at(board.body, "capabilities"), {
      notes: false,
      moves: "transitions",
      conditionalFetch: true,
      local: false,
      columnColors: false,
      labels: true,
      standaloneLabels: false,
      labelColors: false,
      labelDeletes: false,
      deletes: true,
      types: true,
      assignees: true,
      dueDates: true,
      priority: true,
      subtasks: true,
      checklists: false,
      relations: false,
      commentEdits: true,
      embedsByName: true,
      signedInPages: false,
      archives: false,
      assigneeLabel: "Assignee",
      badge: "key",
    });
    assert.deepEqual(at(board.body, "columns"), [{ value: "To Do", title: "To Do" }, { value: "Done", title: "Done" }]);
    const detail = await send("GET", "/api/board/tasks/app-7");
    assert.equal(at(detail.body, "task", "id"), "APP-7");
    assert.equal(at(detail.body, "task", "description"), "Line one\nLine two");
    assert.deepEqual(at(detail.body, "comments"), [{ id: "9", body: "Hi", author: null, created: null, mine: false }]);
    const move = await send("POST", "/api/board/move", { cwd: folder, taskId: "APP-7", status: "done" });
    assert.deepEqual(move, { status: 409, body: { error: "Jira's workflow has no move from To Do to Done", code: "jira" } });
    // A worktree without a binding of its own moves tickets on its checkout's board.
    assert.deepEqual(await send("POST", "/api/board/move", { cwd: tree, taskId: "APP-7", status: "done" }), move);
    const removed = await send("DELETE", "/api/board/tasks/APP-7");
    assert.deepEqual(removed, { status: 200, body: { ok: true } });
    assert.equal(calls.filter((call) => call.startsWith("DELETE")).join(), "DELETE /rest/api/2/issue/APP-7");
    const unknown = await send("GET", "/api/board/tasks/APP-1-2");
    assert.equal(unknown.status, 400);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
