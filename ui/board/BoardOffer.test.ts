import { after, test } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { installDom } from "../testing/dom.ts";
import type { Desk } from "../deskContext.ts";
import type { SidebarProject } from "../../server/snapshot.ts";
import type { TranscriptSession } from "../chat/Transcript.tsx";

const dom = installDom();
const { createRoot } = await import("react-dom/client");
const { DeskContext } = await import("../deskContext.ts");
const { BoardOffer, boardOfferDue } = await import("./BoardOffer.tsx");

after(async () => {
  await dom.happyDOM.abort();
  dom.close();
});

const chat = { id: "s", cwd: "/repo", title: "First", updatedAt: "" };
const project: SidebarProject = { cwd: "/repo", name: "repo", sessions: [chat] };

test("the board offer is due in the first chat of a project without a board, until it is answered", () => {
  assert.equal(boardOfferDue(project, false, "s"), true);
  assert.equal(boardOfferDue(project, true, "s"), false, "the project has a board");
  assert.equal(boardOfferDue({ ...project, sessions: [chat, { ...chat, id: "t" }] }, false, "s"), false, "not the project's first chat");
  assert.equal(boardOfferDue({ ...project, sessions: [] }, false, "s"), false);
  localStorage.setItem("x-bench-board-offer:/repo", "1");
  assert.equal(boardOfferDue(project, false, "s"), false, "answered before");
  localStorage.clear();
});

test("Create board opens the sheet and the offer stays until the folder has a board, while Not now hides it for good", async () => {
  const created: unknown[] = [];
  const desk: Desk = {
    call: async () => null,
    notices: [],
    dismissNotice: () => {},
    tickets: { boards: [], bySession: {} },
    projects: [project],
    platform: "darwin",
    openFile: () => {},
    openReview: () => {},
    toggleTerminal: () => {},
    openProject: () => {},
    createBoard: (picked) => void created.push(picked),
  };
  const session: TranscriptSession = { id: "s", cwd: "/repo", title: "First", transcript: [{ id: "a", type: "assistant", text: "Hi", streaming: false }], status: "idle", configOptions: [], queue: [], revision: 1, modeId: "auto" };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const card = () => container.querySelector('[data-testid="board-offer"]');
  const render = (value: Desk, shown = session) => act(async () => root.render(createElement(DeskContext.Provider, { value }, createElement(BoardOffer, { session: shown }))));
  const click = (label: string) => act(async () => [...container.querySelectorAll("button")].find((item) => item.textContent === label)?.click());
  try {
    await render(desk, { ...session, transcript: [] });
    assert.equal(card(), null, "no reply yet");
    await render(desk, { ...session, loading: true });
    assert.equal(card(), null, "still loading");
    await render(desk);
    await click("Create board");
    assert.deepEqual(created, [{ cwd: "/repo", name: "repo" }]);
    assert.ok(card(), "a cancelled sheet leaves the offer");
    await render({ ...desk, tickets: { boards: ["/repo"], bySession: {} } });
    assert.equal(card(), null, "the folder has a board");
    await render(desk);
    await click("Not now");
    assert.equal(card(), null);
    await render({ ...desk });
    assert.equal(card(), null, "declined for good");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    localStorage.clear();
  }
});
