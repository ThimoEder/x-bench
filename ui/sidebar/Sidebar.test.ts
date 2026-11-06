import { after, test } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import type { ProviderUsage, RoutinesView, SidebarFolder, SidebarSession } from "../../server/snapshot.ts";
import type { UpdateState } from "../updater/UpdateCard.tsx";
import { click, installDom, press, typeInto } from "../testing/dom.ts";

// react-dom checks for a DOM when it loads, so it comes in after installDom.
const dom = installDom();
const { createRoot } = await import("react-dom/client");
const { Sidebar, providerTrail } = await import("./Sidebar.tsx");
const { SIDEBAR_PROVIDER_KEY, readSidebarProvider } = await import("./sidebarProvider.ts");

after(async () => {
  await dom.happyDOM.abort();
  dom.close();
});

const row = (id: string, title: string, extra: Partial<SidebarSession> = {}): SidebarSession => ({
  id,
  cwd: "/work/app",
  title,
  updatedAt: "2026-10-01T09:00:00Z",
  ...extra,
});

async function render(sessions: SidebarSession[], usage: ProviderUsage[] = [], folders?: SidebarFolder[], phone = false) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const calls: [string, unknown][] = [];
  const props = {
    busy: false,
    onNew() {},
    onOpen() {},
    onCollapse() {},
    showArchived: false,
    open: true,
    width: 280,
    phone,
    call: async (path: string, body?: unknown) => {
      calls.push([path, body]);
      return {};
    },
  };
  const draw = (list: SidebarSession[], meters = usage) =>
    act(async () =>
      root.render(
        createElement(Sidebar, {
          ...props,
          snapshot: {
            open: [],
            tickets: { boards: [], bySession: {} },
            working: [],
            attention: [],
            unread: [],
            projects: [{ cwd: "/work/app", name: "app", sessions: list, ...(folders ? { folders } : {}) }],
            chats: [],
            surface: "builder",
            usage: meters,
          },
        }),
      ),
    );
  await draw(sessions);
  const rowOf = (title: string) => {
    const found = [...container.querySelectorAll<HTMLElement>(".session-row")].find((item) => item.querySelector(".session-link")?.getAttribute("title") === title);
    assert.ok(found, `no row ${title}`);
    return found;
  };
  const menu = () => document.body.querySelector<HTMLElement>(".session-menu.is-floating");
  const items = () => [...(menu()?.querySelectorAll("button") ?? [])].map((button) => button.textContent);
  const item = (label: string) => {
    const found = [...(menu()?.querySelectorAll("button") ?? [])].find((button) => button.textContent === label);
    assert.ok(found, `no ${label} in the menu`);
    return found;
  };
  const rightClick = (title: string, x = 40, y = 50) =>
    act(async () => {
      rowOf(title).querySelector(".session-link")?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y }));
    });
  return {
    calls,
    draw,
    rowOf,
    menu,
    items,
    item,
    rightClick,
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("right-clicking a thread opens its menu at the pointer, and Pin to top pins it", async () => {
  const view = await render([row("a", "Alpha"), row("b", "Beta")]);
  try {
    assert.equal(view.menu(), null);
    await view.rightClick("Beta", 40, 50);
    assert.deepEqual(view.items(), ["Rename", "Pin to top", "Move to folder…", "Copy session id", "Archive", "Delete"]);
    assert.equal(view.menu()?.style.left, "40px");
    assert.equal(view.menu()?.style.top, "50px");
    assert.equal(view.rowOf("Beta").querySelector(".session-more")?.getAttribute("aria-expanded"), "true");

    await act(async () => click(view.item("Pin to top")));
    assert.deepEqual(view.calls, [["/api/pin", { sessionId: "b", pinned: true }]]);
    assert.equal(view.menu(), null);
  } finally {
    await view.unmount();
  }
});

test("deleting the only chat in an app worktree offers to delete the worktree too", async () => {
  const view = await render([row("a", "Alpha", { ownWorktree: true }), row("b", "Beta")]);
  try {
    await view.rightClick("Beta");
    await act(async () => click(view.item("Delete")));
    assert.deepEqual(view.items().slice(-1), ["Delete this chat"]);

    await view.rightClick("Alpha");
    await act(async () => click(view.item("Delete")));
    assert.deepEqual(view.items().slice(-2), ["Delete this chat", "Delete the worktree too"]);
    await act(async () => click(view.item("Delete the worktree too")));
    assert.deepEqual(view.calls, [["/api/delete", { sessionId: "a", worktree: true }]]);
  } finally {
    await view.unmount();
  }
});

test("archiving the only chat in an app worktree asks first and offers to delete the worktree too", async () => {
  const view = await render([row("a", "Alpha", { ownWorktree: true }), row("b", "Beta")]);
  try {
    await view.rightClick("Alpha");
    await act(async () => click(view.item("Archive")));
    assert.deepEqual(view.calls, []);
    assert.deepEqual(view.items().slice(4, 6), ["Archive this chat", "Delete the worktree too"]);
    await act(async () => click(view.item("Delete the worktree too")));
    assert.deepEqual(view.calls, [["/api/archive", { sessionId: "a", worktree: true }]]);
    assert.equal(view.menu(), null);

    await view.rightClick("Beta");
    await act(async () => click(view.item("Archive")));
    assert.deepEqual(view.calls.at(-1), ["/api/archive", { sessionId: "b" }]);
  } finally {
    await view.unmount();
  }
});

test("a folder sits where its latest chat would, folds, and the chat menu moves a chat into a folder", async () => {
  const folders = [{ id: "f1", name: "Auth", collapsed: false }, { id: "f2", name: "Empty", collapsed: false }];
  const view = await render([row("b", "Beta"), row("a", "Alpha", { folder: "f1" }), row("c", "Gamma")], [], folders);
  try {
    const folder = () => document.body.querySelector<HTMLElement>(".folder");
    assert.equal(folder()?.querySelector(".folder-row")?.textContent, "Auth1");
    assert.ok(folder()?.contains(view.rowOf("Alpha")));
    assert.equal(folder()?.contains(view.rowOf("Beta")), false);
    const tops = [...document.querySelectorAll(".project-chats-body > ul > li")].map((item) => item.querySelector(".session-link")?.textContent);
    assert.deepEqual(tops, ["Beta", "Auth1", "Gamma", "Empty0"], "chats newest first, each folder at its latest chat, empty folders last");

    await act(async () => click(folder()?.querySelector(".folder-row") as HTMLElement));
    assert.deepEqual(view.calls.at(-1), ["/api/folders/collapsed", { folderId: "f1", collapsed: true }]);
    assert.equal(folder()?.querySelector(".folder-chats"), null, "a folded folder hides its chats");

    await view.rightClick("Beta");
    await act(async () => click(view.item("Move to folder…")));
    assert.deepEqual(view.items(), ["Auth", "Empty", "New folder…"]);
    await act(async () => click(view.item("Auth")));
    assert.deepEqual(view.calls.at(-1), ["/api/folders/move", { sessionIds: ["b"], folderId: "f1" }]);
    assert.equal(view.menu(), null);

    await view.rightClick("Beta");
    await act(async () => click(view.item("Move to folder…")));
    await act(async () => click(view.item("New folder…")));
    const field = view.menu()?.querySelector("input");
    assert.ok(field);
    await act(async () => typeInto(field, "Docs"));
    await act(async () => field.form?.requestSubmit());
    assert.deepEqual(view.calls.at(-1), ["/api/folders/create", { cwd: "/work/app", name: "Docs", sessionIds: ["b"] }]);
  } finally {
    await view.unmount();
  }
});

test("Escape on a later page of the chat menu returns focus to the … button", async () => {
  const view = await render([row("a", "Alpha")], [], [{ id: "f1", name: "Auth", collapsed: false }]);
  try {
    const more = view.rowOf("Alpha").querySelector(".session-more") as HTMLElement;
    more.focus();
    await act(async () => click(more));
    await act(async () => click(view.item("Move to folder…")));
    assert.equal(document.activeElement?.textContent, "Auth", "the new page's first item takes focus");
    await act(async () => click(view.item("New folder…")));
    await act(async () => press(document.activeElement as Element, "Escape"));
    assert.equal(view.menu(), null);
    assert.equal(document.activeElement, more);
  } finally {
    await view.unmount();
  }
});

test("a chat in a folder can leave it, and the folder's menu renames and removes it", async () => {
  const folders = [{ id: "f1", name: "Auth", collapsed: false }];
  const view = await render([row("a", "Alpha", { folder: "f1" })], [], folders);
  try {
    await view.rightClick("Alpha");
    await act(async () => click(view.item("Remove from folder")));
    assert.deepEqual(view.calls.at(-1), ["/api/folders/move", { sessionIds: ["a"], folderId: null }]);

    const head = document.body.querySelector(".folder-head") as HTMLElement;
    await act(async () => click(head.querySelector(".session-more") as HTMLElement));
    assert.deepEqual(view.items(), ["Rename folder", "Remove folder"]);
    await act(async () => click(view.item("Remove folder")));
    assert.deepEqual(view.calls.at(-1), ["/api/folders/remove", { folderId: "f1" }]);

    await act(async () => head.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 30, clientY: 30 })));
    await act(async () => click(view.item("Rename folder")));
    const field = view.menu()?.querySelector("input");
    assert.ok(field);
    await act(async () => typeInto(field, "Login"));
    await act(async () => field.form?.requestSubmit());
    assert.deepEqual(view.calls.at(-1), ["/api/folders/rename", { folderId: "f1", name: "Login" }]);
  } finally {
    await view.unmount();
  }
});

test("a pinned thread shows its pin, and its menu unpins it", async () => {
  const view = await render([row("b", "Beta", { pinned: true }), row("a", "Alpha")]);
  try {
    assert.ok(view.rowOf("Beta").querySelector('[aria-label="Pinned"]'));
    assert.equal(view.rowOf("Alpha").querySelector('[aria-label="Pinned"]'), null);

    await act(async () => click(view.rowOf("Beta").querySelector(".session-more") as HTMLElement));
    assert.equal(view.items()[1], "Unpin");
    await act(async () => click(view.item("Unpin")));
    assert.deepEqual(view.calls, [["/api/pin", { sessionId: "b", pinned: false }]]);
  } finally {
    await view.unmount();
  }
});

test("the chat menu closes on Escape and when its thread leaves the sidebar", async () => {
  const view = await render([row("a", "Alpha"), row("b", "Beta")]);
  try {
    await view.rightClick("Alpha");
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    assert.equal(view.menu(), null);

    await view.rightClick("Alpha");
    assert.ok(view.menu());
    await view.draw([row("b", "Beta")]);
    assert.equal(view.menu(), null);
  } finally {
    await view.unmount();
  }
});

test("the … button moves focus into the menu, arrows walk it, and Escape returns focus", async () => {
  const view = await render([row("a", "Alpha"), row("b", "Beta")]);
  try {
    const more = view.rowOf("Alpha").querySelector<HTMLElement>(".session-more");
    assert.ok(more);
    more.focus();
    await act(async () => click(more));
    assert.equal(document.activeElement?.textContent, "Rename");
    await act(async () => press(document.activeElement as Element, "ArrowDown"));
    assert.equal(document.activeElement?.textContent, "Pin to top");
    await act(async () => press(document.activeElement as Element, "ArrowUp"));
    await act(async () => press(document.activeElement as Element, "ArrowUp"));
    assert.equal(document.activeElement?.textContent, "Delete");
    await act(async () => press(document.activeElement as Element, "Escape"));
    assert.equal(view.menu(), null);
    assert.equal(document.activeElement, more);

    await act(async () => click(more));
    await act(async () => press(document.activeElement as Element, "Tab"));
    assert.equal(view.menu(), null);
    assert.equal(document.activeElement, more);
  } finally {
    await view.unmount();
  }
});

test("collapsing the project closes a thread's menu", async () => {
  const view = await render([row("a", "Alpha"), row("b", "Beta")]);
  try {
    await view.rightClick("Beta");
    assert.ok(view.menu());
    const toggle = document.querySelector<HTMLElement>('[aria-label="Minimize app"]');
    assert.ok(toggle);
    await act(async () => click(toggle));
    assert.equal(view.menu(), null);
    await act(async () => click(toggle));
    assert.equal(view.menu(), null, "expanding again leaves it closed");
  } finally {
    await view.unmount();
  }
});

test("a long project shows ten chats, each click shows ten more, and reopening starts at ten again", async () => {
  const view = await render(Array.from({ length: 25 }, (_, index) => row(`s${index}`, `Chat ${index}`)));
  const shown = () => [...document.querySelectorAll<HTMLElement>(".session-row")].filter((item) => !item.closest("[inert]")).length;
  const more = () => [...document.querySelectorAll<HTMLElement>(".preview-expand")].find((button) => !button.closest("[inert]") && !button.classList.contains("is-open"));
  try {
    assert.equal(shown(), 10);
    assert.equal(more()?.getAttribute("aria-label"), "Show 10 more chats");
    await act(async () => click(more()!));
    assert.equal(shown(), 20);
    assert.equal(more()?.getAttribute("aria-label"), "Show 5 more chats");
    await act(async () => click(more()!));
    assert.equal(shown(), 25);
    assert.equal(more(), undefined);

    const toggle = document.querySelector<HTMLElement>('[aria-label="Minimize app"]');
    assert.ok(toggle);
    await act(async () => click(toggle));
    await act(async () => click(toggle));
    assert.equal(shown(), 10);
    assert.equal(more()?.getAttribute("aria-label"), "Show 10 more chats");
  } finally {
    await view.unmount();
  }
});

test("a chat's menu keeps its page and the name typed into it when a newer chat moves its row onto the next page", async () => {
  const chats = Array.from({ length: 11 }, (_, index) => row(`s${index}`, `Chat ${index}`));
  const view = await render(chats);
  const field = () => view.menu()?.querySelector("input");
  try {
    await act(async () => click(document.querySelector<HTMLElement>(".preview-expand")!));
    await view.rightClick("Chat 9");
    await act(async () => click(view.item("Move to folder…")));
    await act(async () => typeInto(field()!, "Docs"));
    await view.draw([row("n", "Newest"), ...chats]);
    assert.equal(field()?.value, "Docs");
  } finally {
    await view.unmount();
  }
});

test("a folder shows five chats and reveals five more, and a folder counts as one row of the project's ten", async () => {
  const folders = [{ id: "f1", name: "Auth", collapsed: false }];
  const inFolder = Array.from({ length: 7 }, (_, index) => row(`f${index}`, `Folded ${index}`, { folder: "f1" }));
  const loose = Array.from({ length: 10 }, (_, index) => row(`s${index}`, `Chat ${index}`));
  const view = await render([...inFolder, ...loose], [], folders);
  const shown = (scope: ParentNode = document) => [...scope.querySelectorAll<HTMLElement>(".session-row:not(.folder-head)")].filter((item) => !item.closest("[inert]")).length;
  const more = () => [...document.querySelectorAll<HTMLElement>(".preview-expand")].filter((button) => !button.closest("[inert]") && !button.classList.contains("is-open"));
  try {
    const folder = document.querySelector<HTMLElement>(".folder")!;
    assert.equal(shown(folder), 5);
    assert.equal(shown(), 5 + 9, "the folder and nine chats fill the first ten rows");
    assert.deepEqual(more().map((button) => button.getAttribute("aria-label")), ["Show 2 more chats", "Show 1 more chat"]);
    await act(async () => click(more()[0]!));
    assert.equal(shown(folder), 7);
    await act(async () => click(folder.querySelector(".folder-row") as HTMLElement));
    await act(async () => click(folder.querySelector(".folder-row") as HTMLElement));
    assert.equal(shown(folder), 5, "folding a folder starts it at five again");
  } finally {
    await view.unmount();
  }
});

test("an open empty folder that ends the first page carries the project's Show more", async () => {
  const folders = [{ id: "e1", name: "First", collapsed: false }, { id: "e2", name: "Second", collapsed: false }];
  const view = await render(Array.from({ length: 9 }, (_, index) => row(`s${index}`, `Chat ${index}`)), [], folders);
  try {
    const head = document.querySelector<HTMLElement>(".folder-head")!;
    assert.equal(head.querySelector(".folder-row")?.textContent, "First0");
    assert.equal(head.querySelector(".preview-expand")?.getAttribute("aria-label"), "Show 1 more chat");
  } finally {
    await view.unmount();
  }
});

test("a folder's menu closes when a newer chat pushes the folder onto a folded page", async () => {
  const folders = [{ id: "f1", name: "Auth", collapsed: false }];
  const loose = Array.from({ length: 9 }, (_, index) => row(`s${index}`, `Chat ${index}`));
  const view = await render([...loose, row("a", "Alpha", { folder: "f1" })], [], folders);
  try {
    await act(async () => click(document.querySelector<HTMLElement>(".folder-head .session-more")!));
    assert.deepEqual(view.items(), ["Rename folder", "Remove folder"]);
    await view.draw([row("n", "Newest"), ...loose, row("a", "Alpha", { folder: "f1" })]);
    assert.equal(view.menu(), null);
  } finally {
    await view.unmount();
  }
});

test("each usage meter shows its provider's mark and names the provider once", async () => {
  const later = new Date(Date.now() + 3600_000).toISOString();
  const view = await render([], [
    { provider: "grok", label: "Grok", percent: 28, period: "weekly", resetsAt: null, tier: "SuperGrok" },
    {
      provider: "claude",
      label: "Claude",
      percent: 92,
      period: "five-hour",
      resetsAt: later,
      tier: "Claude Max",
      windows: [
        { period: "five-hour", percent: 92, resetsAt: later },
        { period: "weekly", percent: 64, resetsAt: "2026-01-01T00:00:00Z" },
      ],
    },
    { provider: "chatgpt", label: "ChatGPT", percent: 92, period: "five-hour", resetsAt: later, tier: "ChatGPT Plus" },
    { provider: "other", label: "Other", percent: 5, period: "", resetsAt: null, tier: "" },
  ]);
  try {
    const meters = [...document.querySelectorAll<HTMLElement>("[data-testid=account-usage]")];
    const labels = meters.map((meter) => meter.getAttribute("aria-label") ?? "");
    assert.equal(labels[0], "Grok · SuperGrok. 28% of weekly usage");
    assert.match(labels[1] ?? "", /^Claude Max\. 92% of 5-hour usage, next reset \S.*\. 64% of weekly usage$/);
    assert.match(labels[2] ?? "", /^ChatGPT Plus\. 92% of 5-hour usage\. Next reset \S/);
    assert.equal(labels[3], "Other. 5% of plan usage");
    assert.deepEqual(meters.map((meter) => meter.querySelector(".brand-pct")?.textContent), ["28%", "92%", "92%", "5%"]);
    const marks = meters.map((meter) => meter.querySelector(".provider-mark path")?.getAttribute("d") ?? meter.querySelector(".provider-mark circle")?.tagName.toLowerCase());
    assert.equal(new Set(marks.slice(0, 3)).size, 3);
    assert.equal(marks[3], "circle");
    assert.deepEqual(meters.map((meter) => meter.dataset.level ?? ""), ["", "high", "high", ""]);
    assert.equal(document.querySelectorAll(".sidebar-usage").length, 1);

    // A plan with two windows lists both in the card. A reset that has passed is left out.
    const rows = [...(meters[1]?.parentElement?.querySelectorAll(".usage-window") ?? [])].map((row) => [...row.querySelectorAll("span")].map((cell) => cell.textContent));
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0]?.slice(0, 2), ["5-hour", "92%"]);
    assert.notEqual(rows[0]?.[2], "");
    assert.deepEqual(rows[1], ["Weekly", "64%", ""]);
    assert.equal(meters[1]?.parentElement?.querySelector(".usage-window")?.getAttribute("data-level"), "high");
    assert.equal(meters[1]?.parentElement?.querySelector(".usage-line"), null);
  } finally {
    await view.unmount();
  }
});

test("a meter that leaves is dropped from the row, the others keep their order, and it can come back", async () => {
  const meter = (provider: string, label: string, percent: number): ProviderUsage => ({ provider, label, percent, period: "weekly", resetsAt: null, tier: "" });
  const three = [meter("grok", "Grok", 5), meter("claude", "Claude", 49), meter("chatgpt", "ChatGPT", 38)];
  const view = await render([], three);
  const shown = () => [...document.querySelectorAll<HTMLElement>("[data-testid=account-usage]")].map((button) => button.querySelector(".brand-pct")?.textContent);
  try {
    assert.deepEqual(shown(), ["5%", "49%", "38%"]);
    await view.draw([], [three[0]!, three[2]!]);
    assert.deepEqual(shown(), ["5%", "38%"]);
    await view.draw([], [three[0]!, meter("claude", "Claude", 52), three[2]!]);
    assert.deepEqual(shown(), ["5%", "52%", "38%"]);
    assert.equal(document.querySelectorAll("[data-leaving]").length, 0);
  } finally {
    await view.unmount();
  }
});

test("a switched chat's logo names every provider it ran on, in order", () => {
  const providers = [
    { id: "grok", label: "Grok" },
    { id: "claude", label: "Claude" },
  ];
  assert.equal(providerTrail({ provider: "claude", earlierProviders: ["grok"] }, providers), "Grok, then Claude");
  assert.equal(providerTrail({ provider: "claude", earlierProviders: ["claude", "grok"] }, providers), "Claude, then Grok, then Claude");
  assert.equal(providerTrail({ provider: "grok" }, providers), "Grok");
});

test("the sidebar shows a row's provider as its logo, its name, or not at all, as Settings picks", async () => {
  const rows = [row("a", "Fix the flash", { provider: "claude", earlierProviders: ["grok"] })];
  const tag = () => document.querySelector<HTMLElement>("[data-testid=provider-tag]");
  for (const [choice, check] of [
    ["icon", () => assert.ok(tag()?.querySelector(".provider-mark"))],
    ["label", () => assert.equal(tag()?.textContent, "claude")],
    ["none", () => assert.equal(tag(), null)],
  ] as const) {
    localStorage.setItem(SIDEBAR_PROVIDER_KEY, choice);
    const view = await render(rows);
    try {
      check();
      if (choice !== "none") assert.equal(tag()?.getAttribute("title"), "grok, then claude");
    } finally {
      await view.unmount();
    }
  }
  localStorage.removeItem(SIDEBAR_PROVIDER_KEY);
  assert.equal(readSidebarProvider(), "icon");
});

test("a sidebar choice holds for the visit when storage refuses to keep it", async () => {
  const { useSidebarProvider } = await import("./sidebarProvider.ts");
  const seen: string[] = [];
  const handle: { choose?: (next: "icon" | "label" | "none") => void } = {};
  function Probe() {
    const [choice, pick] = useSidebarProvider();
    seen.push(choice);
    handle.choose = pick;
    return null;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  // A storage that keeps nothing, as a full one does.
  const real = globalThis.localStorage;
  const full = { getItem: () => null, setItem: () => {
    throw new Error("quota exceeded");
  } };
  Object.defineProperty(globalThis, "localStorage", { value: full, configurable: true });
  try {
    await act(async () => root.render(createElement(Probe)));
    await act(async () => handle.choose?.("none"));
    assert.equal(seen.at(-1), "none");
  } finally {
    Object.defineProperty(globalThis, "localStorage", { value: real, configurable: true });
    await act(async () => root.unmount());
    await act(async () => handle.choose?.("icon"));
  }
});

test("⌘F turns New session into the search field, which filters threads by title past the first page, and Escape turns it back", async () => {
  const filler = Array.from({ length: 11 }, (_, index) => row(`f${index}`, `Filler ${index}`));
  const view = await render([row("a", "Fix the Dock flake"), ...filler, row("z", "Remember dock places")]);
  const field = () => document.body.querySelector<HTMLInputElement>('[data-testid="sidebar-search"]')!;
  const searching = () => Boolean(document.body.querySelector(".sidebar-new-row.is-searching"));
  const titles = () => [...document.body.querySelectorAll(".session-link")].map((link) => link.getAttribute("title"));
  try {
    assert.equal(searching(), false);
    await act(async () => press(document.body, "f", { metaKey: true }));
    assert.equal(searching(), true);
    assert.equal(document.activeElement, field());

    await act(async () => typeInto(field(), "DOCK"));
    assert.deepEqual(titles(), ["Fix the Dock flake", "Remember dock places"]);
    assert.deepEqual([...view.rowOf("Fix the Dock flake").querySelectorAll("mark")].map((mark) => mark.textContent), ["Dock"]);

    await act(async () => typeInto(field(), "nothing"));
    assert.deepEqual(titles(), []);
    assert.ok(document.body.textContent?.includes("No sessions match."));

    await act(async () => press(field(), "Escape"));
    assert.equal(searching(), false);
    assert.equal(field().value, "");
    assert.equal(titles().length, 13);

    await act(async () => click(document.querySelector<HTMLElement>('[data-testid="sidebar-search-open"]')!));
    assert.equal(document.activeElement, field());
  } finally {
    await view.unmount();
  }
});

test("a search shows every match without Show more, marks the match in the title as written, and Escape on a result closes it", async () => {
  const docks = Array.from({ length: 12 }, (_, index) => row(`d${index}`, `Dock ${index}`));
  const view = await render([row("i", "İstanbul Dock"), ...docks]);
  const field = () => document.body.querySelector<HTMLInputElement>('[data-testid="sidebar-search"]')!;
  try {
    await act(async () => click(document.querySelector<HTMLElement>('[data-testid="sidebar-search-open"]')!));
    await act(async () => typeInto(field(), "dock"));
    assert.equal(document.body.querySelectorAll(".session-link").length, 13);
    assert.equal(document.body.querySelector(".preview-expand"), null);
    assert.deepEqual([...view.rowOf("İstanbul Dock").querySelectorAll("mark")].map((mark) => mark.textContent), ["Dock"]);

    await act(async () => press(view.rowOf("Dock 3").querySelector(".session-link")!, "Escape"));
    assert.equal(document.body.querySelector(".sidebar-new-row.is-searching"), null);
    assert.equal(field().value, "");
  } finally {
    await view.unmount();
  }
});

test("the gear menu offers Check for updates only in the desktop app, and it opens the update card", async () => {
  const gear = () => act(async () => document.body.querySelector<HTMLElement>("[data-testid=open-setup]")?.click());
  const gearItems = () => [...document.body.querySelectorAll("[data-testid=options-menu] button")].map((button) => button.textContent);
  const plain = await render([]);
  await gear();
  assert.deepEqual(gearItems(), ["Show archived threads", "Settings"]);
  await plain.unmount();

  const calls: string[] = [];
  Reflect.set(window, "xBenchDesktop", {
    updateCheck: () => calls.push("check"),
    updateInstall() {},
    updateRestart() {},
    onUpdate: () => () => {},
  });
  try {
    const desktop = await render([]);
    await gear();
    assert.deepEqual(gearItems(), ["Show archived threads", "Check for updates…", "Settings"]);
    await act(async () => document.body.querySelector<HTMLElement>("[data-testid=options-updates]")?.click());
    assert.equal(document.body.querySelector("[data-testid=options-menu]"), null);
    assert.deepEqual(calls, ["check"]);
    await desktop.unmount();
  } finally {
    Reflect.deleteProperty(window, "xBenchDesktop");
  }
});

test("an update the app found puts a dot on the gear and offers its version in the menu", async () => {
  const listeners = new Set<(state: UpdateState) => void>();
  let latest: UpdateState = { phase: "idle", version: "0.9.3" };
  // Like the preload, a new listener hears the state as it is.
  Reflect.set(window, "xBenchDesktop", {
    updateCheck() {},
    updateInstall() {},
    updateRestart() {},
    onUpdate(listener: (state: UpdateState) => void) {
      listeners.add(listener);
      listener(latest);
      return () => listeners.delete(listener);
    },
  });
  const send = (state: UpdateState) => act(async () => listeners.forEach((listener) => listener((latest = state))));
  const gearButton = () => document.body.querySelector<HTMLElement>("[data-testid=open-setup]")!;
  try {
    const view = await render([]);
    assert.equal(gearButton().classList.contains("has-update"), false);

    await send({ phase: "available", version: "0.9.3", release: { version: "0.9.4", size: 38e6, notes: [] } });
    assert.equal(gearButton().classList.contains("has-update"), true);
    assert.equal(gearButton().getAttribute("aria-label"), "Options, X Bench 0.9.4 is available");
    await act(async () => gearButton().click());
    assert.equal(document.body.querySelector("[data-testid=options-updates]")?.textContent, "Update to 0.9.4");

    await act(async () => document.body.querySelector<HTMLElement>("[data-testid=options-updates]")?.click());
    assert.equal(document.body.querySelector("[data-testid=update-card]")?.getAttribute("data-phase"), "available");

    await send({ phase: "current", version: "0.9.4" });
    assert.equal(gearButton().classList.contains("has-update"), false);
    await view.unmount();
  } finally {
    Reflect.deleteProperty(window, "xBenchDesktop");
  }
});

test("on a phone the switch sits in the footer, and the gear's menu shows the usage with a tile's windows on a tap", async () => {
  const later = new Date(Date.now() + 3600_000).toISOString();
  const view = await render([], [
    { provider: "grok", label: "Grok", percent: 28, period: "weekly", resetsAt: null, tier: "SuperGrok" },
    {
      provider: "claude",
      label: "Claude",
      percent: 92,
      period: "five-hour",
      resetsAt: later,
      tier: "Claude Max",
      windows: [
        { period: "five-hour", percent: 92, resetsAt: later },
        { period: "weekly", percent: 64, resetsAt: later },
      ],
    },
  ], undefined, true);
  try {
    assert.ok(document.querySelector(".sidebar-foot .surface-switch"));
    assert.equal(document.querySelector(".brand .surface-switch"), null);
    assert.equal(document.querySelector("[data-testid=account-usage]"), null);
    await act(async () => document.body.querySelector<HTMLElement>("[data-testid=open-setup]")?.click());
    const tiles = [...document.querySelectorAll<HTMLElement>(".gear-usage-item")];
    assert.deepEqual(tiles.map((tile) => tile.textContent), ["Grok28%", "Claude92%"]);
    const more = () => document.querySelector(".gear-usage-more");
    assert.equal(more()?.hasAttribute("data-open"), false);
    await act(async () => tiles[1]?.click());
    assert.equal(tiles[1]?.getAttribute("aria-expanded"), "true");
    assert.equal(more()?.hasAttribute("data-open"), true);
    assert.deepEqual([...document.querySelectorAll(".gear-usage .usage-window span:first-child")].map((cell) => cell.textContent), ["5-hour", "Weekly"]);
    await act(async () => tiles[1]?.click());
    assert.equal(tiles[1]?.getAttribute("aria-expanded"), "false");
    assert.equal(more()?.hasAttribute("data-open"), false);
  } finally {
    await view.unmount();
  }
});

test("a packaged copy shows its own name in place of the wordmark", async () => {
  const plain = await render([]);
  assert.ok(document.body.querySelector(".brand-mark"));
  assert.equal(document.body.querySelector(".brand-copy-name"), null);
  await plain.unmount();

  Reflect.set(window, "xBenchDesktop", { appName: " Work Bench " });
  try {
    const copy = await render([]);
    assert.equal(document.body.querySelector(".brand-copy-name")?.textContent, "Work Bench");
    assert.equal(document.body.querySelector(".brand-mark"), null);
    await copy.unmount();
  } finally {
    Reflect.deleteProperty(window, "xBenchDesktop");
  }
});

test("the Routines dot clears once the page is open and comes back only for a run that ends after", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const routines = (ids: string[]) => ({ list: [{ runs: ids.map((sessionId) => ({ sessionId, state: "done" })) }] }) as unknown as RoutinesView;
  const draw = (unread: string[], routinesOpen: boolean) =>
    act(async () =>
      root.render(
        createElement(Sidebar, {
          busy: false,
          onNew() {},
          onOpen() {},
          onCollapse() {},
          onOpenRoutines() {},
          routinesOpen,
          showArchived: false,
          open: true,
          width: 280,
          call: async () => ({}),
          snapshot: { open: [], tickets: { boards: [], bySession: {} }, working: [], attention: [], unread, projects: [], chats: [], surface: "builder", usage: [], routines: routines(["r1", "r2"]) },
        }),
      ),
    );
  const dot = () => container.querySelector(".routine-unread");
  try {
    await draw(["r1"], false);
    assert.ok(dot());
    await draw(["r1"], true);
    assert.equal(dot(), null);
    await draw(["r1"], false);
    assert.equal(dot(), null);
    await draw(["r1", "r2"], false);
    assert.ok(dot());
    await draw(["r1", "r2"], true);
    await draw(["r1", "r2"], false);
    assert.equal(dot(), null);
    await draw(["r2"], false);
    assert.equal(dot(), null);
    await draw(["r1", "r2"], false);
    assert.ok(dot(), "a seen run that runs again and ends brings the dot back");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
