import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import type { TicketLink } from "../../server/snapshot.ts";
import { click, installDom, wait } from "../testing/dom.ts";

// react-dom checks for a DOM when it loads, so it comes in after installDom.
const dom = installDom();
const { createRoot } = await import("react-dom/client");
const { TicketChips, ticketNumber } = await import("./TicketCreate.tsx");

const mounted: Root[] = [];

afterEach(async () => {
  await act(async () => {
    for (const root of mounted.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
});

after(async () => {
  await dom.happyDOM.abort();
  dom.close();
});

const link: TicketLink = { taskId: 9001, projectId: 1, title: "Wrap long links", reference: 142, status: "active" };
const sakMoves = ["open", "review", "done", null].map((status) => ({ status, title: status ?? "unset", needs: [] }));

async function mount(
  calls: [string, Record<string, unknown>, string | undefined][],
  opened: unknown[] = [],
  move: () => Promise<unknown> = async () => ({}),
  { ticket = link, moves = sakMoves }: { ticket?: TicketLink; moves?: unknown[] } = {},
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);
  const call = async (path: string, body: Record<string, unknown>, method?: string) => {
    calls.push([path, body, method]);
    if (method !== "GET") return move();
    return path.endsWith("/moves?cwd=%2Frepo") ? { moves } : { task: { description: "Long URLs run past the bubble edge." } };
  };
  await act(async () =>
    root.render(
      createElement(TicketChips, {
        session: { id: "s1", cwd: "/repo" },
        tickets: { boards: ["/repo"], bySession: { s1: [ticket] } },
        onOpen: (cwd, taskId) => opened.push([cwd, taskId]),
        call,
      }),
    ),
  );
  return container;
}

test("a ticket shows as its board number, or its status when it has none", () => {
  assert.equal(ticketNumber({ taskId: 9001, reference: 142 }), "#142");
  assert.equal(ticketNumber({ taskId: "77", reference: null }), "#77");
  assert.equal(ticketNumber({ taskId: "5f1c0a2b9d3e4f5a6b7c8d9e", reference: null }), null);
});

test("the ticket card reads the description, opens the ticket from its title and moves it between statuses", async () => {
  const calls: [string, Record<string, unknown>, string | undefined][] = [];
  const opened: unknown[] = [];
  const container = await mount(calls, opened);
  const chip = container.querySelector("[data-testid=ticket-chip]");
  assert.equal(chip?.textContent, "#142");
  await click(chip as Element);
  await act(async () => wait(10));
  const card = document.querySelector("[data-testid=ticket-card]");
  assert.ok(card);
  assert.match(card.querySelector(".ticket-card-text")?.textContent ?? "", /Long URLs run past the bubble edge/);
  assert.deepEqual(calls[0], ["/api/board/tasks/9001", {}, "GET"]);

  const review = [...card.querySelectorAll(".ticket-card-statuses button")].find((button) => button.textContent?.includes("review"));
  await click(review as Element);
  assert.deepEqual(calls.at(-1), ["/api/board/move", { taskId: 9001, status: "review", cwd: "/repo" }, undefined]);
  assert.equal(review?.getAttribute("aria-pressed"), "true");

  await click(card.querySelector(".ticket-card-head") as Element);
  assert.deepEqual(opened, [["/repo", 9001]]);
});

test("a second status waits for the first move, and a failed move goes back to the board's status", async () => {
  const calls: [string, Record<string, unknown>, string | undefined][] = [];
  let fail: (error: Error) => void = () => {};
  const container = await mount(calls, [], () => new Promise((_, reject) => { fail = reject; }));
  await click(container.querySelector("[data-testid=ticket-chip]") as Element);
  await act(async () => wait(10));
  const card = document.querySelector("[data-testid=ticket-card]") as Element;
  const pick = (name: string) => [...card.querySelectorAll(".ticket-card-statuses button")].find((button) => button.textContent?.includes(name)) as HTMLButtonElement;
  await click(pick("review"));
  assert.equal(pick("review").getAttribute("aria-pressed"), "true");
  assert.equal(pick("done").disabled, true);
  await click(pick("done"));
  assert.equal(calls.filter(([path]) => path === "/api/board/move").length, 1);
  await act(async () => fail(new Error("offline")));
  await act(async () => wait(10));
  assert.equal(pick("active").getAttribute("aria-pressed"), "true");
  assert.equal(pick("done").disabled, false);
});

test("a Jira ticket moves to the columns its workflow allows, and a move that needs fields opens the board", async () => {
  const calls: [string, Record<string, unknown>, string | undefined][] = [];
  const opened: unknown[] = [];
  const ticket: TicketLink = { taskId: "APP-12", projectId: 0, title: "Fix login", reference: null, status: "In Progress" };
  const moves = [{ status: "Done", title: "Done", needs: [] }, { status: "Closed", title: "Closed", needs: [{ id: "resolution", name: "Resolution" }] }];
  const container = await mount(calls, opened, async () => ({}), { ticket, moves });
  assert.equal(container.querySelector("[data-testid=ticket-chip]")?.textContent, "In Progress");
  await click(container.querySelector("[data-testid=ticket-chip]") as Element);
  await act(async () => wait(10));
  const card = document.querySelector("[data-testid=ticket-card]") as Element;
  const pick = (name: string) => [...card.querySelectorAll(".ticket-card-statuses button")].find((button) => button.textContent?.includes(name)) as HTMLButtonElement;
  assert.deepEqual([...card.querySelectorAll(".ticket-card-status")].map((item) => item.textContent), ["In Progress", "Done", "Closed"]);
  assert.equal(pick("In Progress").getAttribute("aria-pressed"), "true");

  await click(pick("Closed"));
  assert.deepEqual(opened, [["/repo", "APP-12"]]);
  assert.equal(calls.filter(([path]) => path === "/api/board/move").length, 0);
});

test("a Jira ticket moves from the thread to Done", async () => {
  const calls: [string, Record<string, unknown>, string | undefined][] = [];
  const ticket: TicketLink = { taskId: "APP-12", projectId: 0, title: "Fix login", reference: null, status: "In Progress" };
  const container = await mount(calls, [], async () => ({}), { ticket, moves: [{ status: "Done", title: "Done", needs: [] }] });
  await click(container.querySelector("[data-testid=ticket-chip]") as Element);
  await act(async () => wait(10));
  const done = [...document.querySelectorAll(".ticket-card-statuses button")].find((button) => button.textContent?.includes("Done")) as Element;
  await click(done);
  assert.deepEqual(calls.at(-1), ["/api/board/move", { taskId: "APP-12", status: "Done", cwd: "/repo" }, undefined]);
  assert.equal(done.getAttribute("aria-pressed"), "true");
});

test("a Trello card moves to another list with the same name as its own", async () => {
  const calls: [string, Record<string, unknown>, string | undefined][] = [];
  const ticket: TicketLink = { taskId: "5f1c0a2b9d3e4f5a6b7c8d9e", projectId: 0, title: "Ship it", reference: 7, status: "Done" };
  const moves = [{ status: "b".repeat(24), title: "Done", needs: [] }, { status: "c".repeat(24), title: "Doing", needs: [] }];
  const container = await mount(calls, [], async () => ({}), { ticket, moves });
  await click(container.querySelector("[data-testid=ticket-chip]") as Element);
  await act(async () => wait(10));
  const rows = [...document.querySelectorAll(".ticket-card-statuses button")];
  assert.deepEqual(rows.map((row) => row.querySelector(".ticket-card-status")?.textContent), ["Done", "Done", "Doing"]);
  assert.deepEqual(rows.map((row) => row.getAttribute("aria-pressed")), ["true", "false", "false"]);
  await click(rows[1] as Element);
  assert.deepEqual(calls.at(-1), ["/api/board/move", { taskId: ticket.taskId, status: "b".repeat(24), cwd: "/repo" }, undefined]);
  assert.deepEqual(rows.map((row) => row.getAttribute("aria-pressed")), ["false", "true", "false"]);
});
