import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { archiveSession, emptySidebar } from "../sidebar/sidebar.ts";
import { canonicalCwd } from "../chat/sessions.ts";
import {
  answerCleanup,
  bindBoard,
  bindingFor,
  boundFolder,
  dropSessionLinks,
  dropTaskLinks,
  emptyTickets,
  linkTicket,
  presentTickets,
  readTickets,
  refreshLinkText,
  unbindProject,
  writeTickets,
} from "./tickets.ts";

test("a worktree without its own binding uses its checkout's", () => {
  const state = bindBoard(bindBoard(emptyTickets(), "/work/app", { provider: "sak", projectId: 3, title: "App" }), "/work/own", { provider: "sak", projectId: 4, title: "Own" });
  const home = (folder: string) => (folder.startsWith("/wt/") ? "/work/app" : folder);
  assert.equal(boundFolder(state, "/wt/fix", home), "/work/app");
  assert.equal(boundFolder(state, "/work/own", home), "/work/own");
  assert.equal(boundFolder(state, "/wt/fix"), "");
  assert.equal(boundFolder(state, "/work/other", home), "");
});

test("a folder with no binding has no board", () => {
  const state = emptyTickets();
  assert.equal(bindingFor(state, "/work/app"), null);
  assert.deepEqual(presentTickets(state).boards, []);
});

test("create board binds the canonical folder and remove board keeps links", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-tickets-"));
  try {
    const folder = path.join(root, "app");
    mkdirSync(folder);
    const bound = bindBoard(emptyTickets(), path.join(folder, "."), { provider: "sak", projectId: 7, title: "App" });
    assert.deepEqual(bindingFor(bound, folder), { provider: "sak", projectId: 7, title: "App" });
    assert.equal(Object.keys(bound.bindings)[0], canonicalCwd(folder));
    const linked = linkTicket(bound, {
      sessionId: "sess-1",
      task: { id: 41, project_id: 7, title: "Ship it", reference: 12 },
    });
    const removed = unbindProject(linked, folder);
    assert.equal(bindingFor(removed, folder), null);
    assert.equal(removed.links.filter((link) => link.sessionId === "sess-1").length, 1);
    assert.deepEqual(presentTickets(removed).boards, []);
    assert.equal(presentTickets(removed).bySession["sess-1"]?.[0]?.reference, 12);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("linking the same session and task twice keeps one row and a second task", () => {
  const once = linkTicket(emptyTickets(), {
    sessionId: "sess-1",
    task: { id: 41, project_id: 7, title: "First" },
  });
  const renamed = linkTicket(once, {
    sessionId: "sess-1",
    task: { id: 41, project_id: 7, title: "Renamed", reference: null },
  });
  assert.equal(renamed.links.length, 1);
  assert.equal(renamed.links[0]?.title, "Renamed");
  const both = linkTicket(renamed, {
    sessionId: "sess-1",
    task: { id: 42, project_id: 7, title: "Second" },
  });
  assert.deepEqual(both.links.filter((link) => link.sessionId === "sess-1").map((link) => link.taskId), [41, 42]);
});

test("a link remembers the ticket status and deleting the ticket clears every chat", () => {
  const linked = linkTicket(emptyTickets(), {
    sessionId: "sess-1",
    task: { id: 26, project_id: 3, title: "Ship", attributes: { status: "active" } },
  });
  const also = linkTicket(linked, {
    sessionId: "sess-2",
    task: { id: 26, project_id: 3, title: "Ship", attributes: { status: "review" } },
  });
  assert.equal(also.links[0]?.status, "active");
  assert.equal(also.links[1]?.status, "review");
  const gone = dropTaskLinks(also, 26);
  assert.deepEqual(gone.links, []);
});

test("a ticket moving from Review to Done offers to archive its chats until each answers", () => {
  const linked = linkTicket(linkTicket(emptyTickets(), { sessionId: "a", task: { id: 5, status: "review" } }), { sessionId: "b", task: { id: 5, status: "review" } });
  const cleanup = (state: unknown) => presentTickets(state).bySession;
  const done = refreshLinkText(linked, [{ id: 5, title: "Fix", status: "done" }]);
  assert.equal(cleanup(done).a?.[0]?.cleanup, true);
  assert.equal(cleanup(refreshLinkText(done, [{ id: 5, title: "Fix again", status: "done" }])).a?.[0]?.cleanup, true);
  assert.equal(cleanup(refreshLinkText(done, [{ id: 5, title: "Fix", status: "active" }])).a?.[0]?.cleanup, undefined);
  const answered = answerCleanup(done, "a");
  assert.equal(cleanup(answered).a?.[0]?.cleanup, undefined);
  assert.equal(cleanup(answered).b?.[0]?.cleanup, true);
  const fromOpen = refreshLinkText(linkTicket(emptyTickets(), { sessionId: "a", task: { id: 6, status: "open" } }), [{ id: 6, title: "Fix", status: "done" }]);
  assert.equal(cleanup(fromOpen).a?.[0]?.cleanup, undefined);
  const trello = refreshLinkText(linkTicket(emptyTickets(), { sessionId: "a", task: { id: 7, linkStatus: "In Review" } }), [{ id: 7, title: "Card", linkStatus: "Done" }]);
  assert.equal(cleanup(trello).a?.[0]?.cleanup, true);
  const codeReview = refreshLinkText(linkTicket(emptyTickets(), { sessionId: "a", task: { id: "app-4", linkStatus: "Code Review" } }), [{ id: "app-4", title: "Issue", linkStatus: "Done" }]);
  assert.equal(cleanup(codeReview).a?.[0]?.cleanup, true);
});

test("dropping a session removes only that session's links", () => {
  let state = linkTicket(emptyTickets(), { sessionId: "keep", task: { id: 1, project_id: 7, title: "A" } });
  state = linkTicket(state, { sessionId: "drop", task: { id: 2, project_id: 7, title: "B" } });
  state = linkTicket(state, { sessionId: "drop", task: { id: 3, project_id: 7, title: "C" } });
  const next = dropSessionLinks(state, "drop");
  assert.deepEqual(next.links.filter((link) => link.sessionId === "keep").map((link) => link.taskId), [1]);
  assert.deepEqual(next.links.filter((link) => link.sessionId === "drop"), []);
  assert.deepEqual(dropSessionLinks(next, "missing"), next);
});

test("archiving a chat does not change ticket links", () => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "grok-tickets-")), "tickets.json");
  try {
    const linked = linkTicket(emptyTickets(), {
      sessionId: "sess-1",
      task: { id: 41, project_id: 7, title: "Ship it" },
    });
    writeTickets(linked, file);
    archiveSession(emptySidebar(), "sess-1");
    assert.equal(readTickets(file).links.length, 1);
    assert.equal(readTickets(file).links.find((link) => link.sessionId === "sess-1")?.title, "Ship it");
  } finally {
    rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test("a tickets file round-trips and ignores a broken file", () => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "grok-tickets-")), "tickets.json");
  try {
    const linked = linkTicket(bindBoard(emptyTickets(), "/work/app", { provider: "sak", projectId: 3, title: "App" }), {
      sessionId: "sess-1",
      task: { id: 9, project_id: 3, title: "  Too   long ".repeat(30), reference: "nope" },
    });
    writeTickets(linked, file);
    const stored = readTickets(file);
    assert.ok(stored.links[0], "no stored link");
    assert.equal(stored.links[0].title.length <= 200, true);
    assert.equal(stored.links[0]?.reference, null);
    writeFileSync(file, "{");
    assert.deepEqual(readTickets(file), emptyTickets());
    assert.equal(readFileSync(file, "utf8"), "{");
    assert.equal(readFileSync(`${file}.bak`, "utf8"), "{");
    writeTickets(emptyTickets(), file);
    assert.equal(readFileSync(file, "utf8"), "{");
  } finally {
    rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test("a links value that is not a list keeps the board bindings", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-tickets-"));
  const file = path.join(root, "tickets.json");
  const folder = canonicalCwd("/work/app");
  try {
    writeFileSync(file, JSON.stringify({
      bindings: { [folder]: { projectId: 4, title: "Old" } },
      links: { sessionId: "nope" },
    }));
    const stored = readTickets(file);
    assert.deepEqual(bindingFor(stored, "/work/app"), { provider: "sak", projectId: 4, title: "Old" });
    assert.deepEqual(stored.links, []);
    assert.equal(existsSync(`${file}.bak`), false);
    writeTickets(stored, file);
    assert.deepEqual(bindingFor(readTickets(file), "/work/app"), { provider: "sak", projectId: 4, title: "Old" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an old SAK binding stays a SAK board and a Trello card id can be linked", () => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "grok-tickets-")), "tickets.json");
  const board = "a".repeat(24);
  const list = "b".repeat(24);
  const card = "c".repeat(24);
  try {
    writeFileSync(file, JSON.stringify({
      bindings: { [canonicalCwd("/work/app")]: { projectId: 4, title: "Old" } },
      links: [],
    }));
    assert.deepEqual(bindingFor(readTickets(file), "/work/app"), { provider: "sak", projectId: 4, title: "Old" });
    const bound = bindBoard(emptyTickets(), "/work/app", {
      provider: "trello",
      boardId: board.toUpperCase(),
      title: "Remote",
      columns: [{ id: list, name: "Doing" }],
    });
    assert.deepEqual(bindingFor(bound, "/work/app"), {
      provider: "trello",
      boardId: board,
      title: "Remote",
      columns: [{ id: list, title: "Doing" }],
    });
    const linked = linkTicket(bound, { sessionId: "s", task: { id: card, title: "Probe", linkStatus: "Doing" } });
    assert.equal(linked.links[0]?.taskId, card);
    assert.equal(linked.links[0]?.status, "Doing");
    assert.equal(linkTicket(emptyTickets(), { sessionId: "s", task: { id: "nope", title: "x" } }).links.length, 0);
    writeTickets(linked, file);
    assert.equal(readTickets(file).links[0]?.taskId, card);
  } finally {
    rmSync(path.dirname(file), { recursive: true, force: true });
  }
});
