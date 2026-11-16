import { after, test } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { installDom } from "../testing/dom.ts";
import type { Desk } from "../deskContext.ts";
import type { TicketLink } from "../../server/snapshot.ts";
import type { TranscriptSession } from "../chat/Transcript.tsx";

const dom = installDom();
const { createRoot } = await import("react-dom/client");
const { DeskContext } = await import("../deskContext.ts");
const { TicketDone, doneTicket } = await import("./TicketDone.tsx");

after(async () => {
  await dom.happyDOM.abort();
  dom.close();
});

const done: TicketLink = { taskId: 549, projectId: 3, title: "Clean up", reference: null, status: "done", cleanup: true };

test("a chat offers to archive itself only once every ticket it has is done", () => {
  assert.equal(doneTicket([done]), done);
  assert.equal(doneTicket([{ ...done, cleanup: undefined }]), null);
  assert.equal(doneTicket([done, { ...done, taskId: 550, status: "active", cleanup: undefined }]), null);
  assert.equal(doneTicket(undefined), null);
});

// The row for a chat with these ticket links, in a worktree it has to itself.
function mount(links: TicketLink[], offered = false) {
  const calls: unknown[][] = [];
  const gate = { hold: false, release: () => {} };
  const desk: Desk = {
    call: async (...args) => {
      calls.push(["call", ...args]);
      if (gate.hold) {
        await new Promise<void>((resolve) => {
          gate.release = resolve;
        });
      }
    },
    notices: [],
    dismissNotice: () => {},
    tickets: { boards: [], bySession: { s: links } },
    projects: [{ cwd: "/repo", name: "repo", sessions: [{ id: "s", cwd: "/wt/fix", title: "Fix", updatedAt: "", worktree: "fix", ownWorktree: true }] }],
    platform: "darwin",
    openFile: () => {},
    openReview: () => {},
    toggleTerminal: () => {},
    openProject: () => {},
    createBoard: () => {},
  };
  const session: TranscriptSession = { id: "s", cwd: "/wt/fix", title: "Fix", transcript: [], status: "idle", configOptions: [], queue: [], revision: 1, modeId: "auto", ...(offered ? { archiveOffer: true as const } : {}) };
  const sessionAct = async (...args: unknown[]) => void calls.push(["act", ...args]);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  return {
    calls,
    gate,
    container,
    render: (running: boolean) => act(async () => root.render(createElement(DeskContext.Provider, { value: desk }, createElement(TicketDone, { session, running, act: sessionAct })))),
    text: () => container.querySelector(".shelf-notice-text")?.textContent,
    archive: () => [...container.querySelectorAll("button")].find((item) => item.textContent === "Archive"),
    keep: () => container.querySelector<HTMLButtonElement>('button[aria-label="Keep this chat"]'),
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("the row archives the chat with its worktree, or keeps it, and waits for the turn to end", async () => {
  const { calls, gate, container, render, text, archive, keep, unmount } = mount([done]);
  try {
    await render(true);
    assert.equal(container.querySelector(".ticket-done"), null);

    await render(false);
    assert.equal(text(), "#549 · Done · Archive this chat and its worktree?");
    await act(async () => archive()?.click());
    assert.deepEqual(calls, [
      ["act", "/api/archive", { worktree: true }],
      ["act", "/api/leave"],
    ]);

    calls.length = 0;
    gate.hold = true;
    await act(async () => keep()?.click());
    assert.deepEqual(calls, [["call", "/api/board/links/cleanup", { sessionId: "s" }, "DELETE"]]);
    assert.equal(archive()?.disabled, true);
    assert.equal(keep()?.disabled, true);
    await act(async () => gate.release());
    assert.equal(archive()?.disabled, false);
  } finally {
    await unmount();
  }
});

test("a chat without a ticket shows the row once its agent offered it, and Keep answers the offer", async () => {
  const quiet = mount([]);
  const { calls, container, render, text, archive, keep, unmount } = mount([], true);
  try {
    await quiet.render(false);
    assert.equal(quiet.container.querySelector(".ticket-done"), null);

    await render(true);
    assert.equal(container.querySelector(".ticket-done"), null);
    await render(false);
    assert.equal(text(), "Work done · Archive this chat and its worktree?");
    await act(async () => keep()?.click());
    assert.deepEqual(calls, [["act", "/api/archive/keep"]]);

    calls.length = 0;
    await act(async () => archive()?.click());
    assert.deepEqual(calls, [
      ["act", "/api/archive", { worktree: true }],
      ["act", "/api/leave"],
    ]);
  } finally {
    await quiet.unmount();
    await unmount();
  }
});

test("an offered chat waits for its open ticket, and a done ticket names the row", async () => {
  const open = mount([{ ...done, status: "review", cleanup: undefined }], true);
  const closed = mount([done], true);
  try {
    await open.render(false);
    assert.equal(open.container.querySelector(".ticket-done"), null);

    await closed.render(false);
    assert.equal(closed.text(), "#549 · Done · Archive this chat and its worktree?");
    await act(async () => closed.keep()?.click());
    assert.deepEqual(closed.calls, [
      ["call", "/api/board/links/cleanup", { sessionId: "s" }, "DELETE"],
      ["act", "/api/archive/keep"],
    ]);
  } finally {
    await open.unmount();
    await closed.unmount();
  }
});
