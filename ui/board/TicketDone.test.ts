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

test("the row archives the chat with its worktree, or keeps it, and waits for the turn to end", async () => {
  const calls: unknown[][] = [];
  let release = () => {};
  let hold = false;
  const desk: Desk = {
    call: async (...args) => {
      calls.push(["call", ...args]);
      if (hold) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
    },
    notices: [],
    dismissNotice: () => {},
    tickets: { boards: [], bySession: { s: [done] } },
    projects: [{ cwd: "/repo", name: "repo", sessions: [{ id: "s", cwd: "/wt/fix", title: "Fix", updatedAt: "", worktree: "fix", ownWorktree: true }] }],
    platform: "darwin",
    openFile: () => {},
    openReview: () => {},
    toggleTerminal: () => {},
    openProject: () => {},
    createBoard: () => {},
  };
  const session: TranscriptSession = { id: "s", cwd: "/wt/fix", title: "Fix", transcript: [], status: "idle", configOptions: [], queue: [], revision: 1, modeId: "auto" };
  const sessionAct = async (...args: unknown[]) => void calls.push(["act", ...args]);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (running: boolean) => act(async () => root.render(createElement(DeskContext.Provider, { value: desk }, createElement(TicketDone, { session, running, act: sessionAct }))));
  const archive = () => [...container.querySelectorAll("button")].find((item) => item.textContent === "Archive");
  const keep = () => container.querySelector<HTMLButtonElement>('button[aria-label="Keep this chat"]');
  try {
    await render(true);
    assert.equal(container.querySelector(".ticket-done"), null);

    await render(false);
    assert.equal(container.querySelector(".shelf-notice-text")?.textContent, "#549 · Done · Archive this chat and its worktree?");
    await act(async () => archive()?.click());
    assert.deepEqual(calls, [
      ["act", "/api/archive", { worktree: true }],
      ["act", "/api/leave"],
    ]);

    calls.length = 0;
    hold = true;
    await act(async () => keep()?.click());
    assert.deepEqual(calls, [["call", "/api/board/links/cleanup", { sessionId: "s" }, "DELETE"]]);
    assert.equal(archive()?.disabled, true);
    assert.equal(keep()?.disabled, true);
    await act(async () => release());
    assert.equal(archive()?.disabled, false);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
