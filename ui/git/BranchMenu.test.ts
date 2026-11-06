import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { act, createElement, useState } from "react";
import type { Root } from "react-dom/client";
import { click, installDom } from "../testing/dom.ts";
import type { WorktreePlan } from "../folder/draftWorktree.ts";

// react-dom checks for a DOM when it loads, so it comes in after installDom.
const dom = installDom();
const { createRoot } = await import("react-dom/client");
const { BranchMenu } = await import("./BranchMenu.tsx");

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

// A draft's branch chip on /repo, checked out on feature, with main as the default branch.
async function mountDraft(start?: WorktreePlan, repoRoot = "/repo", linked = false) {
  const requests: [string, Record<string, unknown>][] = [];
  const plans: WorktreePlan[] = [];
  const reported: string[] = [];
  let checkedOut = "feature";

  const call = async (path: string, body: Record<string, unknown>) => {
    requests.push([path, body]);
    if (path === "/api/folder/checkout") {
      checkedOut = String(body.branch);
      return { branch: checkedOut };
    }
    return {
      branch: checkedOut,
      root: repoRoot,
      defaultBranch: "main",
      branches: ["main", "feature", "topic"].map((name) => ({ name, current: name === checkedOut, remote: false })),
      worktrees: [],
      worktree: linked,
    };
  };
  function Draft() {
    const [worktree, setWorktree] = useState<WorktreePlan | undefined>(start);
    return createElement(BranchMenu, {
      call,
      cwd: "/repo",
      unscoped: true,
      onBranch: (branch: string) => reported.push(branch),
      worktree,
      onWorktree: (plan: WorktreePlan) => {
        plans.push(plan);
        setWorktree(plan);
      },
    });
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);
  await act(async () => root.render(createElement(Draft)));
  const label = () => container.querySelector(".branch-name")?.textContent;
  const pick = async (name: string) => {
    await act(async () => click(must(container.querySelector("[data-testid=branch-menu]"))));
    const row = [...container.querySelectorAll(".branch-list button")].find((button) => button.firstElementChild?.textContent === name);
    await act(async () => click(must(row ?? null)));
  };
  const tick = () => act(async () => click(must(container.querySelector("[data-testid=new-worktree]"))));
  const box = () => must(container.querySelector("[data-testid=new-worktree]"));
  const detach = async () => {
    checkedOut = "";
    await act(async () => click(must(container.querySelector("[data-testid=branch-menu]"))));
    await act(async () => click(must(container.querySelector("[data-testid=branch-menu]"))));
  };
  return { requests, plans, reported, label, pick, tick, box, detach };
}

function must(element: Element | null): Element {
  assert.ok(element, "the element is missing");
  return element;
}

test("without the worktree box, picking a branch checks it out in the folder", async () => {
  const menu = await mountDraft();
  assert.equal(menu.label(), "feature");
  await menu.pick("topic");
  assert.deepEqual(menu.requests.filter(([path]) => path === "/api/folder/checkout"), [["/api/folder/checkout", { cwd: "/repo", branch: "topic" }]]);
  assert.equal(menu.label(), "topic");
  assert.deepEqual(menu.plans, []);
  assert.deepEqual(menu.reported, ["feature", "topic"]);
});

test("a detached HEAD reports an empty branch, so the shelf drops the pull request", async () => {
  const menu = await mountDraft();
  await menu.detach();
  assert.equal(menu.reported.at(-1), "");
});

test("with the worktree box, picking a branch only sets the ref the worktree starts from", async () => {
  const menu = await mountDraft();
  await menu.tick();
  assert.deepEqual(menu.plans.at(-1), { on: true, gitRef: "" });
  assert.equal(menu.label(), "main");
  await menu.pick("topic");
  assert.deepEqual(menu.plans.at(-1), { on: true, gitRef: "topic" });
  assert.equal(menu.label(), "topic");
  assert.equal(menu.requests.some(([path]) => path === "/api/folder/checkout"), false);
  await menu.tick();
  assert.deepEqual(menu.plans.at(-1), { on: false, gitRef: "topic" });
  assert.equal(menu.label(), "feature");
});

test("a remembered box shows the default branch, and a folder outside git or in a worktree cannot tick it", async () => {
  const remembered = await mountDraft({ on: true, gitRef: "" });
  assert.equal(remembered.label(), "main");
  assert.equal(remembered.box().getAttribute("aria-pressed"), "true");

  const outside = await mountDraft({ on: true, gitRef: "" }, "");
  assert.equal(outside.box().getAttribute("aria-pressed"), "false");
  assert.equal(outside.box().hasAttribute("disabled"), true);

  const inTree = await mountDraft({ on: true, gitRef: "" }, "/repo", true);
  assert.equal(inTree.box().getAttribute("aria-pressed"), "false");
  assert.equal(inTree.box().hasAttribute("disabled"), true);
  assert.equal(inTree.label(), "feature");
});
