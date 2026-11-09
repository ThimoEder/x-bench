import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { keepBoard, keptBoard, need, noteSnapshot, reloadKept, ticketOf } from "./boardCache.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// A path without a route answers 404.
function serve(routes: Record<string, (url: URL) => { status?: number; body: unknown }>): string[] {
  const asked: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), "http://127.0.0.1");
    asked.push(`${url.pathname}${url.search}`);
    const route = routes[url.pathname];
    const { status = 200, body } = route ? route(url) : { status: 404, body: {} };
    return new Response(JSON.stringify(body), { status });
  };
  return asked;
}

const COLUMNS = [{ value: "open", title: "open" }, { value: "done", title: "done" }];

function board(ids: number[], activity: string | null = null) {
  return { columns: COLUMNS, tasks: ids.map((id) => ({ id, title: `Ticket ${id}`, attributes: { status: "open" } })), activity };
}

test("one board load serves every link to a folder's tickets", async () => {
  const asked = serve({ "/api/board/board": () => ({ body: board([1, 2]) }) });
  await Promise.all([need("/one", 1), need("/one", 2), need("/one", 1)]);
  assert.equal(asked.length, 1);
  const ticket = ticketOf("/one", 2);
  assert.equal(ticket.state, "ready");
  assert.equal(ticket.state === "ready" ? ticket.task.title : "", "Ticket 2");
});

test("a ticket the board leaves out is read alone, and one that does not exist is gone", async () => {
  const asked = serve({
    "/api/board/board": () => ({ body: board([1]) }),
    "/api/board/tasks/7": () => ({ body: { task: { id: 7, title: "Old done ticket", attributes: { status: "done" } } } }),
  });
  await need("/two", 7);
  await need("/two", 8);
  const found = ticketOf("/two", 7);
  assert.equal(found.state, "ready");
  assert.deepEqual(found.state === "ready" ? found.board?.columns : null, COLUMNS);
  assert.equal(ticketOf("/two", 8).state, "gone");
  assert.deepEqual(asked, ["/api/board/board?cwd=%2Ftwo", "/api/board/tasks/7", "/api/board/tasks/8"]);
});

test("a folder whose board does not load still reads its tickets alone, and an unreadable one stays a plain link", async () => {
  serve({
    "/api/board/board": () => ({ status: 500, body: { error: "No board" } }),
    "/api/board/tasks/30": () => ({ body: { task: { id: 30, title: "Elsewhere" } } }),
    "/api/board/tasks/31": () => ({ status: 500, body: { error: "Board offline" } }),
  });
  await need("/three", 30);
  await need("/three", 31);
  const found = ticketOf("/three", 30);
  assert.equal(found.state === "ready" ? found.board : "not ready", null);
  assert.equal(ticketOf("/three", 31).state, "failed");
});

test("a board write reloads the board, and an unchanged reply keeps the last one", async () => {
  noteSnapshot({ boards: [], bySession: {}, changes: 4 }, [], []);
  const asked = serve({
    "/api/board/board": (url) => ({ body: url.searchParams.get("activity") === "a1" ? { unchanged: true } : board([40], "a1") }),
  });
  await need("/four", 40);
  noteSnapshot({ boards: [], bySession: {}, changes: 4 }, [], []);
  await need("/four", 40);
  assert.equal(asked.length, 1);
  noteSnapshot({ boards: [], bySession: {}, changes: 5 }, [], []);
  assert.equal(ticketOf("/four", 40).state, "ready");
  const before = keptBoard("/four");
  await need("/four", 40);
  assert.deepEqual(asked, ["/api/board/board?cwd=%2Ffour", "/api/board/board?cwd=%2Ffour&activity=a1"]);
  assert.equal(ticketOf("/four", 40).state, "ready");
  assert.equal(keptBoard("/four"), before, "an unchanged reply with the same settings keeps the very board");
});

test("a link reads its column's color from the board settings, also after a reply that leaves the board unchanged", async () => {
  noteSnapshot({ boards: [], bySession: {}, changes: 20 }, [], []);
  const painted = (color: string) => ({ columns: { open: { color } }, order: [], moves: {} });
  serve({
    "/api/board/board": (url) => ({
      body: url.searchParams.get("activity") === "a1" ? { unchanged: true, settings: painted("green") } : { ...board([70], "a1"), settings: painted("purple") },
    }),
  });
  const color = () => {
    const ticket = ticketOf("/seven", 70);
    return ticket.state === "ready" ? ticket.board?.columns[0]?.color : null;
  };
  await need("/seven", 70);
  assert.equal(color(), "#c377e0");
  assert.equal(keptBoard("/seven")?.columns[0]?.color, undefined, "the page reads the board as the host sent it");
  noteSnapshot({ boards: [], bySession: {}, changes: 21 }, [], []);
  await need("/seven", 70);
  assert.equal(color(), "#61bd4f");
});

test("a reload of the kept boards loads each in full, also the one a worktree chat keeps for the same board", async () => {
  noteSnapshot({ boards: [], bySession: {}, changes: 30 }, [], []);
  const asked = serve({
    "/api/board/board": (url) => ({ body: url.searchParams.get("activity") === "a1" ? { unchanged: true } : board([80], "a1") }),
  });
  await need("/eight", 80);
  await need("/eight-worktree", 80);
  reloadKept();
  await need("/eight", 80);
  await need("/eight-worktree", 80);
  assert.deepEqual(asked.slice(2), ["/api/board/board?cwd=%2Feight", "/api/board/board?cwd=%2Feight-worktree"]);
});

test("a reload of the kept boards holds while an older load is still on its way", async () => {
  noteSnapshot({ boards: [], bySession: {}, changes: 40 }, [], []);
  let release = () => {};
  const asked = serve({ "/api/board/board": () => ({ body: board([90], "a1") }) });
  const answer = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (asked.length === 0) await new Promise<void>((resolve) => { release = resolve; });
    return answer(input, init);
  };
  const first = need("/nine", 90);
  await Promise.resolve();
  reloadKept();
  release();
  await first;
  await need("/nine", 90);
  assert.deepEqual(asked, ["/api/board/board?cwd=%2Fnine", "/api/board/board?cwd=%2Fnine"], "the load after it sends no stamp");
});

test("a board write while the board loads makes the next read load it again", async () => {
  noteSnapshot({ boards: [], bySession: {}, changes: 10 }, [], []);
  let release = () => {};
  const asked = serve({ "/api/board/board": () => ({ body: board([50]) }) });
  const answer = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (asked.length === 0) await new Promise<void>((resolve) => { release = resolve; });
    return answer(input, init);
  };
  const first = need("/five", 50);
  await Promise.resolve();
  noteSnapshot({ boards: [], bySession: {}, changes: 11 }, [], []);
  release();
  await first;
  await need("/five", 50);
  assert.equal(asked.length, 2);
});

test("a folder that gets or loses a board drops the kept boards", () => {
  noteSnapshot({ boards: ["/six"], bySession: {}, changes: 10 }, [], []);
  keepBoard("/six", { columns: [], tasks: [] });
  noteSnapshot({ boards: ["/six"], bySession: {}, changes: 10 }, [], []);
  assert.ok(keptBoard("/six"));
  noteSnapshot({ boards: [], bySession: {}, changes: 10 }, [], []);
  assert.equal(keptBoard("/six"), null);
});
