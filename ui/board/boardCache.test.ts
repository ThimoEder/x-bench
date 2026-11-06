import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { need, noteSnapshot, ticketOf } from "./boardCache.ts";

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
  await need("/four", 40);
  assert.deepEqual(asked, ["/api/board/board?cwd=%2Ffour", "/api/board/board?cwd=%2Ffour&activity=a1"]);
  assert.equal(ticketOf("/four", 40).state, "ready");
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
