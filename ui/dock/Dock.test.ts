import { after, test } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import type { OpenSession } from "../../server/snapshot.ts";
import type { DockProps } from "./Dock.tsx";
import { click, installDom, wait } from "../testing/dom.ts";

// react-dom checks for a DOM when it loads, so it comes in after installDom.
const dom = installDom();
// The Device tab sizes its bezel with a ResizeObserver, which happy-dom does not have.
Object.defineProperty(globalThis, "ResizeObserver", {
  value: class {
    observe() {}
    disconnect() {}
  },
  configurable: true,
  writable: true,
});
// The diff stack builds a file's rows once it nears the view, which happy-dom cannot tell. Here every file is near.
Object.defineProperty(globalThis, "IntersectionObserver", {
  value: class {
    report: (entries: { target: Element; isIntersecting: boolean }[]) => void;
    constructor(report: (entries: { target: Element; isIntersecting: boolean }[]) => void) {
      this.report = report;
    }
    observe(target: Element) {
      this.report([{ target, isIntersecting: true }]);
    }
    disconnect() {}
  },
  configurable: true,
  writable: true,
});
const { createRoot } = await import("react-dom/client");
const { Dock, DockLoading, IdleRail } = await import("./Dock.tsx");
const { dockPlaces } = await import("./dockMemory.ts");

after(async () => {
  await dom.happyDOM.abort();
  dom.close();
});

function session(id: string): OpenSession {
  return {
    id,
    cwd: "/repo",
    status: "idle",
    stopReason: null,
    error: null,
    revision: 0,
    modelId: null,
    reasoningEffort: null,
    configOptions: [],
    commands: [],
    plan: null,
    planDoc: null,
    usage: null,
    context: null,
    pendingPermission: null,
    pendingPlan: null,
    pendingQuestion: null,
    mentions: [],
    transcript: [],
    modeId: "full",
    activity: null,
    backgroundTasks: [],
    queue: [],
    suggestion: null,
    title: id,
    provider: "grok",
    suggestions: [],
  };
}

type Call = (path: string, body?: Record<string, unknown>, method?: string, options?: { silent?: boolean }) => Promise<unknown>;

// Answers the dock's reads: a clean git tree with one commit since main, an empty folder, and each file's path as its text.
// Paths in missing fail to read.
function host(missing: string[] = [], reads: { path: unknown; silent: boolean }[] = []) {
  return async (path: string, body?: Record<string, unknown>, _method?: string, options?: { silent?: boolean }) => {
    if (path === "/api/devices") {
      return {
        devices: [
          { id: "phone-1", name: "iPhone 17", platform: "ios", state: "offline" },
          { id: "phone-2", name: "Pixel 9", platform: "android", state: "offline" },
        ],
      };
    }
    if (path === "/api/git") {
      const files = body?.base === "main" ? [{ path: "src/app.ts", type: "edit", additions: 1, deletions: 0 }] : [];
      return { branch: "topic", commit: "abc1234", root: "/repo", files };
    }
    if (path === "/api/file") {
      reads.push({ path: body?.path, silent: Boolean(options?.silent) });
      if (missing.includes(String(body?.path))) throw new Error("No such file");
      return { path: body?.path, content: `text of ${String(body?.path)}` };
    }
    return {};
  };
}

async function mountDock(call: Call, props: Partial<DockProps> = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  async function show(id: string, openedFile: { sessionId: string; path: string; nonce: number } | null = null, reviewNonce = 0, extra: Partial<OpenSession> = {}) {
    await act(async () => {
      root.render(createElement(Dock, { session: { ...session(id), ...extra }, call, open: true, openedFile, reviewNonce, onClose: () => {}, ...props }));
      await wait(20);
    });
  }
  return {
    container,
    show,
    unmount: () => act(() => root.unmount()),
  };
}

// Runs body against a mounted dock and always unmounts it, so a failure leaves no timers behind.
async function withDock(call: Call, body: (dock: Awaited<ReturnType<typeof mountDock>>) => Promise<void>, props: Partial<DockProps> = {}) {
  const dock = await mountDock(call, props);
  try {
    await body(dock);
  } finally {
    await dock.unmount();
  }
}

function selectedTab(container: HTMLElement): string {
  return container.querySelector("[role=tab][aria-selected=true]")?.textContent ?? "";
}

function tab(container: HTMLElement, label: string): HTMLElement {
  const found = [...container.querySelectorAll<HTMLElement>("[role=tab]")].find((item) => item.textContent?.startsWith(label));
  assert.ok(found, `no ${label} tab`);
  return found;
}

test("each chat comes back on the tab and Changes scope it was left on", async () => {
  await withDock(host(), async (dock) => {
    await dock.show("tab-a");
    assert.equal(selectedTab(dock.container), "Changes");
    await act(async () => click(tab(dock.container, "Files")));
    await dock.show("tab-b");
    assert.equal(selectedTab(dock.container), "Changes");
    const branch = dock.container.querySelector<HTMLElement>("[data-testid=git-scope-main]");
    assert.ok(branch, "no Branch scope");
    await act(async () => click(branch));
    await dock.show("tab-a");
    assert.equal(selectedTab(dock.container), "Files");
    await dock.show("tab-b");
    assert.equal(selectedTab(dock.container), "Changes");
    assert.equal(dock.container.querySelector("[data-testid=git-scope-main]")?.getAttribute("aria-pressed"), "true");
    assert.deepEqual(dockPlaces.get("tab-b"), { tab: "changes", scope: "main", change: "src/app.ts" });
  });
});

test("switching back to a scope with no changes clears the other scope's diffs", async () => {
  await withDock(host(), async (dock) => {
    await dock.show("scope-a");
    const diffs = () => [...dock.container.querySelectorAll<HTMLElement>("[data-diff-path]")].map((node) => node.dataset.diffPath);
    await act(async () => {
      click(dock.container.querySelector<HTMLElement>("[data-testid=git-scope-main]")!);
      await wait(20);
    });
    assert.deepEqual(diffs(), ["src/app.ts"]);
    const uncommitted = [...dock.container.querySelectorAll<HTMLElement>("[data-testid=git-scope] button")].find((button) => button.textContent === "Uncommitted");
    assert.ok(uncommitted, "no Uncommitted scope");
    await act(async () => {
      click(uncommitted);
      await wait(20);
    });
    assert.deepEqual(diffs(), []);
    assert.equal(dock.container.querySelector("[data-testid=git-revert]"), null);
    assert.equal(dock.container.querySelector("[data-testid=git-empty]")?.textContent, "No changes");
  });
});

test("the scope switch waits while a revert runs, and the revert names the files it showed", async () => {
  const base = host();
  let release = () => {};
  let reverted: unknown = null;
  const call: Call = async (path, body, method, options) => {
    if (path === "/api/git") return { branch: "topic", commit: "abc1234", root: "/repo", files: [{ path: "src/app.ts", type: "edit", additions: 1, deletions: 0 }] };
    if (path === "/api/git/revert") {
      reverted = body;
      return new Promise((resolve) => {
        release = () => resolve({ reverted: ["src/app.ts"], skipped: [] });
      });
    }
    return base(path, body, method, options);
  };
  await withDock(call, async (dock) => {
    await dock.show("revert-a");
    const scopes = () => [...dock.container.querySelectorAll<HTMLButtonElement>("[data-testid=git-scope] button")];
    const revert = dock.container.querySelector<HTMLElement>("[data-testid=git-revert]");
    assert.ok(revert, "no revert");
    await act(async () => click(revert));
    await act(async () => click(revert));
    assert.deepEqual(reverted, { sessionId: "revert-a", paths: ["src/app.ts"] });
    assert.deepEqual(scopes().map((button) => button.disabled), [true, true]);
    await act(async () => {
      release();
      await wait(20);
    });
    assert.deepEqual(scopes().map((button) => button.disabled), [false, false]);
  });
});

test("a patch load slower than the git watch still shows its diffs, then loads the files the watch found meanwhile", async () => {
  const realFetch = globalThis.fetch;
  const asked: unknown[] = [];
  let answer = (_response: Response) => {};
  globalThis.fetch = async (input, init) => {
    if (!String(input).includes("/api/git/diffs")) return new Response("{}", { status: 404 });
    asked.push(JSON.parse(String(init?.body)).paths);
    return new Promise<Response>((resolve) => {
      answer = resolve;
    });
  };
  const listed = [{ path: "a.ts", type: "edit", additions: 1, deletions: 1 }];
  const base = host();
  const call: Call = async (path, body, method, options) => {
    if (path === "/api/git") return { branch: "topic", commit: "abc1234", root: "/repo", files: [...listed] };
    return base(path, body, method, options);
  };
  const patch = (path: string) => ({ path, patch: `@@ -1 +1 @@\n-old\n+${path}\n` });
  const added = (dock: { container: HTMLElement }) => [...dock.container.querySelectorAll(".diff-line.add")].map((row) => row.textContent);
  try {
    await withDock(call, async (dock) => {
      await dock.show("slow-a");
      listed.push({ path: "b.ts", type: "create", additions: 1, deletions: 0 });
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
        await wait(20);
      });
      assert.deepEqual(asked, [["a.ts"]]);
      await act(async () => {
        answer(new Response(JSON.stringify({ patches: [patch("a.ts")] })));
        await wait(20);
      });
      assert.deepEqual(added(dock), ["1+a.ts\n"]);
      assert.deepEqual(asked, [["a.ts"], ["a.ts", "b.ts"]]);
      await act(async () => {
        answer(new Response(JSON.stringify({ patches: [patch("a.ts"), patch("b.ts")] })));
        await wait(20);
      });
      assert.deepEqual(added(dock), ["1+a.ts\n", "1+b.ts\n"]);
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("bulk diffs that fail, as when the worktree is removed mid-read, ask for no single diffs", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "fatal: cannot change to '/gone': No such file or directory" }), { status: 500 });
  const single: unknown[] = [];
  const base = host();
  const call: Call = async (path, body, method, options) => {
    if (path === "/api/git") return { branch: "topic", commit: "abc1234", root: "/repo", files: [{ path: "a.ts", type: "edit", additions: 1, deletions: 1 }] };
    if (path === "/api/git/diff") single.push(body);
    return base(path, body, method, options);
  };
  try {
    await withDock(call, async (dock) => {
      await dock.show("gone-a");
      await act(async () => wait(20));
      assert.deepEqual(single, []);
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a file open in Files is read again when its chat comes back", async () => {
  await withDock(host(), async (dock) => {
    await dock.show("file-a");
    await dock.show("file-a", { sessionId: "file-a", path: "/repo/src/app.ts", nonce: 1 });
    assert.match(dock.container.querySelector("[data-testid=dock-view]")?.textContent ?? "", /text of \/repo\/src\/app\.ts/);
    await dock.show("file-b");
    assert.equal(dock.container.querySelector("[data-testid=dock-view]"), null);
    await dock.show("file-a");
    assert.equal(selectedTab(dock.container), "Files");
    assert.match(dock.container.querySelector("[data-testid=dock-view]")?.textContent ?? "", /text of \/repo\/src\/app\.ts/);
  });
});

test("a restored file that no longer reads closes quietly and is forgotten", async () => {
  dockPlaces.save("gone-a", { tab: "files", file: "/repo/old.ts" });
  const reads: { path: unknown; silent: boolean }[] = [];
  await withDock(host(["/repo/old.ts"], reads), async (dock) => {
    await dock.show("gone-a");
    assert.equal(selectedTab(dock.container), "Files");
    assert.equal(dock.container.querySelector("[data-testid=dock-view]"), null);
    assert.equal(dockPlaces.get("gone-a")?.file, undefined);
    assert.deepEqual(reads, [{ path: "/repo/old.ts", silent: true }]);
  });
});

test("a remounted dock keeps the restored state over review and file requests it already handled", async () => {
  dockPlaces.save("remount-a", { tab: "files", file: "/repo/now.ts" });
  await withDock(host(), async (dock) => {
    await dock.show("remount-a", { sessionId: "remount-a", path: "/repo/old.ts", nonce: 2 }, 4);
    assert.equal(selectedTab(dock.container), "Files");
    assert.match(dock.container.querySelector("[data-testid=dock-view]")?.textContent ?? "", /text of \/repo\/now\.ts/);
  });
});

test("each chat keeps the device it picked", async () => {
  await withDock(host(), async (dock) => {
    const shown = () => dock.container.querySelector<HTMLElement>(".device-picker")?.dataset.device;
    async function choose(id: string) {
      await act(async () => click(dock.container.querySelector<HTMLElement>(".device-picker")!));
      await act(async () => click(dock.container.querySelector<HTMLElement>(`[role="menuitemradio"][data-device="${id}"]`)!));
    }
    async function openDevices() {
      await act(async () => click(tab(dock.container, "Device")));
      await act(async () => wait(20));
    }
    await dock.show("device-a");
    await openDevices();
    assert.equal(shown(), "phone-1");
    await choose("phone-2");
    await dock.show("device-b");
    await openDevices();
    // A chat that never picked one starts on the first device.
    assert.equal(shown(), "phone-1");
    await dock.show("device-a");
    assert.equal(selectedTab(dock.container), "Device");
    assert.equal(shown(), "phone-2");
    await dock.show("device-b");
    assert.equal(shown(), "phone-1");
  });
});

test("a page opened through remote access has no Device tab", async () => {
  const mark = document.createElement("meta");
  mark.setAttribute("name", "x-bench-remote");
  mark.setAttribute("content", "1");
  document.head.append(mark);
  try {
    await withDock(host(), async ({ container, show }) => {
      await show("remote-chat");
      const tabs = [...container.querySelectorAll("[role=tab]")].map((item) => item.textContent ?? "");
      assert.ok(tabs.some((label) => label.startsWith("Changes")));
      assert.ok(!tabs.some((label) => label.startsWith("Device")));
    });
  } finally {
    mark.remove();
  }
});

test("the rail's hover label hides when the dock goes away under the pointer", async () => {
  const sent: (string | null)[] = [];
  Reflect.set(window, "xBenchDesktop", { railTip: (text: string | null) => sent.push(text) });
  try {
    const { container, show, unmount } = await mountDock(host());
    await show("hover-chat");
    await act(async () => {
      tab(container, "Files").dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
      await wait(450);
    });
    assert.equal(sent.at(-1), "Files");
    await unmount();
    assert.equal(sent.at(-1), null);
  } finally {
    Reflect.deleteProperty(window, "xBenchDesktop");
  }
});

test("the loading dock shows the chat's tab and keeps a tab picked meanwhile", async () => {
  dockPlaces.save("loading-chat", { tab: "files" });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(DockLoading, { sessionId: "loading-chat", onClose: () => {}, browser: false, terminalInDock: true, running: false }));
    });
    assert.equal(selectedTab(container), "Files");
    await act(async () => click(tab(container, "Terminal")));
    assert.equal(selectedTab(container), "Terminal");
    assert.equal(dockPlaces.get("loading-chat")?.tab, "terminal");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("the rail without a chat greys its tabs out, says why, and picks none", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(IdleRail, { browser: false, terminalInDock: true })));
    const tabs = [...container.querySelectorAll<HTMLElement>(".dock-rail button")];
    assert.ok(tabs.length > 0);
    assert.ok(tabs.every((button) => button.getAttribute("aria-disabled") === "true"));
    assert.equal(tab(container, "Changes").title, "Open a chat to use Changes");
    await act(async () => click(tab(container, "Changes")));
    assert.equal(selectedTab(container), "");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

function paneTitles(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".dock-heading")].map((head) => head.textContent ?? "");
}

function selectedTabs(container: HTMLElement): string[] {
  return [...container.querySelectorAll("[role=tab][aria-selected=true]")].map((item) => item.textContent ?? "");
}

// Drags a rail icon or a pane's head, and drops it at x, y over panes of the given width, 800px tall, or on the rail.
async function dragTo(container: HTMLElement, source: HTMLElement, at: { x: number; y: number; width?: number } | "rail") {
  await act(async () => {
    source.dispatchEvent(new MouseEvent("dragstart", { bubbles: true }));
    await wait(5);
  });
  const cover = container.querySelector<HTMLElement>("[data-testid=dock-drop]");
  assert.ok(cover, "no cover over the panes during the drag");
  const target = at === "rail" ? container.querySelector<HTMLElement>(".dock-rail")! : cover;
  if (at !== "rail") {
    const width = at.width ?? 400;
    cover.getBoundingClientRect = () => ({ left: 0, top: 0, x: 0, y: 0, width, height: 800, right: width, bottom: 800, toJSON: () => ({}) });
  }
  const point = at === "rail" ? {} : { clientX: at.x, clientY: at.y };
  await act(async () => {
    target.dispatchEvent(new MouseEvent("dragover", { bubbles: true, cancelable: true, ...point }));
  });
  await act(async () => {
    target.dispatchEvent(new MouseEvent("drop", { bubbles: true, cancelable: true, ...point }));
    source.dispatchEvent(new MouseEvent("dragend", { bubbles: true }));
    await wait(5);
  });
  assert.equal(container.querySelector("[data-testid=dock-drop]"), null);
}

function paneHead(container: HTMLElement, label: string): HTMLElement {
  const found = [...container.querySelectorAll<HTMLElement>(".dock-heading")].find((head) => head.textContent === label)?.closest<HTMLElement>(".dock-head");
  assert.ok(found, `no ${label} pane`);
  return found;
}

test("a rail icon dropped on the dock's bottom edge opens it in a second pane with its own head, kept for the chat", async () => {
  await withDock(host(), async (dock) => {
    await dock.show("split-a");
    assert.deepEqual(paneTitles(dock.container), ["Changes"]);
    await dragTo(dock.container, tab(dock.container, "Files"), { x: 200, y: 780 });
    assert.deepEqual(paneTitles(dock.container), ["Changes", "Files"]);
    assert.deepEqual(selectedTabs(dock.container), ["Changes", "Files"]);
    assert.deepEqual(dockPlaces.get("split-a")?.split, { tab: "files", edge: "bottom", ratio: 0.5 });
    await dock.show("split-b");
    assert.deepEqual(paneTitles(dock.container), ["Changes"]);
    await dock.show("split-a");
    assert.deepEqual(paneTitles(dock.container), ["Changes", "Files"]);
  });
});

test("a wide dock puts the second pane beside the first", async () => {
  await withDock(host(), async (dock) => {
    await dock.show("side-a");
    await dragTo(dock.container, tab(dock.container, "Files"), { x: 20, y: 400, width: 800 });
    assert.deepEqual(paneTitles(dock.container), ["Files", "Changes"]);
    assert.ok(dock.container.querySelector("[data-testid=dock-panes]")?.classList.contains("is-sideways"));
    assert.equal(dockPlaces.get("side-a")?.split?.edge, "left");
  });
});

test("a narrow dock stacks the panes, even for an icon dropped by its side", async () => {
  await withDock(host(), async (dock) => {
    await dock.show("narrow-a");
    await dragTo(dock.container, tab(dock.container, "Files"), { x: 20, y: 500 });
    assert.deepEqual(paneTitles(dock.container), ["Changes", "Files"]);
    assert.equal(dockPlaces.get("narrow-a")?.split?.edge, "bottom");
  });
});

test("the open surface dropped on an edge detaches into its own pane there", async () => {
  await withDock(host(), async (dock) => {
    await dock.show("detach-a");
    await dragTo(dock.container, tab(dock.container, "Changes"), { x: 200, y: 780 });
    assert.deepEqual(paneTitles(dock.container), ["Files", "Changes"]);
  });
});

test("dropping on a pane replaces it, and the other pane's surface swaps with it", async () => {
  await withDock(host(), async (dock) => {
    await dock.show("move-a");
    await dragTo(dock.container, tab(dock.container, "Files"), { x: 200, y: 780 });
    await dragTo(dock.container, tab(dock.container, "Device"), { x: 200, y: 600 });
    assert.deepEqual(paneTitles(dock.container), ["Changes", "Device"]);
    await dragTo(dock.container, paneHead(dock.container, "Device"), { x: 200, y: 200 });
    assert.deepEqual(paneTitles(dock.container), ["Device", "Changes"]);
    await dragTo(dock.container, tab(dock.container, "Device"), { x: 200, y: 600 });
    assert.deepEqual(paneTitles(dock.container), ["Changes", "Device"]);
    await dragTo(dock.container, paneHead(dock.container, "Changes"), { x: 200, y: 200 });
    assert.deepEqual(paneTitles(dock.container), ["Changes", "Device"]);
    assert.deepEqual(dockPlaces.get("move-a")?.split, { tab: "device", edge: "bottom", ratio: 0.5 });
  });
});

test("a pane closes by its head dragged onto the rail, or by its close button", async () => {
  await withDock(host(), async (dock) => {
    await dock.show("close-a");
    await dragTo(dock.container, tab(dock.container, "Files"), { x: 200, y: 780 });
    await dragTo(dock.container, paneHead(dock.container, "Changes"), "rail");
    assert.deepEqual(paneTitles(dock.container), ["Files"]);
    await dragTo(dock.container, tab(dock.container, "Changes"), { x: 200, y: 20 });
    assert.deepEqual(paneTitles(dock.container), ["Changes", "Files"]);
    await act(async () => click(dock.container.querySelector<HTMLElement>("[aria-label='Close Files']")!));
    assert.deepEqual(paneTitles(dock.container), ["Changes"]);
  });
});

test("a pane whose surface is missing waits hidden for it", async () => {
  dockPlaces.save("fallback-a", { tab: "files", split: { tab: "browser", edge: "bottom", ratio: 0.4 } });
  await withDock(host(), async (dock) => {
    await dock.show("fallback-a");
    assert.deepEqual(paneTitles(dock.container), ["Files"]);
    assert.deepEqual(dockPlaces.get("fallback-a")?.split, { tab: "browser", edge: "bottom", ratio: 0.4 });
  });
});

test("a phone shows one pane, keeps a saved split for a wider screen, and its rail's tabs don't drag", async () => {
  dockPlaces.save("phone-a", { tab: "changes", split: { tab: "files", edge: "bottom", ratio: 0.5 } });
  await withDock(host(), async (dock) => {
    await dock.show("phone-a");
    assert.deepEqual(paneTitles(dock.container), ["Changes"]);
    assert.equal(tab(dock.container, "Files").getAttribute("draggable"), "false");
    assert.deepEqual(dockPlaces.get("phone-a")?.split, { tab: "files", edge: "bottom", ratio: 0.5 });
    await click(tab(dock.container, "Files"));
    assert.deepEqual(paneTitles(dock.container), ["Files"]);
    assert.equal(dockPlaces.get("phone-a")?.tab, "files");
    assert.deepEqual(dockPlaces.get("phone-a")?.split, { tab: "changes", edge: "bottom", ratio: 0.5 });
  }, { phone: true });
});

test("opening Changes keeps the file open in a Files pane beside it", async () => {
  await withDock(host(), async (dock) => {
    await dock.show("review-split");
    await dragTo(dock.container, tab(dock.container, "Files"), { x: 200, y: 780 });
    const opened = { sessionId: "review-split", path: "/repo/src/app.ts", nonce: 7 };
    await dock.show("review-split", opened);
    await dock.show("review-split", opened, 1);
    assert.deepEqual(paneTitles(dock.container), ["Changes", "Files"]);
    assert.match(dock.container.querySelector("[data-testid=dock-view]")?.textContent ?? "", /text of \/repo\/src\/app\.ts/);
    assert.equal(dockPlaces.get("review-split")?.file, "/repo/src/app.ts");
  });
});

test("a waiting plan already in the second pane leaves the first pane as it was", async () => {
  dockPlaces.save("plan-split", { tab: "files", split: { tab: "plan", edge: "bottom", ratio: 0.5 } });
  await withDock(host(), async (dock) => {
    await dock.show("plan-split", null, 0, { pendingPlan: { toolCallId: "plan-1", plan: "Do it", planMissing: false } });
    assert.deepEqual(paneTitles(dock.container), ["Files", "Plan"]);
    assert.equal(dockPlaces.get("plan-split")?.tab, "files");
  });
});

test("a waiting plan shows in the Plan tab to read, and the dock stays on its tab", async () => {
  await withDock(host(), async (dock) => {
    await dock.show("plan-read", null, 0, { pendingPlan: { toolCallId: "plan-3", plan: "# Add a theme\n\n1. Add the row.", planMissing: false } });
    assert.equal(selectedTab(dock.container), "Changes");
    await act(async () => tab(dock.container, "Plan").click());
    assert.match(dock.container.querySelector("[data-testid=plan-overview]")?.textContent ?? "", /Add the row/);
    assert.equal(dock.container.querySelector("[data-testid=plan-overview] button"), null);
  });
});

test("opening Changes keeps the file open in Files when Changes is already the second pane", async () => {
  dockPlaces.save("review-first", { tab: "files", split: { tab: "changes", edge: "bottom", ratio: 0.5 } });
  await withDock(host(), async (dock) => {
    await dock.show("review-first");
    const opened = { sessionId: "review-first", path: "/repo/src/app.ts", nonce: 8 };
    await dock.show("review-first", opened);
    await dock.show("review-first", opened, 1);
    assert.deepEqual(paneTitles(dock.container), ["Files", "Changes"]);
    assert.match(dock.container.querySelector("[data-testid=dock-view]")?.textContent ?? "", /text of \/repo\/src\/app\.ts/);
  });
});

test("switching to a chat whose second pane shows its waiting plan keeps its first pane", async () => {
  dockPlaces.save("plan-switch", { tab: "files", split: { tab: "plan", edge: "bottom", ratio: 0.5 } });
  await withDock(host(), async (dock) => {
    await dock.show("plan-before");
    await dock.show("plan-switch", null, 0, { pendingPlan: { toolCallId: "plan-2", plan: "Do it", planMissing: false } });
    assert.deepEqual(paneTitles(dock.container), ["Files", "Plan"]);
    assert.equal(dockPlaces.get("plan-switch")?.tab, "files");
  });
});

test("the rail outside the dock opens it on a tab and closes it from the shown tab", async () => {
  const container = document.createElement("div");
  const railHost = document.createElement("div");
  document.body.append(container, railHost);
  const root = createRoot(container);
  let open = false;
  const render = () =>
    act(async () => {
      root.render(createElement(Dock, { session: session("rail-a"), call: host(), open, railHost, onOpen: () => (open = true), onClose: () => (open = false) }));
      await wait(20);
    });
  try {
    await render();
    assert.equal(container.querySelector(".dock-rail"), null);
    assert.equal(selectedTab(railHost), "");
    await act(async () => click(tab(railHost, "Files")));
    assert.equal(open, true);
    await render();
    assert.equal(selectedTab(railHost), "Files");
    await act(async () => click(tab(railHost, "Changes")));
    assert.equal(open, true);
    await render();
    await act(async () => click(tab(railHost, "Changes")));
    assert.equal(open, false);
  } finally {
    await act(() => root.unmount());
  }
});
