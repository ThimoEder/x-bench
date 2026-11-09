import { after, test } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { installDom } from "../testing/dom.ts";
import type { Desk } from "../deskContext.ts";
import type { TranscriptSession } from "./Transcript.tsx";

const dom = installDom();
const { createRoot } = await import("react-dom/client");
const { DeskContext } = await import("../deskContext.ts");
const { Transcript } = await import("./Transcript.tsx");

after(async () => {
  await dom.happyDOM.abort();
  dom.close();
});

test("a chat whose folder is gone asks git nothing, and its branch chip and line counts come back once it moves", async () => {
  const calls: string[] = [];
  const desk: Desk = {
    call: async (path) => {
      calls.push(path);
      if (path === "/api/git/refs") return { branch: "main", root: "/repo/next", branches: [{ name: "main", current: true, remote: false }], worktrees: [] };
      if (path === "/api/git") return { files: [{ path: "a.ts", additions: 2, deletions: 1 }] };
      return null;
    },
    notices: [],
    dismissNotice: () => {},
    tickets: { boards: [], bySession: {} },
    projects: [],
    platform: "darwin",
    openFile: () => {},
    openReview: () => {},
    toggleTerminal: () => {},
    openProject: () => {},
    createBoard: () => {},
  };
  const chat: TranscriptSession = { id: "s", cwd: "/repo", title: "Chat", transcript: [], status: "idle", configOptions: [], queue: [], revision: 1, modeId: "auto" };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (session: TranscriptSession) => act(async () => root.render(createElement(DeskContext.Provider, { value: desk }, createElement(Transcript, { session }))));
  try {
    await render({ ...chat, folderGone: { path: "/repo/gone", home: "/repo", branch: "main" } });
    assert.ok(container.querySelector(".pane-bar"));
    assert.ok(container.querySelector(".folder-gone"));
    assert.equal(container.querySelector("[data-testid=branch-menu]"), null);
    assert.equal(container.querySelector("[data-testid=shelf-diff]"), null);
    assert.deepEqual(calls.filter((path) => path.startsWith("/api/git")), []);

    await render({ ...chat, cwd: "/repo/next" });
    assert.equal(container.querySelector(".folder-gone"), null);
    assert.equal(container.querySelector("[data-testid=branch-menu]")?.textContent, "next:main");
    assert.equal(container.querySelector("[data-testid=shelf-diff]")?.textContent, "+2−1");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
