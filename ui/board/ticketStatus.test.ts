import assert from "node:assert/strict";
import test from "node:test";
import { TICKET_STATUS, statusTone, threadCount, ticketTone } from "./ticketStatus.ts";

test("a ticket counts one thread per connected chat", () => {
  const tickets = {
    bySession: {
      "sess-1": [{ taskId: 72 }, { taskId: 40 }],
      "sess-2": [{ taskId: 72 }, { taskId: 72 }],
      "sess-3": [{ taskId: "abc" }],
    },
  };
  assert.equal(threadCount(72, tickets), 2);
  assert.equal(threadCount("72", tickets), 2);
  assert.equal(threadCount(40, tickets), 1);
  assert.equal(threadCount("abc", tickets), 1);
  assert.equal(threadCount(1, tickets), 0);
  assert.equal(threadCount(null, tickets), 0);
  assert.equal(threadCount(72, null), 0);
});

test("a linked chat takes the strongest ticket status", () => {
  assert.equal(ticketTone([{ status: "done" }, { status: "active" }]), TICKET_STATUS.active);
  assert.equal(ticketTone([{ status: "done" }, { status: "review" }]), TICKET_STATUS.review);
  assert.equal(ticketTone([{ status: "open" }]), TICKET_STATUS.open);
  assert.equal(ticketTone([{ status: null }]), undefined);
  assert.equal(ticketTone([{ status: "Done" }, { status: "In Progress" }]), TICKET_STATUS.active);
});

test("a chat's bar takes its foremost ticket's column color, or the color of the status name", () => {
  assert.equal(ticketTone([{ status: "done", color: "#61bd4f" }, { status: "active", color: "#c377e0" }]), "#c377e0");
  assert.equal(ticketTone([{ status: "review" }]), TICKET_STATUS.review);
  assert.equal(ticketTone([{ status: "2. Doing", color: "#0079bf" }]), "#0079bf");
  assert.equal(ticketTone([{ status: "2. Doing" }]), undefined);
  assert.equal(ticketTone([]), undefined);
});

test("another board's column names take the four status colors", () => {
  assert.equal(statusTone("In Progress"), TICKET_STATUS.active);
  assert.equal(statusTone("To Do"), TICKET_STATUS.open);
  assert.equal(statusTone("Done"), TICKET_STATUS.done);
  assert.equal(statusTone("Shipped"), undefined);
});
