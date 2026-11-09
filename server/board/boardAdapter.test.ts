import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isRecord } from "../../bridge/lenient.ts";
import { boardFailure, responseJson, type BoardAdapter, type BoardFetch, type BoardFetchInit, type BoardServices, type BoundBoard, type TicketEdit } from "./boardAdapter.ts";
import { sakAdapter } from "./sak/sakAdapter.ts";
import { sakFetch, writeConnection } from "./sak/sakClient.ts";
import { canonicalCwd } from "../chat/sessions.ts";
import { writeJiraConnection } from "./jira/jira.ts";
import { jiraAdapter } from "./jira/jiraAdapter.ts";
import { bindBoard, bindingFor, emptyTickets, readTickets, writeTickets } from "./tickets.ts";
import type { BoardBinding } from "./sources.ts";
import { ticketId, type TicketId } from "./ticketId.ts";
import { writeTrelloConnection } from "./trello/trello.ts";
import { trelloAdapter } from "./trello/trelloAdapter.ts";

// One contract for every board source. Each kit binds a temp folder to a fake backend
// held in memory and says which column values its board uses.
interface Kit {
  adapter: BoardAdapter;
  board: BoundBoard;
  folder: string;
  tickets: string;
  // A ticket already on the board.
  seeded: TicketId;
  // The status of a new ticket.
  intake: string;
  // What a move sends, and the status the ticket has after it.
  moveTo: string;
  moved: string;
  // A column the board does not have.
  nowhere: string;
  // A column the workflow does not let the ticket move to after moveTo, or null when every move is allowed.
  refused: string | null;
  // Ids the other sources own.
  foreign: TicketId[];
  // An id of this source's form that is on no board.
  missing: TicketId;
  // Makes child a sub-task of parent, where the source keeps sub-tasks as their own tickets.
  relate?: (parent: TicketId, child: TicketId) => void;
  close(): void;
}

interface Reply {
  status: number;
  body: unknown;
  bytes?: Uint8Array<ArrayBuffer>;
  headers?: Record<string, string>;
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value), "not an object");
  return value;
}

// Walks down a value. Fails the test when a step is not an object.
function at(value: unknown, ...keys: string[]): unknown {
  return keys.reduce((current, key) => record(current)[key], value);
}

function list(value: unknown): unknown[] {
  assert.ok(Array.isArray(value), "not a list");
  return value;
}

function id(value: unknown): TicketId {
  const parsed = ticketId(value);
  assert.ok(parsed !== null, "not a ticket id");
  return parsed;
}

// A label id as a source sent it: a ticket-style id, or for Jira the label's own word.
function labelKey(value: unknown): TicketId {
  assert.ok(typeof value === "string" || typeof value === "number", "not a label id");
  return value;
}

function titles(task: unknown): unknown[] {
  return list(at(task, "labels")).map((label) => at(label, "title"));
}

function reply({ status, body, bytes, headers }: Reply): Response {
  return new Response(status === 204 ? null : (bytes ?? JSON.stringify(body)), { status, headers });
}

function readJson(init: BoardFetchInit | undefined): Record<string, unknown> {
  return typeof init?.body === "string" ? record(JSON.parse(init.body)) : {};
}

interface FakeFile {
  id: string;
  ticket: string;
  name: string;
  bytes: Uint8Array<ArrayBuffer>;
}

function fakeFiles(nextId: () => string) {
  const stored: FakeFile[] = [];
  return {
    async add(ticket: string, init: BoardFetchInit | undefined, named = ""): Promise<FakeFile> {
      const body = init?.body;
      const file = body instanceof FormData ? body.get("file") : body;
      assert.ok(file instanceof Blob, "no file in the upload");
      const added = { id: nextId(), ticket, name: named || (file instanceof File ? file.name : ""), bytes: new Uint8Array(await file.arrayBuffer()) };
      stored.push(added);
      return added;
    },
    on: (ticket: string) => stored.filter((file) => file.ticket === ticket),
    find: (id: string | undefined) => stored.find((file) => file.id === id),
    remove(file: FakeFile) {
      stored.splice(stored.indexOf(file), 1);
    },
  };
}

function fileReply(file: FakeFile, init: BoardFetchInit | undefined): Reply {
  const headers = { "Content-Type": "image/png", "Accept-Ranges": "bytes" };
  const range = /^bytes=(\d+)-(\d+)$/.exec(init?.headers?.Range ?? "");
  if (!range) return { status: 200, body: null, bytes: file.bytes, headers };
  const start = Number(range[1]);
  const end = Number(range[2]);
  return { status: 206, body: null, bytes: file.bytes.slice(start, end + 1), headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${file.bytes.length}` } };
}

function services(root: string, fetchImpl: BoardFetch): BoardServices {
  return {
    files: {
      tickets: path.join(root, "tickets.json"),
      connections: {
        sak: path.join(root, "sak.json"),
        trello: path.join(root, "trello.json"),
        jira: path.join(root, "jira.json"),
      },
    },
    fetchOptions: { fetchImpl },
    folderOf: (cwd) => canonicalCwd(String(cwd || "")),
  };
}

// SAK: project 7 with a status enum, tasks with a revision checked through If-Match.
function sakKit(): Kit {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-contract-sak-"));
  const statuses = ["open", "active", "review", "done"];
  interface Task {
    id: number;
    project_id: number;
    title: string;
    description: string | null;
    note: string | null;
    revision: number;
    attributes: Record<string, string>;
    labels: { id: number; title: string }[];
    relations: { task_id: number; kind: string }[];
  }
  const tasks = new Map<number, Task>();
  const labels: { id: number; project_id: number; title: string; color: string | null }[] = [];
  const comments = new Map<number, { id: number; body: string; created_at: string }[]>();
  const options = statuses.map((value, index) => ({ id: index + 1, value, position: index + 1 }));
  const defs: { id: number; name: string; type: string; options?: unknown[] }[] = [{ id: 1, name: "status", type: "enum", options }];
  // How the other end reads a relation, for every spelling.
  const readAs: Record<string, string> = {
    blocks: "blocked_by",
    blocked_by: "blocks",
    parent: "subtask",
    subtask: "parent",
    follows: "precedes",
    precedes: "follows",
    relates: "relates",
    duplicates: "duplicates",
  };
  let next = 40;
  const add = (title: string, status?: string): Task => {
    next += 1;
    const task: Task = { id: next, project_id: 7, title, description: null, note: null, revision: 1, attributes: status ? { status } : {}, labels: [], relations: [] };
    tasks.set(task.id, task);
    return task;
  };
  add("Seeded", "open");
  const answer = (method: string, url: URL, init: BoardFetchInit | undefined): Reply => {
    const body = readJson(init);
    const parts = url.pathname.split("/").slice(2);
    const task = parts[0] === "tasks" ? tasks.get(Number(parts[1])) : undefined;
    if (method === "GET" && url.pathname === "/api/projects/7") return { status: 200, body: { id: 7, title: "App" } };
    if (method === "GET" && url.pathname === "/api/projects/7/attributes") return { status: 200, body: defs };
    if (method === "POST" && url.pathname === "/api/projects/7/attributes") {
      const def = { id: defs.length + 1, name: String(body.name), type: String(body.type) };
      defs.push(def);
      return { status: 201, body: def };
    }
    if (method === "GET" && url.pathname === "/api/projects/7/labels") return { status: 200, body: labels };
    if (method === "POST" && url.pathname === "/api/projects/7/labels") {
      const label = { id: labels.length + 1, project_id: 7, title: String(body.title), color: typeof body.color === "string" ? body.color : null };
      labels.push(label);
      return { status: 201, body: label };
    }
    const deleted = /^\/api\/labels\/(\d+)$/.exec(url.pathname);
    if (method === "DELETE" && deleted) {
      const index = labels.findIndex((item) => item.id === Number(deleted[1]));
      if (index < 0) return { status: 404, body: { error: "not_found" } };
      labels.splice(index, 1);
      for (const item of tasks.values()) item.labels = item.labels.filter((label) => label.id !== Number(deleted[1]));
      return { status: 200, body: { ok: true } };
    }
    if (method === "GET" && url.pathname === "/api/projects/7/tasks") {
      const items = [...tasks.values()];
      return { status: 200, body: { items, total: items.length } };
    }
    if (method === "POST" && url.pathname === "/api/projects/7/tasks") {
      const created = add(String(body.title));
      if (typeof body.description === "string") created.description = body.description;
      return { status: 201, body: created };
    }
    if (!task) return { status: 404, body: { error: "not_found" } };
    const rest = parts.slice(2).join("/");
    if (method === "GET" && rest === "") return { status: 200, body: task };
    if (method === "DELETE" && rest === "") {
      tasks.delete(task.id);
      return { status: 200, body: { ok: true } };
    }
    if (method === "PUT" && rest === "attributes/status") {
      if (!statuses.includes(String(body.value))) return { status: 422, body: { error: "invalid_value" } };
      task.attributes = { ...task.attributes, status: String(body.value) };
      task.revision += 1;
      return { status: 200, body: task };
    }
    const attribute = /^attributes\/(\w+)$/.exec(rest)?.[1];
    if (method === "PUT" && attribute) {
      const def = defs.find((item) => item.name === attribute);
      if (!def) return { status: 404, body: { error: "not_found" } };
      if (def.type === "number" && !/^-?\d+(\.\d+)?$/.test(String(body.value))) return { status: 400, body: { error: "invalid_value" } };
      task.attributes = { ...task.attributes, [attribute]: String(body.value) };
      return { status: 200, body: task };
    }
    if (method === "PATCH" && rest === "") {
      if (init?.headers?.["If-Match"] !== String(task.revision)) return { status: 409, body: { error: "conflict" } };
      if (typeof body.title === "string") task.title = body.title;
      if (body.description !== undefined) task.description = typeof body.description === "string" ? body.description : null;
      if (body.note !== undefined) task.note = typeof body.note === "string" ? body.note : null;
      task.revision += 1;
      return { status: 200, body: task };
    }
    const label = labels.find((item) => rest === `labels/${item.id}`);
    if (label && method === "PUT") {
      if (!task.labels.some((item) => item.id === label.id)) task.labels.push({ id: label.id, title: label.title });
      return { status: 200, body: { ok: true } };
    }
    if (label && method === "DELETE") {
      task.labels = task.labels.filter((item) => item.id !== label.id);
      return { status: 200, body: { ok: true } };
    }
    if (method === "PUT" && rest === "relations") {
      const other = tasks.get(Number(body.other_task_id));
      const kind = String(body.kind);
      const spelling = readAs[kind];
      if (!other) return { status: 404, body: { error: "not_found" } };
      if (!spelling || other.id === task.id) return { status: 400, body: { error: "bad_request" } };
      if (task.relations.some((item) => item.task_id === other.id && item.kind === kind)) return { status: 409, body: { error: "relation_exists" } };
      if (kind === "parent") {
        if (task.relations.some((item) => item.kind === "parent")) return { status: 409, body: { error: "parent_exists" } };
        for (let up: Task | undefined = other; up; up = tasks.get(up.relations.find((item) => item.kind === "parent")?.task_id ?? 0)) {
          if (up.id === task.id) return { status: 400, body: { error: "cycle" } };
        }
      }
      task.relations.push({ task_id: other.id, kind });
      other.relations.push({ task_id: task.id, kind: spelling });
      return { status: 201, body: { task_id: other.id, kind } };
    }
    const unrelated = /^relations\/(\d+)\/([a-z_]+)$/.exec(rest);
    if (method === "DELETE" && unrelated) {
      const other = tasks.get(Number(unrelated[1]));
      const kind = unrelated[2] ?? "";
      const index = task.relations.findIndex((item) => item.task_id === other?.id && item.kind === kind);
      if (!other || index < 0) return { status: 404, body: { error: "not_found" } };
      task.relations.splice(index, 1);
      other.relations = other.relations.filter((item) => item.task_id !== task.id || item.kind !== readAs[kind]);
      return { status: 200, body: { ok: true } };
    }
    if (method === "GET" && rest === "comments") return { status: 200, body: comments.get(task.id) || [] };
    if (method === "POST" && rest === "comments") {
      const comment = { id: (comments.get(task.id) || []).length + 1, body: String(body.body), created_at: "2026-10-02T09:20:00.004Z" };
      comments.set(task.id, [...(comments.get(task.id) || []), comment]);
      return { status: 201, body: comment };
    }
    return { status: 404, body: { error: "not_found" } };
  };
  let fileSerial = 0;
  const files = fakeFiles(() => String((fileSerial += 1)));
  const sakFile = (file: FakeFile) => ({ id: Number(file.id), task_id: Number(file.ticket), name: file.name, content_type: "image/png", size: file.bytes.length, url: `/api/files/${file.id}` });
  const fetchImpl: BoardFetch = async (url, init) => {
    assert.equal(init?.headers?.Authorization, "Bearer sak_contract");
    const parsed = new URL(url);
    const method = init?.method || "GET";
    const owner = /^\/api\/tasks\/(\d+)\/files$/.exec(parsed.pathname)?.[1];
    if (owner && method === "POST") return reply({ status: 201, body: sakFile(await files.add(owner, init, parsed.searchParams.get("name") ?? "")) });
    if (owner && method === "GET") return reply({ status: 200, body: files.on(owner).map(sakFile) });
    const file = files.find(/^\/api\/files\/(\d+)$/.exec(parsed.pathname)?.[1]);
    if (file && method === "GET") return reply(fileReply(file, init));
    if (file && method === "DELETE") {
      files.remove(file);
      return reply({ status: 200, body: { ok: true } });
    }
    return reply(answer(method, parsed, init));
  };
  const kit = services(root, fetchImpl);
  writeConnection({ baseUrl: "http://127.0.0.1:4345", token: "sak_contract" }, kit.files.connections.sak);
  const folder = canonicalCwd(root);
  writeTickets(bindBoard(emptyTickets(), folder, { provider: "sak", projectId: 7, title: "App" }), kit.files.tickets);
  const adapter = sakAdapter(kit);
  const binding = bindingFor(readTickets(kit.files.tickets), folder);
  assert.ok(binding, "no binding");
  const board = adapter.open(folder, binding);
  assert.ok(board, "the SAK adapter did not open its binding");
  return {
    adapter,
    board,
    folder,
    tickets: kit.files.tickets,
    seeded: 41,
    intake: "open",
    moveTo: "active",
    moved: "active",
    nowhere: "someday",
    refused: null,
    foreign: ["f".repeat(24), "APP-1"],
    missing: 999,
    relate(parent, child) {
      tasks.get(Number(parent))?.relations.push({ task_id: Number(child), kind: "subtask" });
      tasks.get(Number(child))?.relations.push({ task_id: Number(parent), kind: "parent" });
    },
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

// Trello: one board with four lists, cards whose revision is the last activity.
function trelloKit(): Kit {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-contract-trello-"));
  let serial = 0;
  const hex = () => {
    serial += 1;
    return serial.toString(16).padStart(24, "0");
  };
  let clock = Date.parse("2026-09-28T10:00:00.000Z");
  const stamp = () => {
    clock += 1000;
    return new Date(clock).toISOString();
  };
  const boardId = hex();
  const lists = ["Open", "Active", "Review", "Done"].map((name, index) => ({ id: hex(), name, pos: (index + 1) * 16384, closed: false }));
  const listId = (name: string) => lists.find((item) => item.name === name)?.id || "";
  interface Card {
    id: string;
    name: string;
    desc: string;
    idList: string;
    idBoard: string;
    dateLastActivity: string;
    idShort: number;
    closed: boolean;
    idLabels: string[];
    idMembers: string[];
    due: string | null;
    dueComplete: boolean;
    badges: { comments: number; checkItems: number; checkItemsChecked: number };
    pos: number;
    shortUrl: string;
  }
  interface CheckList {
    id: string;
    name: string;
    pos: number;
    checkItems: { id: string; name: string; state: string; pos: number }[];
  }
  const checklists = new Map<string, CheckList[]>();
  const countChecks = (card: Card) => {
    const items = (checklists.get(card.id) || []).flatMap((item) => item.checkItems);
    card.badges.checkItems = items.length;
    card.badges.checkItemsChecked = items.filter((item) => item.state === "complete").length;
  };
  const cards = new Map<string, Card>();
  const labels: { id: string; name: string; color: string }[] = [];
  const me = { id: "c".repeat(24), fullName: "Thimo Eder" };
  interface Comment {
    id: string;
    date: string;
    idMemberCreator: string;
    memberCreator: { id: string; fullName: string };
    data: { text: string };
  }
  const comments = new Map<string, Comment[]>();
  let boardActivity = stamp();
  const add = (name: string, idList: string): Card => {
    boardActivity = stamp();
    const pos = (Math.max(0, ...[...cards.values()].map((item) => item.pos)) || 0) + 65536;
    const id = hex();
    const card: Card = {
      id,
      name,
      desc: "",
      idList,
      idBoard: boardId,
      dateLastActivity: boardActivity,
      idShort: cards.size + 1,
      closed: false,
      idLabels: [],
      idMembers: [me.id],
      due: "2026-09-30T16:00:00.000Z",
      dueComplete: false,
      badges: { comments: 0, checkItems: 0, checkItemsChecked: 0 },
      pos,
      shortUrl: `https://trello.com/c/${id.slice(-8)}`,
    };
    cards.set(card.id, card);
    return card;
  };
  const seeded = add("Seeded", listId("Open"));
  // Trello sends checklists and their items in any order; pos orders them.
  checklists.set(seeded.id, [{
    id: hex(),
    name: "Launch",
    pos: 1,
    checkItems: [
      { id: hex(), name: "Translate", state: "incomplete", pos: 2 },
      { id: hex(), name: "Write copy", state: "complete", pos: 1 },
    ],
  }]);
  countChecks(seeded);
  const touch = (card: Card) => {
    boardActivity = stamp();
    card.dateLastActivity = boardActivity;
  };
  const answer = (method: string, url: URL, init: BoardFetchInit | undefined): Reply => {
    const body = readJson(init);
    const parts = url.pathname.split("/").slice(2);
    if (method === "GET" && url.pathname === `/1/boards/${boardId}`) {
      if (url.searchParams.get("fields") === "dateLastActivity") return { status: 200, body: { dateLastActivity: boardActivity } };
      return {
        status: 200,
        body: {
          id: boardId,
          name: "Remote",
          shortUrl: "https://trello.com/b/remote",
          dateLastActivity: boardActivity,
          lists,
          labels,
          members: [me],
          cards: [...cards.values()].filter((card) => !card.closed).sort((a, b) => b.pos - a.pos),
        },
      };
    }
    if (method === "GET" && url.pathname === `/1/boards/${boardId}/labels`) return { status: 200, body: labels };
    if (method === "POST" && url.pathname === "/1/labels") {
      const label = { id: hex(), name: String(body.name), color: String(body.color) };
      labels.push(label);
      return { status: 200, body: label };
    }
    if (method === "GET" && url.pathname === "/1/members/me") return { status: 200, body: { id: me.id } };
    const action = parts[0] === "actions" ? [...comments.values()].flat().find((item) => item.id === parts[1]) : undefined;
    if (action && method === "PUT") {
      action.data.text = String(body.text);
      return { status: 200, body: action };
    }
    if (action && method === "DELETE") {
      for (const [key, items] of comments) comments.set(key, items.filter((item) => item !== action));
      return { status: 200, body: { _value: null } };
    }
    const checklist = parts[0] === "checklists" ? [...checklists.values()].flat().find((item) => item.id === parts[1]) : undefined;
    if (checklist && method === "POST" && parts[2] === "checkItems") {
      checklist.checkItems.push({ id: hex(), name: String(body.name), state: "incomplete", pos: Math.max(0, ...checklist.checkItems.map((item) => item.pos)) + 1 });
      for (const card of cards.values()) countChecks(card);
      return { status: 200, body: {} };
    }
    if (method === "POST" && url.pathname === "/1/cards") {
      const card = add(String(body.name), String(body.idList));
      if (typeof body.desc === "string") card.desc = body.desc;
      return { status: 200, body: card };
    }
    const card = parts[0] === "cards" ? cards.get(String(parts[1])) : undefined;
    if (!card) return { status: 404, body: { message: "The requested resource was not found." } };
    const rest = parts.slice(2).join("/");
    if (method === "GET" && rest === "") {
      return { status: 200, body: url.searchParams.get("members") === "true" ? { ...card, members: [me] } : card };
    }
    if (method === "GET" && rest === "labels") return { status: 200, body: labels.filter((label) => card.idLabels.includes(label.id)) };
    if (method === "GET" && rest === "checklists") return { status: 200, body: checklists.get(card.id) || [] };
    const checkItem = rest.startsWith("checkItem/") ? (checklists.get(card.id) || []).flatMap((item) => item.checkItems).find((item) => item.id === parts[3]) : undefined;
    if (checkItem && method === "PUT") {
      checkItem.state = String(body.state);
      countChecks(card);
      touch(card);
      return { status: 200, body: checkItem };
    }
    if (method === "PUT" && rest === "") {
      if (typeof body.idList === "string") {
        if (!lists.some((item) => item.id === body.idList)) return { status: 400, body: { message: "invalid value for idList" } };
        card.idList = body.idList;
      }
      if (typeof body.name === "string") card.name = body.name;
      if (typeof body.desc === "string") card.desc = body.desc;
      if (body.closed === true) card.closed = true;
      if (typeof body.pos === "number") card.pos = body.pos;
      if (body.pos === "bottom") card.pos = Math.max(...[...cards.values()].map((item) => item.pos)) + 65536;
      touch(card);
      return { status: 200, body: card };
    }
    if (method === "POST" && rest === "idLabels") {
      if (!card.idLabels.includes(String(body.value))) card.idLabels.push(String(body.value));
      touch(card);
      return { status: 200, body: card.idLabels };
    }
    if (method === "DELETE" && rest.startsWith("idLabels/")) {
      card.idLabels = card.idLabels.filter((item) => item !== parts[3]);
      touch(card);
      return { status: 200, body: { _value: null } };
    }
    if (method === "GET" && rest === "actions") return { status: 200, body: [...(comments.get(card.id) || [])].reverse() };
    if (method === "POST" && rest === "actions/comments") {
      const comment = { id: hex(), date: stamp(), idMemberCreator: me.id, memberCreator: me, data: { text: String(body.text) } };
      comments.set(card.id, [...(comments.get(card.id) || []), comment]);
      card.badges.comments += 1;
      return { status: 200, body: comment };
    }
    return { status: 404, body: { message: "The requested resource was not found." } };
  };
  const files = fakeFiles(hex);
  const trelloFile = (file: FakeFile) => ({
    id: file.id,
    name: file.name,
    fileName: file.name,
    mimeType: "image/png",
    bytes: file.bytes.length,
    isUpload: true,
    url: `https://trello.com/1/cards/${file.ticket}/attachments/${file.id}/download/${file.name}`,
    date: "2026-10-02T09:20:00.000Z",
  });
  const link = { id: hex(), name: "Spec", isUpload: false, url: "https://example.com/spec" };
  const fetchImpl: BoardFetch = async (url, init) => {
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get("token"), "trello_contract");
    const method = init?.method || "GET";
    const attachments = /^\/1\/cards\/([0-9a-f]{24})\/attachments(?:\/([0-9a-f]{24})(\/download\/[^/]+)?)?$/.exec(parsed.pathname);
    if (attachments) {
      const [, owner = "", fileId, download] = attachments;
      if (!fileId && method === "POST") return reply({ status: 200, body: trelloFile(await files.add(owner, init)) });
      if (!fileId) return reply({ status: 200, body: [...files.on(owner).map(trelloFile), link] });
      const file = files.on(owner).find((item) => item.id === fileId);
      if (!file) return reply({ status: 404, body: { message: "The requested resource was not found." } });
      if (download) {
        assert.equal(init?.headers?.Authorization, 'OAuth oauth_consumer_key="key_contract", oauth_token="trello_contract"');
        return reply(fileReply(file, init));
      }
      if (method === "DELETE") {
        files.remove(file);
        return reply({ status: 200, body: {} });
      }
      return reply({ status: 200, body: trelloFile(file) });
    }
    return reply(answer(method, parsed, init));
  };
  const kit = services(root, fetchImpl);
  writeTrelloConnection({ apiKey: "key_contract", token: "trello_contract" }, kit.files.connections.trello);
  const folder = canonicalCwd(root);
  writeTickets(bindBoard(emptyTickets(), folder, {
    provider: "trello",
    boardId,
    title: "Remote",
    columns: lists.map((item) => ({ id: item.id, title: item.name })),
  }), kit.files.tickets);
  const adapter = trelloAdapter(kit);
  const binding = bindingFor(readTickets(kit.files.tickets), folder);
  assert.ok(binding, "no binding");
  const board = adapter.open(folder, binding);
  assert.ok(board, "the Trello adapter did not open its binding");
  return {
    adapter,
    board,
    folder,
    tickets: kit.files.tickets,
    seeded: seeded.id,
    intake: listId("Open"),
    moveTo: "Active",
    moved: listId("Active"),
    nowhere: "Someday",
    refused: null,
    foreign: [41, "APP-1"],
    missing: "9".repeat(24),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

// Jira: board 12 on project APP, whose filter leaves APP-3 out. Done can only be reached from Review,
// and needs a resolution. Jira sends one item per page.
function jiraKit(): Kit & { renameColumn(from: string, to: string): void } {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-contract-jira-"));
  const site = "https://example.atlassian.net";
  const statuses = [
    { id: "10000", name: "To Do", category: "new" },
    { id: "10001", name: "In Progress", category: "indeterminate" },
    { id: "10002", name: "In Review", category: "indeterminate" },
    { id: "10003", name: "Done", category: "done" },
  ];
  const columns = [["To Do", "10000"], ["In Progress", "10001"], ["Review", "10002"], ["Done", "10003"]];
  let clock = Date.parse("2026-10-01T10:00:00.000Z");
  const stamp = () => {
    clock += 1000;
    return new Date(clock).toISOString().replace("Z", "+0000");
  };
  interface Issue {
    id: string;
    key: string;
    parent: string | null;
    fields: {
      summary: string;
      description: string | null;
      status: { id: string; name: string; statusCategory: { key: string } };
      labels: string[];
      updated: string;
      created: string;
      project: { id: string; key: string };
      issuetype: { subtask: boolean; name: string };
      assignee: { accountId: string; displayName: string } | null;
      priority: { name: string };
      duedate: string | null;
    };
    onBoard: boolean;
  }
  const issues = new Map<string, Issue>();
  const me = { accountId: "acc-me", displayName: "Thimo Eder" };
  const comments = new Map<string, { id: string; body: string; created: string; author: typeof me }[]>();
  const ranked: string[] = [];
  const statusOf = (id: string) => {
    const found = statuses.find((status) => status.id === id);
    assert.ok(found, `no status ${id}`);
    return { id: found.id, name: found.name, statusCategory: { key: found.category } };
  };
  const add = (summary: string, parent: string | null = null, onBoard = true): Issue => {
    const number = issues.size + 1;
    const issue: Issue = {
      id: String(20000 + number),
      key: `APP-${number}`,
      parent,
      fields: {
        summary,
        description: null,
        status: statusOf("10000"),
        labels: ["ui"],
        updated: stamp(),
        created: "2026-09-29T08:00:00.000+0000",
        project: { id: "10100", key: "APP" },
        issuetype: { subtask: parent !== null, name: parent ? "Sub-task" : "Task" },
        assignee: me,
        priority: { name: "Medium" },
        duedate: "2026-10-10",
      },
      onBoard,
    };
    issues.set(issue.key, issue);
    ranked.push(issue.key);
    return issue;
  };
  // An issue as Jira answers it, with its sub-tasks, parent and comment count filled in.
  const view = (issue: Issue) => {
    const nested = (other: Issue) => ({ key: other.key, fields: { summary: other.fields.summary, status: other.fields.status } });
    const parent = issue.parent ? issues.get(issue.parent) : undefined;
    return {
      ...issue,
      fields: {
        ...issue.fields,
        subtasks: [...issues.values()].filter((other) => other.parent === issue.key).map(nested),
        ...(parent ? { parent: nested(parent) } : {}),
        comment: { total: (comments.get(issue.key) || []).length },
      },
    };
  };
  add("Seeded");
  add("Seeded sub-task", "APP-1");
  add("Elsewhere", null, false);
  // Back to To Do asks for a comment. Into In Review there is also a transition that needs a field only Jira
  // sets. Done is only reached from In Review and needs a resolution.
  const transitionsFor = (issue: Issue) => {
    const to = ["10000", "10001", "10002"].filter((id) => id !== issue.fields.status.id);
    const needs = (id: string) => (id === "10000" ? { comment: { required: true, name: "Comment", schema: { type: "comments-page" } } } : {});
    const list: unknown[] = to.flatMap((id) => {
      const plain = { id: `t${id}`, name: statusOf(id).name, to: statusOf(id), fields: needs(id) };
      if (id !== "10002") return [plain];
      const form = { ...plain, id: "t10002-form", fields: { customfield_1: { required: true, name: "Reviewer" } } };
      return [form, plain];
    });
    if (issue.fields.status.id === "10002") {
      list.push({
        id: "t10003",
        name: "Done",
        to: statusOf("10003"),
        fields: { resolution: { required: true, name: "Resolution", allowedValues: [{ id: "2", name: "Won't Do" }, { id: "1", name: "Done" }] } },
      });
    }
    return list;
  };
  const answer = (method: string, url: URL, init: BoardFetchInit | undefined): Reply => {
    const body = readJson(init);
    const route = url.pathname;
    if (method === "GET" && route === "/rest/agile/1.0/board/12") return { status: 200, body: { id: 12, name: "Remote", location: { projectKey: "APP" } } };
    if (method === "GET" && route === "/rest/agile/1.0/board/12/configuration") {
      return { status: 200, body: { columnConfig: { columns: columns.map(([name, status]) => ({ name, statuses: [{ id: status }] })) } } };
    }
    if (method === "GET" && route === "/rest/agile/1.0/board/12/issue") {
      const jql = url.searchParams.get("jql") || "";
      const key = /^key = (\S+)$/.exec(jql)?.[1];
      let found = [...issues.values()].filter((issue) => issue.onBoard);
      if (key) found = found.filter((issue) => issue.key === key);
      if (/ORDER BY updated DESC/.test(jql)) found.sort((a, b) => b.fields.updated.localeCompare(a.fields.updated));
      if (/ORDER BY Rank ASC/.test(jql)) found.sort((a, b) => ranked.indexOf(a.key) - ranked.indexOf(b.key));
      const startAt = Number(url.searchParams.get("startAt") || 0);
      return { status: 200, body: { startAt, maxResults: 1, total: found.length, issues: found.slice(startAt, startAt + 1).map(view) } };
    }
    if (method === "GET" && route === "/rest/api/2/myself") return { status: 200, body: me };
    if (method === "PUT" && route === "/rest/agile/1.0/issue/rank") {
      const moving = String(list(body.issues)[0]);
      const anchor = String(body.rankAfterIssue ?? body.rankBeforeIssue);
      ranked.splice(ranked.indexOf(moving), 1);
      ranked.splice(ranked.indexOf(anchor) + (body.rankAfterIssue ? 1 : 0), 0, moving);
      return { status: 204, body: "" };
    }
    if (method === "GET" && route === "/rest/api/2/issue/createmeta/APP/issuetypes") {
      return { status: 200, body: { issueTypes: [{ id: "5", name: "Sub-task", subtask: true }, { id: "3", name: "Task", subtask: false }] } };
    }
    if (method === "POST" && route === "/rest/api/2/issue") {
      const fields = record(body.fields);
      assert.deepEqual(fields.issuetype, { id: "3" });
      assert.deepEqual(fields.project, { key: "APP" });
      const issue = add(String(fields.summary));
      issue.fields.labels = [];
      issue.fields.assignee = null;
      issue.fields.duedate = null;
      if (typeof fields.description === "string") issue.fields.description = fields.description;
      return { status: 201, body: { id: issue.id, key: issue.key } };
    }
    const match = /^\/rest\/api\/2\/issue\/([A-Z]+-\d+)(?:\/(.*))?$/.exec(route);
    const issue = match ? issues.get(match[1] ?? "") : undefined;
    if (!issue) return { status: 404, body: { errorMessages: ["Issue does not exist or you do not have permission to see it."] } };
    const rest = match?.[2] ?? "";
    if (method === "GET" && rest === "") return { status: 200, body: view(issue) };
    if (method === "DELETE" && rest === "") {
      if ([...issues.values()].some((other) => other.parent === issue.key)) {
        return { status: 400, body: { errorMessages: ["The issue has subtasks."] } };
      }
      issues.delete(issue.key);
      return { status: 204, body: "" };
    }
    if (method === "PUT" && rest === "") {
      const fields = isRecord(body.fields) ? body.fields : {};
      if (typeof fields.summary === "string") issue.fields.summary = fields.summary;
      if (fields.description !== undefined) issue.fields.description = typeof fields.description === "string" ? fields.description : null;
      for (const change of isRecord(body.update) ? list(body.update.labels) : []) {
        const added = at(change, "add");
        const removed = record(change).remove;
        if (typeof added === "string" && !issue.fields.labels.includes(added)) issue.fields.labels.push(added);
        if (typeof removed === "string") issue.fields.labels = issue.fields.labels.filter((label) => label !== removed);
      }
      issue.fields.updated = stamp();
      return { status: 204, body: "" };
    }
    if (method === "GET" && rest === "transitions") return { status: 200, body: { transitions: transitionsFor(issue) } };
    if (method === "POST" && rest === "transitions") {
      const transition = transitionsFor(issue).map(record).find((item) => item.id === at(body, "transition", "id"));
      if (!transition) return { status: 400, body: { errorMessages: ["Transition id is not valid for this issue."] } };
      const resolution = isRecord(body.fields) ? body.fields.resolution : undefined;
      if (at(transition, "to", "id") === "10003" && at(resolution, "id") !== "1") {
        return { status: 400, body: { errorMessages: [], errors: { resolution: "Resolution is required." } } };
      }
      const comment = isRecord(body.update) ? at(list(body.update.comment)[0], "add", "body") : undefined;
      if (at(transition, "to", "id") === "10000" && typeof comment !== "string") {
        return { status: 400, body: { errorMessages: [], errors: { comment: "Comment is required." } } };
      }
      if (typeof comment === "string") {
        comments.set(issue.key, [...(comments.get(issue.key) || []), { id: String(30000 + (comments.get(issue.key) || []).length), body: comment, created: stamp(), author: me }]);
      }
      issue.fields.status = statusOf(String(at(transition, "to", "id")));
      issue.fields.updated = stamp();
      return { status: 204, body: "" };
    }
    if (method === "GET" && rest === "comment") {
      const all = comments.get(issue.key) || [];
      const startAt = Number(url.searchParams.get("startAt") || 0);
      return { status: 200, body: { startAt, maxResults: 1, total: all.length, comments: all.slice(startAt, startAt + 1) } };
    }
    const commentAt = /^comment\/(\d+)$/.exec(rest)?.[1];
    const existing = (comments.get(issue.key) || []).find((item) => item.id === commentAt);
    if (existing && method === "PUT") {
      existing.body = String(body.body);
      return { status: 200, body: existing };
    }
    if (existing && method === "DELETE") {
      comments.set(issue.key, (comments.get(issue.key) || []).filter((item) => item !== existing));
      return { status: 204, body: "" };
    }
    if (method === "POST" && rest === "comment") {
      const comment = { id: String(30000 + (comments.get(issue.key) || []).length), body: String(body.body), created: stamp(), author: me };
      comments.set(issue.key, [...(comments.get(issue.key) || []), comment]);
      issue.fields.updated = stamp();
      return { status: 201, body: comment };
    }
    return { status: 404, body: { errorMessages: ["Not found"] } };
  };
  let fileSerial = 10000;
  const files = fakeFiles(() => String((fileSerial += 1)));
  const jiraFile = (file: FakeFile) => ({
    id: file.id,
    filename: file.name,
    mimeType: "image/png",
    size: file.bytes.length,
    content: `${site}/rest/api/2/attachment/content/${file.id}`,
    created: "2026-10-02T09:20:00.000+0000",
  });
  const fetchImpl: BoardFetch = async (url, init) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, site);
    assert.equal(init?.headers?.Authorization, `Basic ${Buffer.from("me@example.com:jira_contract").toString("base64")}`);
    const method = init?.method || "GET";
    const upload = /^\/rest\/api\/2\/issue\/([A-Z]+-\d+)\/attachments$/.exec(parsed.pathname)?.[1];
    if (upload && method === "POST") {
      assert.equal(init?.headers?.["X-Atlassian-Token"], "no-check");
      return reply({ status: 200, body: [jiraFile(await files.add(upload, init))] });
    }
    const attached = /^\/rest\/api\/2\/issue\/([A-Z]+-\d+)$/.exec(parsed.pathname)?.[1];
    if (attached && parsed.searchParams.get("fields") === "attachment") {
      return reply({ status: 200, body: { key: attached, fields: { attachment: files.on(attached).map(jiraFile) } } });
    }
    const content = files.find(/^\/rest\/api\/2\/attachment\/content\/(\d+)$/.exec(parsed.pathname)?.[1]);
    if (content && method === "GET") return reply(fileReply(content, init));
    const attachment = files.find(/^\/rest\/api\/2\/attachment\/(\d+)$/.exec(parsed.pathname)?.[1]);
    if (attachment && method === "DELETE") {
      files.remove(attachment);
      return reply({ status: 204, body: "" });
    }
    return reply(answer(method, parsed, init));
  };
  const kit = services(root, fetchImpl);
  writeJiraConnection({ site, email: "me@example.com", token: "jira_contract" }, kit.files.connections.jira);
  const folder = canonicalCwd(root);
  writeTickets(bindBoard(emptyTickets(), folder, { provider: "jira", boardId: 12, title: "Remote", projectKey: "APP", columns: columns.map(([name]) => name) }), kit.files.tickets);
  const adapter = jiraAdapter(kit);
  const binding = bindingFor(readTickets(kit.files.tickets), folder);
  assert.ok(binding, "no binding");
  const board = adapter.open(folder, binding);
  assert.ok(board, "the Jira adapter did not open its binding");
  return {
    adapter,
    board,
    folder,
    tickets: kit.files.tickets,
    seeded: "APP-1",
    intake: "To Do",
    moveTo: "in progress",
    moved: "In Progress",
    nowhere: "Someday",
    refused: "Done",
    foreign: [41, "f".repeat(24)],
    missing: "APP-999",
    close: () => rmSync(root, { recursive: true, force: true }),
    renameColumn(from, to) {
      const column = columns.find(([name]) => name === from);
      assert.ok(column, `no column ${from}`);
      column[0] = to;
    },
  };
}

async function refused(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (error) {
    const status = Number(at(error, "status"));
    assert.ok(status >= 400 && status < 500, `refused with ${status}`);
    return status;
  }
  assert.fail("the call was not refused");
}

const kits: [string, () => Kit][] = [["SAK", sakKit], ["Trello", trelloKit], ["Jira", jiraKit]];

for (const [name, make] of kits) {
  test(`${name} adapter: a ticket takes a file, lists it, reads it whole or in part, and deletes it only from its own ticket`, async () => {
    const kit = make();
    try {
      const bytes = new TextEncoder().encode("PNG shot of the board");
      const added = await kit.adapter.files.add(kit.seeded, "shot.png", new Blob([bytes]));
      assert.equal(at(added, "name"), "shot.png");
      const fileId = String(at(added, "id"));
      assert.deepEqual((await kit.adapter.files.list(kit.seeded)).map((file) => String(at(file, "id"))), [fileId]);
      const whole = await kit.adapter.files.read(kit.seeded, fileId, undefined);
      assert.equal(whole.status, 200);
      assert.equal(whole.headers["content-type"], "image/png");
      assert.deepEqual(whole.bytes, bytes);
      const part = await kit.adapter.files.read(kit.seeded, fileId, "bytes=0-2");
      assert.equal(part.status, 206);
      assert.equal(part.headers["content-range"], `bytes 0-2/${bytes.length}`);
      assert.equal(new TextDecoder().decode(part.bytes), "PNG");
      const other = id(at(await kit.board.createTicket({ title: "Other", description: undefined }), "id"));
      await refused(kit.adapter.files.remove(other, fileId));
      assert.equal((await kit.adapter.files.list(kit.seeded)).length, 1);
      await kit.adapter.files.remove(kit.seeded, fileId);
      assert.deepEqual(await kit.adapter.files.list(kit.seeded), []);
    } finally {
      kit.close();
    }
  });

  test(`${name} adapter: the board loads with its columns and tickets and keeps the binding`, async () => {
    const kit = make();
    try {
      assert.equal(kit.board.folder, kit.folder);
      assert.equal(kit.board.signedInPage !== null, kit.adapter.capabilities.signedInPages);
      const trelloBinding: BoardBinding = { provider: "trello", boardId: "a".repeat(24), title: "x", columns: [] };
      const sakBinding: BoardBinding = { provider: "sak", projectId: 1, title: "x" };
      const other = kit.adapter.provider === "sak" ? trelloBinding : sakBinding;
      assert.equal(kit.adapter.open(kit.folder, other), null);
      const loaded = await kit.board.load({ search: "", activity: "" });
      assert.equal(at(loaded.view, "provider"), kit.adapter.provider);
      assert.ok(list(at(loaded.view, "columns")).some((column) => at(column, "value") === kit.intake));
      const tasks = list(at(loaded.view, "tasks"));
      assert.deepEqual(tasks.map((task) => at(task, "title")), ["Seeded"]);
      assert.ok(loaded.rebind, "a full load returns the binding it saw");
      const me = record(loaded.view).me;
      if (kit.adapter.capabilities.assignees) assert.ok(typeof me === "string" && me, "a board with people names the connected account");
      else assert.equal(me, undefined);
      const rebound = bindingFor(loaded.rebind(readTickets(kit.tickets)), kit.folder);
      assert.equal(rebound?.provider, kit.adapter.provider);
      const activity = at(loaded.view, "activity");
      const again = await kit.board.load({ search: "", activity: typeof activity === "string" ? activity : "" });
      assert.equal(at(again.view, "unchanged") === true, kit.adapter.capabilities.conditionalFetch);
    } finally {
      kit.close();
    }
  });

  test(`${name} adapter: a new ticket lands in the intake column and belongs to this source`, async () => {
    const kit = make();
    try {
      const task = await kit.board.createTicket({ title: "  Ship   it ", description: "Line one\nLine two" });
      assert.equal(at(task, "title"), "Ship it");
      assert.equal(at(task, "description"), "Line one\nLine two");
      assert.equal(at(task, "attributes", "status"), kit.intake);
      assert.equal(kit.adapter.claims(id(at(task, "id"))), true);
      for (const foreign of kit.foreign) assert.equal(kit.adapter.claims(foreign), false, `claims ${foreign}`);
      assert.equal(await refused(kit.board.createTicket({ title: "  ", description: undefined })), 400);
    } finally {
      kit.close();
    }
  });

  test(`${name} adapter: a move changes the column and a refused move leaves it`, async () => {
    const kit = make();
    try {
      const moved = await kit.adapter.moveTicket(kit.seeded, kit.moveTo, kit.folder);
      assert.equal(at(moved, "attributes", "status"), kit.moved);
      await refused(kit.adapter.moveTicket(kit.seeded, kit.nowhere, kit.folder));
      assert.equal(kit.refused !== null, kit.adapter.capabilities.moves === "transitions");
      if (kit.refused !== null) assert.equal(await refused(kit.adapter.moveTicket(kit.seeded, kit.refused, kit.folder)), 409);
      assert.equal(at(await kit.adapter.readTicket(kit.seeded), "attributes", "status"), kit.moved);
    } finally {
      kit.close();
    }
  });

  test(`${name} adapter: an edit needs the current revision`, async () => {
    const kit = make();
    try {
      const before = await kit.adapter.readTicket(kit.seeded);
      const revision = at(before, "revision") as TicketEdit["revision"];
      const edited = await kit.adapter.editTicket(kit.seeded, { revision, title: "Renamed", description: "Why", note: "Aside" });
      assert.equal(at(edited, "title"), "Renamed");
      assert.equal(at(edited, "description"), "Why");
      assert.equal(at(edited, "note"), kit.adapter.capabilities.notes ? "Aside" : null);
      assert.notEqual(at(edited, "revision"), revision);
      assert.equal(await refused(kit.adapter.editTicket(kit.seeded, { revision, title: "Stale" })), 409);
      assert.equal(at(await kit.adapter.readTicket(kit.seeded), "title"), "Renamed");
    } finally {
      kit.close();
    }
  });

  test(`${name} adapter: a label is created once, attached, removed and attached again`, async () => {
    const kit = make();
    try {
      if (!kit.adapter.capabilities.labels) {
        assert.equal(await refused(kit.board.addLabel("bug", kit.seeded, null)), 400);
        assert.equal(await refused(kit.adapter.changeLabel(kit.seeded, "bug", true)), 400);
        return;
      }
      const added = await kit.board.addLabel("bug", kit.seeded, null);
      const labelId = labelKey(at(added, "label", "id"));
      assert.equal(at(added, "label", "title"), "bug");
      assert.ok(titles(at(added, "task")).includes("bug"));
      const again = await kit.board.addLabel("bug", undefined, null);
      assert.equal(labelKey(at(again, "label", "id")), labelId);
      assert.equal(at(again, "task"), null);
      const removed = await kit.adapter.changeLabel(kit.seeded, labelId, false);
      assert.equal(titles(removed).includes("bug"), false);
      const attached = await kit.adapter.changeLabel(kit.seeded, labelId, true);
      assert.ok(titles(attached).includes("bug"));
      assert.equal(await refused(kit.board.addLabel("bug", "not-an-id", null)), 400);
    } finally {
      kit.close();
    }
  });

  test(`${name} adapter: a new label keeps its color where the source takes one, and a deleted label leaves every ticket`, async () => {
    const kit = make();
    try {
      if (!kit.adapter.capabilities.labels) return;
      const added = await kit.board.addLabel("ui", kit.seeded, "#0079bf");
      if (kit.adapter.capabilities.labelColors) assert.equal(at(added, "label", "color"), "#0079bf");
      const labelId = labelKey(at(added, "label", "id"));
      await kit.board.addLabel("solo", undefined, null);
      const searched = list(at((await kit.board.load({ search: "no ticket has this", activity: "" })).view, "labels")).map((label) => at(label, "title"));
      assert.ok(searched.includes("ui"), "a search keeps the board's labels");
      assert.equal(searched.includes("solo"), kit.adapter.capabilities.standaloneLabels);
      assert.equal(kit.board.deleteLabel !== null, kit.adapter.capabilities.labelDeletes);
      if (!kit.board.deleteLabel) return;
      await kit.board.deleteLabel(labelId);
      const loaded = await kit.board.load({ search: "", activity: "" });
      assert.equal(list(at(loaded.view, "labels")).some((label) => at(label, "id") === labelId), false);
      assert.equal(titles(await kit.adapter.readTicket(kit.seeded)).includes("ui"), false);
      assert.equal(await refused(kit.board.deleteLabel(labelId)), 404);
    } finally {
      kit.close();
    }
  });

  test(`${name} adapter: a comment keeps its line breaks and is read back in order`, async () => {
    const kit = make();
    try {
      const first = await kit.adapter.addComment(kit.seeded, "First");
      assert.equal(at(first, "body"), "First");
      await kit.adapter.addComment(kit.seeded, "Line one\n\nLine two");
      const comments = list(await kit.adapter.comments(kit.seeded));
      assert.deepEqual(comments.map((comment) => at(comment, "body")), ["First", "Line one\n\nLine two"]);
    } finally {
      kit.close();
    }
  });

  test(`${name} adapter: a comment says who wrote it and when, and yours can change where the source allows`, async () => {
    const kit = make();
    try {
      const added = await kit.adapter.addComment(kit.seeded, "Draft");
      assert.ok(added.created, "a comment has a time");
      if (!kit.adapter.capabilities.commentEdits) {
        assert.equal(added.mine, false);
        assert.equal(await refused(kit.adapter.editComment(kit.seeded, String(added.id), "Final")), 400);
        assert.equal(await refused(kit.adapter.deleteComment(kit.seeded, String(added.id))), 400);
        return;
      }
      assert.equal(added.mine, true);
      assert.equal(added.author?.name, "Thimo Eder");
      const edited = await kit.adapter.editComment(kit.seeded, String(added.id), "Final");
      assert.equal(edited.body, "Final");
      assert.deepEqual((await kit.adapter.comments(kit.seeded)).map((comment) => comment.body), ["Final"]);
      await kit.adapter.deleteComment(kit.seeded, String(added.id));
      assert.deepEqual(await kit.adapter.comments(kit.seeded), []);
    } finally {
      kit.close();
    }
  });

  test(`${name} adapter: a drop keeps the ticket's place in its column`, async () => {
    const kit = make();
    try {
      const first = id(at(await kit.board.createTicket({ title: "First", description: undefined }), "id"));
      const second = id(at(await kit.board.createTicket({ title: "Second", description: undefined }), "id"));
      const titlesIn = async (status: unknown) => list(at((await kit.board.load({ search: "", activity: "" })).view, "tasks"))
        .filter((task) => at(task, "attributes", "status") === status)
        .map((task) => at(task, "title"));
      assert.deepEqual(await titlesIn(kit.intake), ["Seeded", "First", "Second"]);
      await kit.adapter.moveTicket(second, kit.intake, kit.folder, { order: [second, kit.seeded, first] });
      assert.deepEqual(await titlesIn(kit.intake), ["Second", "Seeded", "First"]);
      await kit.adapter.moveTicket(first, kit.intake, kit.folder, { order: [second, first, kit.seeded] });
      assert.deepEqual(await titlesIn(kit.intake), ["Second", "First", "Seeded"]);
      const moved = await kit.adapter.moveTicket(kit.seeded, kit.moveTo, kit.folder, { order: [kit.seeded] });
      assert.equal(at(moved, "attributes", "status"), kit.moved);
    } finally {
      kit.close();
    }
  });

  test(`${name} adapter: a source without checklists refuses to tick or add an item`, async () => {
    const kit = make();
    try {
      if (kit.adapter.capabilities.checklists) return;
      assert.equal(await refused(kit.adapter.checkItem(kit.seeded, "a".repeat(24), true)), 400);
      assert.equal(await refused(kit.adapter.addCheckItem(kit.seeded, "a".repeat(24), "Item")), 400);
    } finally {
      kit.close();
    }
  });

  test(`${name} adapter: the status menu lists the moves the source allows`, async () => {
    const kit = make();
    try {
      const moves = await kit.adapter.moves(kit.seeded);
      const statuses = moves.map((move) => move.status);
      assert.equal(statuses.includes(kit.intake), false, "the ticket's own column is not a move");
      assert.ok(statuses.includes(kit.moved), "the usual move is listed");
      if (kit.refused !== null) assert.equal(statuses.includes(kit.refused), false, "a move the workflow refuses is left out");
    } finally {
      kit.close();
    }
  });

  test(`${name} adapter: tickets relate to each other where the source keeps relations`, async () => {
    const kit = make();
    try {
      const { changeRelation } = kit.adapter;
      if (!kit.adapter.capabilities.relations) {
        assert.equal(changeRelation, null);
        return;
      }
      assert.ok(changeRelation, "a source with relations can change them");
      const child = id(at(await kit.board.createTicket({ title: "Step", description: undefined }), "id"));
      await changeRelation(child, kit.seeded, "parent", true);
      assert.deepEqual(list(at(await kit.adapter.readTicket(kit.seeded), "subtasks")).map((task) => at(task, "id")), [child]);
      await changeRelation(child, kit.seeded, "parent", false);
      assert.deepEqual(at(await kit.adapter.readTicket(kit.seeded), "subtasks"), []);
      assert.equal(await refused(changeRelation(child, kit.missing, "blocks", true)), 404);
    } finally {
      kit.close();
    }
  });

  test(`${name} adapter: a ticket reads the same from its id and from the board, and briefs a thread`, async () => {
    const kit = make();
    try {
      const read = await kit.adapter.readTicket(kit.seeded);
      assert.equal(id(at(read, "id")), kit.seeded);
      assert.equal(at(read, "title"), "Seeded");
      const onBoard = await kit.board.ticketOnBoard(kit.seeded);
      assert.equal(id(at(onBoard, "id")), kit.seeded);
      const brief = kit.adapter.threadTicket(onBoard);
      assert.equal(id(brief.id), kit.seeded);
      assert.equal(brief.title, "Seeded");
      assert.equal(brief.description, "");
      assert.equal(brief.note, "");
      assert.ok(brief.status, "the brief names the column");
      await refused(kit.adapter.readTicket(kit.missing));
    } finally {
      kit.close();
    }
  });
}

test("Trello adapter: a card's checklists show in the ticket, tick, take new items and count on the card", async () => {
  const kit = trelloKit();
  try {
    const read = await kit.adapter.readTicket(kit.seeded);
    const launch = record(list(at(read, "checklists"))[0]);
    assert.equal(launch.title, "Launch");
    assert.deepEqual(list(launch.items).map((item) => [at(item, "title"), at(item, "done")]), [["Write copy", true], ["Translate", false]]);
    assert.deepEqual(at(read, "checkCount"), { done: 1, total: 2 });

    const translate = String(at(list(launch.items)[1], "id"));
    const ticked = await kit.adapter.checkItem(kit.seeded, translate, true);
    assert.deepEqual(at(ticked, "checkCount"), { done: 2, total: 2 });
    assert.equal(at(list(at(list(at(ticked, "checklists"))[0], "items"))[1], "done"), true);

    const added = await kit.adapter.addCheckItem(kit.seeded, String(launch.id), "Announce");
    assert.deepEqual(list(at(list(at(added, "checklists"))[0], "items")).map((item) => at(item, "title")), ["Write copy", "Translate", "Announce"]);
    assert.equal(await refused(kit.adapter.addCheckItem(kit.seeded, "f".repeat(24), "Elsewhere")), 404);

    const loaded = await kit.board.load({ search: "", activity: "" });
    const card = list(record(loaded.view).tasks).find((task) => at(task, "id") === kit.seeded);
    assert.deepEqual(at(card, "checkCount"), { done: 2, total: 3 });
  } finally {
    kit.close();
  }
});

test("Jira adapter: a move into Done fills in the resolution, and a delete removes the issue unless it has sub-tasks", async () => {
  const kit = jiraKit();
  try {
    await kit.adapter.moveTicket(kit.seeded, "Review", kit.folder);
    const done = await kit.adapter.moveTicket(kit.seeded, "Done", kit.folder);
    assert.equal(at(done, "attributes", "status"), "Done");
    assert.equal(kit.adapter.capabilities.deletes, true);
    assert.equal(await refused(kit.adapter.deleteTicket(kit.seeded)), 400);
    assert.equal(at(await kit.adapter.readTicket(kit.seeded), "title"), "Seeded");
    await kit.adapter.deleteTicket("APP-2");
    await kit.adapter.deleteTicket(kit.seeded);
    assert.equal(await refused(kit.adapter.readTicket(kit.seeded)), 404);
  } finally {
    kit.close();
  }
});

test("Jira adapter: a board holds its own issues only, and a sub-task opens without a card", async () => {
  const kit = jiraKit();
  try {
    assert.equal(await refused(kit.board.ticketOnBoard("APP-999")), 404);
    assert.equal(at(await kit.board.ticketOnBoard("APP-2"), "title"), "Seeded sub-task");
    assert.equal(at(await kit.adapter.moveTicket("APP-2", "In Progress", kit.folder), "attributes", "status"), "In Progress");
    const loaded = await kit.board.load({ search: "seed", activity: "" });
    assert.deepEqual(list(at(loaded.view, "tasks")).map((task) => at(task, "id")), ["APP-1"]);
    assert.deepEqual(list(at(loaded.view, "tasks")).flatMap((task) => list(at(task, "labels"))).map((label) => at(label, "title")), ["ui"]);
    const none = await kit.board.load({ search: "nothing like it", activity: "" });
    assert.deepEqual(at(none.view, "tasks"), []);
  } finally {
    kit.close();
  }
});

test("Jira adapter: a ticket of the same project off this board is refused, and a column change reloads the board", async () => {
  const kit = jiraKit();
  try {
    assert.equal(await refused(kit.adapter.moveTicket("APP-3", "In Progress", kit.folder)), 404);
    assert.equal(await refused(kit.adapter.readTicket("APP-3")), 404);
    const first = await kit.board.load({ search: "", activity: "" });
    const activity = String(at(first.view, "activity"));
    assert.equal(at((await kit.board.load({ search: "", activity })).view, "unchanged"), true);
    kit.renameColumn("Review", "QA");
    const renamed = await kit.board.load({ search: "", activity });
    assert.deepEqual(list(at(renamed.view, "columns")).map((column) => at(column, "title")), ["To Do", "In Progress", "QA", "Done"]);
  } finally {
    kit.close();
  }
});

test("Jira adapter: a move that needs a comment asks for it, then takes it", async () => {
  const kit = jiraKit();
  try {
    await kit.adapter.moveTicket(kit.seeded, "In Progress", kit.folder);
    const back = (await kit.adapter.moves(kit.seeded)).find((move) => move.status === "To Do");
    assert.deepEqual(back?.needs, [{ id: "comment", name: "Comment" }]);
    let asked: unknown = null;
    try {
      await kit.adapter.moveTicket(kit.seeded, "To Do", kit.folder);
    } catch (error) {
      asked = error;
    }
    assert.equal(at(asked, "status"), 409);
    assert.deepEqual(boardFailure(asked).body, {
      error: "Moving to To Do needs Comment",
      code: "jira",
      fields: [{ id: "comment", name: "Comment" }],
    });
    const moved = await kit.adapter.moveTicket(kit.seeded, "To Do", kit.folder, { fields: { comment: "Back to the queue" } });
    assert.equal(at(moved, "attributes", "status"), "To Do");
    assert.deepEqual((await kit.adapter.comments(kit.seeded)).map((comment) => comment.body), ["Back to the queue"]);
  } finally {
    kit.close();
  }
});

test("Jira adapter: a card carries its type, assignee, priority, due date, counts and link, and the board names the token's account", async () => {
  const kit = jiraKit();
  try {
    await kit.adapter.addComment(kit.seeded, "Hello");
    const { view } = await kit.board.load({ search: "", activity: "" });
    assert.equal(at(view, "me"), "acc-me");
    const [card] = list(at(view, "tasks"));
    assert.equal(at(card, "type"), "task");
    assert.equal(at(card, "typeName"), "Task");
    assert.deepEqual(at(card, "assignees"), [{ id: "acc-me", name: "Thimo Eder" }]);
    assert.equal(at(card, "priority"), "Medium");
    assert.equal(at(card, "due"), "2026-10-10");
    assert.equal(at(card, "dueDone"), false);
    assert.equal(at(card, "commentCount"), 1);
    assert.deepEqual(at(card, "subtaskCount"), { done: 0, total: 1 });
    assert.equal(at(card, "url"), "https://example.atlassian.net/browse/APP-1");
    assert.deepEqual(at(await kit.adapter.readTicket("APP-1"), "subtasks"), [{ id: "APP-2", title: "Seeded sub-task", status: "To Do", done: false }]);
    const sub = await kit.adapter.readTicket("APP-2");
    assert.equal(at(sub, "type"), "subtask");
    assert.deepEqual(at(sub, "related"), [{ id: "APP-1", title: "Seeded", status: "To Do", done: false, kind: "sub-task of" }]);
  } finally {
    kit.close();
  }
});

test("Trello adapter: a card carries its members, due date, comment count and link, and the board names the token's member", async () => {
  const kit = trelloKit();
  try {
    await kit.adapter.addComment(kit.seeded, "Hello");
    const { view } = await kit.board.load({ search: "", activity: "" });
    assert.equal(at(view, "me"), "c".repeat(24));
    const [card] = list(at(view, "tasks"));
    assert.deepEqual(at(card, "assignees"), [{ id: "c".repeat(24), name: "Thimo Eder" }]);
    assert.equal(at(card, "due"), "2026-09-30T16:00:00.000Z");
    assert.equal(at(card, "dueDone"), false);
    assert.equal(at(card, "commentCount"), 1);
    assert.match(String(at(card, "url")), /^https:\/\/trello\.com\/c\//);
    assert.deepEqual(at(await kit.adapter.readTicket(kit.seeded), "assignees"), [{ id: "c".repeat(24), name: "Thimo Eder" }]);
  } finally {
    kit.close();
  }
});

test("SAK adapter: a parent counts its sub-tasks, and the detail lists them and the tickets it relates to", async () => {
  const kit = sakKit();
  try {
    const child = id(at(await kit.board.createTicket({ title: "Step", description: undefined }), "id"));
    kit.relate?.(kit.seeded, child);
    await kit.adapter.moveTicket(child, "done", kit.folder);
    const cards = list(at((await kit.board.load({ search: "", activity: "" })).view, "tasks"));
    const parent = cards.find((card) => at(card, "id") === kit.seeded);
    assert.deepEqual(at(parent, "subtaskCount"), { done: 1, total: 1 });
    assert.equal(at(parent, "parentId"), null);
    assert.equal(at(cards.find((card) => at(card, "id") === child), "parentId"), kit.seeded);
    assert.equal(at(parent, "url"), "http://127.0.0.1:4345/tasks/41");
    const detail = await kit.adapter.readTicket(kit.seeded);
    assert.deepEqual(at(detail, "subtasks"), [{ id: child, title: "Step", status: "done", done: true }]);
    assert.deepEqual(at(detail, "related"), []);
    assert.deepEqual(at(await kit.adapter.readTicket(child), "related"), [{ id: 41, title: "Seeded", status: "open", done: false, kind: "subtask of" }]);
  } finally {
    kit.close();
  }
});

test("SAK adapter: a relation is refused when it repeats, takes a second parent, closes a loop or is not there", async () => {
  const kit = sakKit();
  const { changeRelation } = kit.adapter;
  assert.ok(changeRelation, "SAK keeps relations");
  const failure = async (pending: Promise<unknown>) => {
    try {
      await pending;
    } catch (error) {
      return boardFailure(error);
    }
    assert.fail("the relation was not refused");
  };
  try {
    const parent = id(at(await kit.board.createTicket({ title: "Epic", description: undefined }), "id"));
    const other = id(at(await kit.board.createTicket({ title: "Other epic", description: undefined }), "id"));
    await changeRelation(kit.seeded, parent, "parent", true);
    await changeRelation(kit.seeded, other, "blocks", true);
    assert.deepEqual(at(await kit.adapter.readTicket(other), "related"), [{ id: kit.seeded, title: "Seeded", status: "open", done: false, kind: "blocked by" }]);
    assert.deepEqual(await failure(changeRelation(kit.seeded, other, "blocks", true)), {
      status: 409,
      body: { error: "These tickets already have that relation", code: "relation_exists" },
    });
    assert.deepEqual(await failure(changeRelation(kit.seeded, other, "parent", true)), {
      status: 409,
      body: { error: "This ticket already has a parent", code: "parent_exists" },
    });
    assert.deepEqual(await failure(changeRelation(parent, kit.seeded, "parent", true)), {
      status: 400,
      body: { error: "That would make a loop", code: "cycle" },
    });
    assert.deepEqual(await failure(changeRelation(kit.seeded, other, "follows", false)), {
      status: 404,
      body: { error: "These tickets have no such relation", code: "not_found" },
    });
  } finally {
    kit.close();
  }
});

test("responseJson reads a body as JSON and an empty or broken body as null", async () => {
  assert.deepEqual(await responseJson(new Response('{"id":1}')), { id: 1 });
  assert.equal(await responseJson(new Response("")), null);
  assert.equal(await responseJson(new Response("<html>")), null);
});

test("SAK's refusal of a file reads plainly", async () => {
  const connection = { baseUrl: "http://127.0.0.1:4345", token: "sak_contract", enabled: true, database: "", website: "" };
  const refusals: [number, string, string][] = [
    [415, "unsupported_media_type", "The local board takes PNG, JPEG, GIF and WebP pictures and MP4, QuickTime and WebM clips"],
    [413, "too_large", "The local board takes pictures up to 20 MiB and clips up to 100 MiB"],
  ];
  for (const [status, error, message] of refusals) {
    const fetchImpl: BoardFetch = async () => reply({ status, body: { error } });
    const refused: unknown = await sakFetch(connection, "POST", "/api/tasks/41/files?name=a.txt", new Blob(["a"]), { fetchImpl }).catch((failure: unknown) => failure);
    assert.deepEqual(boardFailure(refused), { status, body: { error: message, code: error } });
  }
});
