import assert from "node:assert/strict";
import test from "node:test";
import { TICKET_STATUS, statusTone, threadCount, ticketStatus } from "./ticketStatus.ts";

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
  assert.equal(ticketStatus([{ status: "done" }, { status: "active" }]), "active");
  assert.equal(ticketStatus([{ status: "done" }, { status: "review" }]), "review");
  assert.equal(ticketStatus([{ status: "open" }]), "open");
  assert.equal(ticketStatus([{ status: null }]), "");
  assert.equal(ticketStatus([{ status: "Done" }, { status: "In Progress" }]), "active");
});

test("another board's column names take the four status colors", () => {
  assert.equal(statusTone("In Progress"), TICKET_STATUS.active);
  assert.equal(statusTone("To Do"), TICKET_STATUS.open);
  assert.equal(statusTone("Done"), TICKET_STATUS.done);
  assert.equal(statusTone("Shipped"), undefined);
});
