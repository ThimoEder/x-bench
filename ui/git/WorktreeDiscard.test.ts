import { after, test } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { click, installDom, press } from "../testing/dom.ts";

const dom = installDom();
const { createRoot } = await import("react-dom/client");
const { useWorktreeDiscard } = await import("./WorktreeDiscard.tsx");

after(async () => {
  await dom.happyDOM.abort();
  dom.close();
});

const CHANGES = {
  branch: "claude/tidy",
  commit: "abc1234",
  root: "/wt/tidy",
  files: [
    { path: "src/app.ts", type: "edit", additions: 3, deletions: 1 },
    { path: "draft.md", type: "untracked", additions: 2, deletions: 0 },
  ],
};

async function render(dirty: boolean) {
  const sent: unknown[] = [];
  const results: boolean[] = [];
  const send = async (body: unknown) => {
    sent.push(body);
    return dirty && sent.length === 1 ? { changes: CHANGES } : { ok: true };
  };
  function Probe() {
    const discard = useWorktreeDiscard();
    return createElement("div", null, createElement("button", { type: "button", className: "go", onClick: () => void discard.guard("delete", send).then((gone) => results.push(gone)) }), discard.dialog);
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(Probe)));
  const dialog = () => document.body.querySelector<HTMLElement>('[data-testid="worktree-discard"]');
  const button = (label: string) => {
    const found = [...(dialog()?.querySelectorAll("button") ?? [])].find((item) => item.textContent === label);
    assert.ok(found, `no ${label} in the dialog`);
    return found;
  };
  const go = async () => {
    sent.length = 0;
    await act(async () => click(container.querySelector(".go") as Element));
  };
  const goTwice = () => act(async () => [0, 1].forEach(() => click(container.querySelector(".go") as Element)));
  return { sent, results, dialog, button, go, goTwice, unmount: () => act(async () => root.unmount()) };
}

test("a clean worktree goes with the chat without a dialog", async () => {
  const view = await render(false);
  try {
    await view.go();
    assert.equal(view.dialog(), null);
    assert.deepEqual(view.sent, [{ worktree: true }]);
    assert.deepEqual(view.results, [true]);
  } finally {
    await view.unmount();
  }
});

test("uncommitted changes show as in the Changes pane, and Discard asks for a second click", async () => {
  const view = await render(true);
  try {
    await view.go();
    assert.equal(view.dialog()?.querySelector("h3")?.textContent, "2 uncommitted files in this worktree");
    assert.deepEqual([...(view.dialog()?.querySelectorAll(".worktree-files li") ?? [])].map((row) => row.textContent), ["src/app.ts+3−1", "draft.mdnew+2"]);
    assert.equal(document.activeElement, view.button("Delete the chat only"));

    await act(async () => click(view.button("Discard changes")));
    assert.deepEqual(view.sent, [{ worktree: true }]);
    await act(async () => click(view.button("Discard 2 files?")));
    assert.deepEqual(view.sent, [{ worktree: true }, { worktree: true, discard: true }]);
    assert.equal(view.dialog(), null);
    assert.deepEqual(view.results, [true]);
  } finally {
    await view.unmount();
  }
});

test("keeping the worktree deletes only the chat, and Escape cancels", async () => {
  const view = await render(true);
  try {
    await view.go();
    await act(async () => click(view.button("Delete the chat only")));
    assert.deepEqual(view.sent, [{ worktree: true }, { worktree: false }]);
    assert.equal(view.dialog(), null);
    assert.deepEqual(view.results, [true]);
  } finally {
    await view.unmount();
  }
  const cancelled = await render(true);
  try {
    await cancelled.go();
    await act(async () => press(document.body, "Escape"));
    assert.equal(cancelled.dialog(), null);
    assert.deepEqual(cancelled.sent, [{ worktree: true }]);
    assert.deepEqual(cancelled.results, [false]);
  } finally {
    await cancelled.unmount();
  }
});

test("a second worktree delete started while the first one asks resolves false without sending", async () => {
  const view = await render(true);
  try {
    await view.goTwice();
    assert.deepEqual(view.sent, [{ worktree: true }]);
    assert.deepEqual(view.results, [false]);
    assert.equal(view.button("Discard changes").className, "danger");

    await act(async () => click(view.button("Delete the chat only")));
    assert.deepEqual(view.results, [false, true]);
    await view.go();
    assert.ok(view.dialog());
  } finally {
    await view.unmount();
  }
});
