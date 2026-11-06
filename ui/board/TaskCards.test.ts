import { after, test } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import type { TaskSuggestion } from "../../server/snapshot.ts";
import { click, installDom } from "../testing/dom.ts";
import { boardFolder, projectFolder, ticketDescription } from "./suggestedTask.ts";

// react-dom checks for a DOM when it loads, so it comes in after installDom.
const dom = installDom();
const { createRoot } = await import("react-dom/client");
const { TaskCards, swipeOutcome, withKept } = await import("./TaskCards.tsx");

after(async () => {
  await dom.happyDOM.abort();
  dom.close();
});

const suggestion: TaskSuggestion = {
  id: "a1",
  title: "Fix the stale badge",
  summary: "The README badge points at the old CI.",
  prompt: "Point the badge in README.md at the new workflow.",
  createdAt: "2026-09-29T00:00:00.000Z",
};

// A dismissed card floats out before its dismiss is sent.
const floatedOut = () =>
  act(
    () =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, 260);
      }),
  );

function view_button(container: HTMLElement, label: string) {
  const found = [...container.querySelectorAll("button")].find((item) => (item.getAttribute("aria-label") || item.textContent) === label);
  assert.ok(found, `no ${label} button`);
  return found;
}

const projects = [{ cwd: "/repo", sessions: [{ id: "wt" }, { id: "main" }] }];

test("a worktree chat's task goes to its project, and its ticket to the project's board", () => {
  const worktree = { id: "wt", cwd: "/repo/.claude/worktrees/one" };
  assert.equal(projectFolder(worktree, projects), "/repo");
  assert.equal(projectFolder({ id: "loose", cwd: "/elsewhere" }, projects), "/elsewhere");
  assert.equal(boardFolder(worktree, { boards: ["/repo"] }, projects), "/repo");
  assert.equal(boardFolder({ id: "main", cwd: "/repo" }, { boards: ["/repo"] }, projects), "/repo");
  assert.equal(boardFolder(worktree, { boards: ["/other"] }, projects), null);
  assert.equal(boardFolder(worktree, null, null), null);
  const routines = [{ cwd: "/repo", runs: [{ sessionId: "run" }, {}] }];
  const run = { id: "run", cwd: "/worktrees/routine-retro" };
  assert.equal(projectFolder(run, projects, routines), "/repo");
  assert.equal(boardFolder(run, { boards: ["/repo"] }, projects, routines), "/repo");
  assert.equal(boardFolder(run, { boards: ["/repo"] }, projects), null);
  assert.equal(ticketDescription(suggestion), "The README badge points at the old CI.\n\nPoint the badge in README.md at the new workflow.");
});

async function render(props: Partial<Parameters<typeof TaskCards>[0]>) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const calls: [string, Record<string, unknown>][] = [];
  const acts: [string, Record<string, unknown> | undefined][] = [];
  await act(async () =>
    root.render(
      createElement(TaskCards, {
        suggestions: [suggestion],
        board: null,
        call: async (path, body) => {
          calls.push([path, body]);
          return {};
        },
        act: async (path, body) => {
          acts.push([path, body]);
          return {};
        },
        ...props,
      }),
    ),
  );
  const buttons = () => [...container.querySelectorAll("button")];
  const labels = () => buttons().map((button) => button.getAttribute("aria-label") || button.textContent);
  const button = (label: string) => {
    const found = buttons().find((item) => (item.getAttribute("aria-label") || item.textContent) === label);
    assert.ok(found, `no ${label} button`);
    return found;
  };
  return {
    container,
    calls,
    acts,
    labels,
    button,
    async done() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("a card starts in a worktree, or another way from the split button's menu, then goes", async () => {
  const choices: [string, string][] = [
    ["Start in worktree", "worktree"],
    ["Branch from latest main", "branch"],
    ["Start in current folder", "folder"],
  ];
  for (const [label, where] of choices) {
    const started: [string, string][] = [];
    const view = await render({
      onStart: (item, choice) => {
        started.push([item.id, choice]);
      },
    });
    assert.deepEqual(view.labels(), ["Prompt Point the badge in README.md at the new workflow.", "Start in worktree", "More ways to start", "Dismiss suggestion: Fix the stale badge"]);
    if (where !== "worktree") {
      await act(async () => click(view.button("More ways to start")));
      assert.deepEqual([...view.container.querySelectorAll("[role=menuitem]")].map((item) => item.textContent), ["Branch from latest main", "Start in current folder"]);
    }
    await act(async () => click(view.button(label)));
    assert.equal(view.container.querySelector("[role=menu]"), null, "choosing closes the menu");
    assert.deepEqual(started, [["a1", where]]);
    // The task runs in its own chat now and the host dropped the suggestion, so the card only floats out.
    assert.equal(view.container.querySelector(".task-card")?.getAttribute("data-swipe"), "out");
    await floatedOut();
    assert.deepEqual(view.acts, [], "the host dropped it when the chat started");
    await view.done();
  }
});

test("Dismiss floats the card out before it sends the dismiss", async () => {
  const view = await render({});
  await act(async () => click(view.button("Dismiss suggestion: Fix the stale badge")));
  assert.equal(view.container.querySelector(".task-card")?.getAttribute("data-swipe"), "out", "the card floats out first");
  assert.deepEqual(view.acts, []);
  await floatedOut();
  assert.deepEqual(view.acts, [["/api/suggestions/dismiss", { id: "a1" }]]);
  await view.done();
});

test("a chat on the Chat tab has one Start chat", async () => {
  const started: string[] = [];
  const view = await render({ git: false, onStart: (_item, where) => void started.push(where) });
  assert.deepEqual(view.labels(), ["Prompt Point the badge in README.md at the new workflow.", "Start chat", "Dismiss suggestion: Fix the stale badge"]);
  await act(async () => click(view.button("Start chat")));
  assert.deepEqual(started, ["folder"]);
  await floatedOut();
  await view.done();
});

test("a failed start stays on the card", async () => {
  const view = await render({
    onStart: async () => {
      throw new Error("Worktrees need the grok CLI");
    },
  });
  await act(async () => click(view.button("Start in worktree")));
  assert.equal(view.container.querySelector("[role=alert]")?.textContent, "Worktrees need the grok CLI");
  assert.equal(view.container.querySelector(".task-card")?.getAttribute("data-swipe"), "rest", "a failed start keeps the card");
  assert.deepEqual(view.acts, []);
  await view.done();
});

test("several suggestions stack with the newest on top, fan out oldest first, and fold back", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const more = ["b2", "c3", "d4"].map((id, index) => ({ ...suggestion, id, title: `Task ${index + 2}` }));
  const view = await render({ suggestions: [suggestion, ...more] });
  const titles = () => [...view.container.querySelectorAll(".task-card-title")].map((item) => item.textContent);
  const front = () => [...view.container.querySelectorAll(".task-card:not(.behind) .task-card-title")].map((item) => item.textContent);
  // The two before the newest lie whole behind it, so a swipe shows the next card. The oldest waits out of sight.
  assert.deepEqual(front(), ["Task 4"]);
  assert.deepEqual(titles(), ["Task 2", "Task 3", "Task 4"]);
  const behind = [...view.container.querySelectorAll<HTMLElement>(".task-card.behind")];
  assert.equal(behind.length, 2);
  assert.ok(behind.every((card) => card.getAttribute("aria-hidden") === "true" && card.querySelector("[inert]")), "the cards behind cannot be reached");
  assert.equal(view.container.querySelector(".task-stack-toggle")?.textContent, "4 suggested tasks · Show all");

  await act(async () => click(view.button("4 suggested tasks · Show all")));
  // The newest card stays next to the composer. The older ones come out above it, and animate.
  assert.deepEqual(titles(), ["Fix the stale badge", "Task 2", "Task 3", "Task 4"]);
  assert.equal(view.container.querySelectorAll(".task-card.fanning").length, 3);
  const layers = [...view.container.querySelectorAll<HTMLElement>(".task-card")].map((card) => Number(card.style.getPropertyValue("--card-z")));
  assert.deepEqual(layers, [7, 8, 9, 10], "each older card slides out from underneath the ones nearer the newest");
  assert.equal(view.container.querySelectorAll(".task-card.behind").length, 0);

  await act(async () => click(view.button("4 suggested tasks · Show less")));
  assert.ok(view.container.querySelector(".task-stack.closing"), "the older cards slide back first");
  assert.equal(titles().length, 4);
  await act(async () => t.mock.timers.tick(250));
  assert.deepEqual(front(), ["Task 4"]);

  // A click on a card behind opens the stack too.
  const back = view.container.querySelector(".task-card.behind");
  assert.ok(back);
  await act(async () => click(back));
  assert.equal(view.container.querySelectorAll(".task-card.behind").length, 0);
  await view.done();
});

test("a card dragged far enough sideways is dismissed, and a short drag puts it back", async () => {
  assert.equal(swipeOutcome(40, 400), "back");
  assert.equal(swipeOutcome(-140, 400), "dismiss");
  assert.equal(swipeOutcome(100, 240), "dismiss", "a third of a narrow card is enough");

  const view = await render({});
  const card = view.container.querySelector(".task-card");
  assert.ok(card);
  const pointer = (type: string, clientX: number) =>
    card.querySelector(".task-card-summary")?.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX, clientY: 10 }));

  await act(async () => {
    pointer("pointerdown", 100);
    pointer("pointermove", 120);
    pointer("pointerup", 120);
  });
  assert.deepEqual(view.acts, [], "a short drag keeps the card");

  await act(async () => {
    pointer("pointerdown", 100);
    pointer("pointermove", 110);
    pointer("pointermove", 400);
    pointer("pointerup", 400);
  });
  assert.match(card.getAttribute("style") || "", /translateX\(calc\(1 \* \(100% \+ 2\.5rem\)\)\)/, "it floats out to the side it was dragged");
  await floatedOut();
  assert.deepEqual(view.acts, [["/api/suggestions/dismiss", { id: "a1" }]]);
  await view.done();
});

test("a dismiss that fails brings the card back with the error", async () => {
  const view = await render({
    act: async () => {
      throw new Error("The host is not reachable");
    },
  });
  await act(async () => click(view.button("Dismiss suggestion: Fix the stale badge")));
  await floatedOut();
  assert.equal(view.container.querySelector(".task-card")?.getAttribute("data-swipe"), "rest");
  assert.equal(view.container.querySelector("[role=alert]")?.textContent, "The host is not reachable");
  await view.done();
});

test("Create ticket files it on the board, unlinked from this chat, then removes the card", async () => {
  const view = await render({ board: "/repo" });
  await act(async () => click(view.button("Create ticket")));
  assert.deepEqual(view.calls, [["/api/board/tasks", { cwd: "/repo", title: "Fix the stale badge", description: ticketDescription(suggestion) }]]);
  await floatedOut();
  assert.deepEqual(view.acts, [["/api/suggestions/dismiss", { id: "a1" }]]);
  await view.done();
});

test("a ticket that is filed is not offered again when the card cannot go", async () => {
  const view = await render({
    board: "/repo",
    act: async () => {
      throw new Error("The host is not reachable");
    },
  });
  await act(async () => click(view.button("Create ticket")));
  await floatedOut();
  assert.equal(view.calls.length, 1);
  assert.match(view.container.querySelector("[role=alert]")?.textContent ?? "", /^The ticket is on the board, but the card could not go/);
  assert.deepEqual(view.labels().slice(1), ["Start in worktree", "More ways to start", "Dismiss suggestion: Fix the stale badge"], "no second Create ticket");
  await view.done();
});

test("the card shows the prompt a start sends, two lines until clicked", async () => {
  const view = await render({});
  const prompt = view.button("Prompt Point the badge in README.md at the new workflow.");
  assert.equal(prompt.getAttribute("aria-expanded"), "false");
  await act(async () => click(prompt));
  assert.equal(prompt.getAttribute("aria-expanded"), "true");
  assert.ok(prompt.classList.contains("open"));
  await view.done();
});

test("a card that is starting stays drawn after the host drops it, and the others stay usable", async () => {
  const other = { ...suggestion, id: "b2", title: "Other task", prompt: "Other prompt." };
  const started = Promise.withResolvers<void>();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const props = (list: TaskSuggestion[]) =>
    createElement(TaskCards, { suggestions: list, board: null, call: async () => ({}), act: async () => ({}), onStart: () => started.promise });
  await act(async () => root.render(props([suggestion, other])));
  await act(async () => click(view_button(container, "2 suggested tasks · Show all")));
  const startFirst = [...container.querySelectorAll("button")].filter((button) => button.textContent === "Start in worktree")[0];
  assert.ok(startFirst);
  await act(async () => click(startFirst));
  // The host drops the suggestion as soon as its chat runs, before the start answers.
  await act(async () => root.render(props([other])));
  const titles = [...container.querySelectorAll(".task-card-title")].map((item) => item.textContent);
  assert.deepEqual(titles, ["Fix the stale badge", "Other task"], "the starting card is still drawn in its place");
  const dismissOther = view_button(container, "Dismiss suggestion: Other task");
  assert.equal(dismissOther.hasAttribute("disabled"), false, "a start on one card leaves the others usable");
  started.resolve();
  await floatedOut();
  await act(async () => root.render(props([other])));
  assert.deepEqual([...container.querySelectorAll(".task-card-title")].map((item) => item.textContent), ["Other task"]);
  await act(async () => root.unmount());
  container.remove();
});

test("withKept puts a card on its way out back where it was", () => {
  const a = { id: "a" };
  const b = { id: "b" };
  const c = { id: "c" };
  assert.deepEqual(withKept([a, c], [a, b, c], (id) => id === "b"), [a, b, c]);
  assert.deepEqual(withKept([a, c], [a, b, c], () => false), [a, c]);
  assert.deepEqual(withKept([], [a], (id) => id === "a"), [a]);
});

test("a ticket the board refuses keeps the card and says why", async () => {
  const view = await render({
    board: "/repo",
    call: async () => {
      throw new Error("SAK is not reachable");
    },
  });
  await act(async () => click(view.button("Create ticket")));
  assert.equal(view.container.querySelector("[role=alert]")?.textContent, "SAK is not reachable");
  assert.deepEqual(view.acts, []);
  await view.done();
});
