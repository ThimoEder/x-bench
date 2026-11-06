import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { click, installDom, press, typeInto, wait } from "../../testing/dom.ts";
import type { ComposerProps, ComposerSession, DraftCommit } from "./Composer.tsx";
import { resetComposerDrafts } from "./composerDrafts.ts";

// react-dom checks for a DOM when it loads, so it comes in after installDom.
const dom = installDom();
const { createRoot } = await import("react-dom/client");
const { Composer } = await import("./Composer.tsx");

type Request = [path: string, body: Record<string, unknown> | undefined];

const mounted: Root[] = [];

// The host's replies the composer reads on its own: the folder's skills.
// A ChatGPT draft also gets the list Codex reported last.
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url.startsWith("/api/skills")) {
    const chatgpt = String(init?.body).includes('"provider":"chatgpt"');
    return Response.json({
      skills: [{ name: "review", hint: "Review the diff" }],
      commands: chatgpt ? [{ name: "$why", description: "Find the reason" }] : [],
    });
  }
  return Response.json({});
};

afterEach(async () => {
  await act(async () => {
    for (const root of mounted.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  resetComposerDrafts();
});

after(async () => {
  await dom.happyDOM.abort();
  dom.close();
});

function session(overrides: Partial<ComposerSession> = {}): ComposerSession {
  return {
    id: "session-1",
    cwd: "/repo",
    status: "idle",
    modeId: "full",
    configOptions: [],
    suggestion: null,
    mentions: [],
    ...overrides,
  };
}

async function mount(props: Partial<ComposerProps> = {}) {
  const requests: Request[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);
  const all: ComposerProps = {
    session: session(),
    plain: false,
    hotkey: false,
    act: async (path, body) => {
      requests.push([path, body]);
      return path === "/api/mentions" ? { searchId: "search-1" } : {};
    },
    onOpenBtw: () => {},
    ...props,
  };
  await act(async () => root.render(createElement(Composer, all)));
  const box = container.querySelector("textarea");
  assert.ok(box);
  return { container, box, requests };
}

function must(element: Element | null): Element {
  assert.ok(element, "the element is missing");
  return element;
}

// React reports a moved caret from the document's selectionchange while the box has focus.
function moveCaret(box: HTMLTextAreaElement, at: number) {
  box.focus();
  box.setSelectionRange(at, at);
  document.dispatchEvent(new Event("selectionchange"));
}

function texts(container: Element, selector: string) {
  return [...container.querySelectorAll(selector)].map((node) => node.textContent);
}

test("the slash menu lists commands and folder skills and runs the highlighted one", async () => {
  const opened: string[] = [];
  const { container, box } = await mount({ onOpenBtw: (question) => opened.push(question) });
  await act(async () => {
    typeInto(box, "/");
    await wait(10);
  });
  assert.deepEqual(texts(container, ".slash-name"), ["/plan", "/btw", "/review"]);
  assert.equal(container.querySelector(".slash-menu .active")?.textContent, "/planSwitch to plan mode");

  await act(async () => press(box, "ArrowDown"));
  assert.equal(container.querySelector(".slash-menu [aria-selected=true] .slash-name")?.textContent, "/btw");

  await act(async () => press(box, "Enter"));
  assert.deepEqual(opened, [""]);
  assert.equal(box.value, "");
  assert.equal(container.querySelector("[data-testid=slash-menu]"), null);
});

test("a picked skill waits in the box and goes out as typed", async () => {
  const { container, box, requests } = await mount({
    session: session({ commands: [{ name: "compact", description: "Summarize" }, { name: "$why", description: "Find the reason" }] }),
  });
  await act(async () => typeInto(box, "/wh"));
  assert.deepEqual(texts(container, ".slash-name"), ["/why"]);
  assert.equal(must(container.querySelector(".slash-menu button")).getAttribute("title"), "Find the reason");

  await act(async () => press(box, "Enter"));
  assert.equal(box.value, "/why ");
  assert.equal(container.querySelector("[data-testid=slash-menu]"), null);
  assert.deepEqual(requests, []);

  await act(async () => typeInto(box, "/why did we pick SSE"));
  await act(async () => press(box, "Enter"));
  assert.deepEqual(requests, [["/api/prompt", { text: "/why did we pick SSE" }]]);
});

test("a skill picked mid-message replaces only its token", async () => {
  const { container, box, requests } = await mount({
    session: session({ commands: [{ name: "why", description: "Find the reason" }] }),
  });
  await act(async () => typeInto(box, "first look, then /p"));
  assert.equal(container.querySelector("[data-testid=slash-menu]"), null);

  await act(async () => typeInto(box, "first look, then /w"));
  assert.deepEqual(texts(container, ".slash-name"), ["/why"]);
  await act(async () => press(box, "Enter"));
  assert.equal(box.value, "first look, then /why ");
  assert.deepEqual(requests, []);

  await act(async () => typeInto(box, "keep this /w"));
  await act(async () => press(box, "Escape"));
  assert.equal(box.value, "keep this ");
});

test("the slash menu follows the caret and a pick replaces the whole token", async () => {
  const { container, box } = await mount({
    session: session({ commands: [{ name: "review", description: "Review the diff" }] }),
  });
  await act(async () => typeInto(box, "please /rev"));
  assert.deepEqual(texts(container, ".slash-name"), ["/review"]);
  await act(async () => moveCaret(box, 0));
  assert.equal(container.querySelector("[data-testid=slash-menu]"), null);

  await act(async () => moveCaret(box, 10));
  assert.deepEqual(texts(container, ".slash-name"), ["/review"]);
  await act(async () => press(box, "Enter"));
  assert.equal(box.value, "please /review ");

  await act(async () => typeInto(box, "please /rev, next"));
  await act(async () => moveCaret(box, 11));
  await act(async () => press(box, "Enter"));
  assert.equal(box.value, "please /review , next");
});

test("/plan and /btw show only while the draft is the token, so a caret inside one keeps its text", async () => {
  const { container, box } = await mount();
  await act(async () => typeInto(box, "/plan design auth"));
  await act(async () => moveCaret(box, 3));
  assert.equal(container.querySelector("[data-testid=slash-menu]"), null);
  await act(async () => typeInto(box, "/b"));
  assert.deepEqual(texts(container, ".slash-name"), ["/btw"]);
});

test("Codex's own commands show only at the start of a message, its skills anywhere", async () => {
  const provider = {
    id: "chatgpt",
    label: "ChatGPT",
    enabled: true,
    status: "ready" as const,
    error: null,
    capabilities: { loadSession: true, steer: true, deliverNext: false, steerAttachments: false, btw: false },
    modes: [{ id: "full" as const, name: "Always approve" }],
    defaultMode: "full" as const,
  };
  const { container, box } = await mount({
    provider,
    session: session({ commands: [{ name: "compact", description: "Summarize" }, { name: "$compare", description: "Compare" }] }),
  });
  await act(async () => typeInto(box, "/comp"));
  assert.deepEqual(texts(container, ".slash-name"), ["/compact", "/compare"]);
  await act(async () => typeInto(box, "please /comp"));
  assert.deepEqual(texts(container, ".slash-name"), ["/compare"]);
});

test("escape closes the slash menu and clears the command", async () => {
  const { container, box } = await mount();
  await act(async () => typeInto(box, "/pl"));
  assert.deepEqual(texts(container, ".slash-name"), ["/plan"]);
  await act(async () => press(box, "Escape"));
  assert.equal(box.value, "");
  assert.equal(container.querySelector("[data-testid=slash-menu]"), null);
});

test("an @ mention searches the folder and inserts the picked path", async () => {
  const mentions = [
    { name: "README.md", path: "/repo/README.md", type: "file" },
    { name: "READING.md", path: "/repo/docs/READING.md", type: "file" },
  ];
  const { container, box, requests } = await mount({ session: session({ mentions }) });
  await act(async () => {
    typeInto(box, "see @REA");
    await wait(120);
  });
  assert.deepEqual(requests, [["/api/mentions", { query: "REA", hidden: false, searchId: "" }]]);
  assert.deepEqual(texts(container, "[data-testid=mentions] button"), ["README.md", "docs/READING.md"]);

  await act(async () => press(box, "ArrowDown"));
  await act(async () => press(box, "Enter"));
  assert.equal(box.value, "see @docs/READING.md ");
  assert.equal(container.querySelector("[data-testid=mentions]"), null);
  assert.deepEqual(requests.at(-1), ["/api/mentions/close", { searchId: "search-1" }]);
});

test("a draft or a chat does not search for mentions", async () => {
  const mentions = [{ name: "README.md", path: "/repo/README.md", type: "file" }];
  const { container, box, requests } = await mount({ session: session({ mentions }), plain: true });
  await act(async () => {
    typeInto(box, "@REA");
    await wait(120);
  });
  assert.deepEqual(requests, []);
  assert.equal(container.querySelector("[data-testid=mentions]"), null);
});

test("enter sends the prompt and clears the box", async () => {
  let sent = 0;
  const { container, box, requests } = await mount({ onSent: () => sent++ });
  await act(async () => typeInto(box, "  hello there  "));
  await act(async () => press(box, "Enter"));
  assert.deepEqual(requests, [["/api/prompt", { text: "hello there" }]]);
  assert.equal(sent, 1);
  assert.equal(box.value, "");
  assert.equal(container.querySelector<HTMLButtonElement>("[data-testid=send]")?.disabled, true);
});

test("a chat that is still loading takes text and sends nothing until it has loaded", async () => {
  const { container, box, requests } = await mount({ session: session({ loading: true }) });
  await act(async () => typeInto(box, "hello there"));
  await act(async () => press(box, "Enter"));
  assert.deepEqual(requests, []);
  assert.equal(box.value, "hello there");
  assert.equal(box.disabled, false);
  assert.equal(container.querySelector<HTMLButtonElement>("[data-testid=send]")?.disabled, true);
});

test("a slash skill waits while the chat loads", async () => {
  const { box, requests } = await mount({ session: session({ loading: true }) });
  await act(async () => typeInto(box, "/review"));
  await act(async () => wait(20));
  await act(async () => press(box, "Enter"));
  assert.deepEqual(requests, []);
});

test("shift-enter keeps typing instead of sending", async () => {
  const { box, requests } = await mount();
  await act(async () => typeInto(box, "first line"));
  await act(async () => press(box, "Enter", { shiftKey: true }));
  assert.deepEqual(requests, []);
  assert.equal(box.value, "first line");
});

test("a new-session draft commits instead of prompting", async () => {
  const commits: DraftCommit[] = [];
  const { box, requests } = await mount({ onCommit: (draft) => void commits.push(draft) });
  await act(async () => typeInto(box, "start here"));
  await act(async () => press(box, "Enter"));
  assert.deepEqual(commits, [{ text: "start here", files: [] }]);
  assert.deepEqual(requests, []);
});

test("a new chat lists the skills its harness reported last", async () => {
  const provider = {
    id: "chatgpt",
    label: "ChatGPT",
    enabled: true,
    status: "ready" as const,
    error: null,
    capabilities: { loadSession: true, steer: true, deliverNext: false, steerAttachments: false, btw: false },
    modes: [{ id: "full" as const, name: "Always approve" }],
    defaultMode: "full" as const,
  };
  const commits: DraftCommit[] = [];
  const { container, box } = await mount({ provider, session: session({ id: "draft" }), onCommit: (draft) => void commits.push(draft) });
  await act(async () => {
    typeInto(box, "/");
    await wait(10);
  });
  assert.deepEqual(texts(container, ".slash-name"), ["/plan", "/why", "/review"]);

  await act(async () => typeInto(box, "/why did we pick SSE"));
  await act(async () => press(box, "Enter"));
  assert.deepEqual(commits, [{ text: "/why did we pick SSE", files: [] }]);
});

test("a picked file shows as a chip, can be removed, and goes with the prompt", async () => {
  const { container, box, requests } = await mount();
  const picker = container.querySelector<HTMLInputElement>("[data-testid=attach-input]");
  assert.ok(picker);

  async function pick(file: File) {
    Object.defineProperty(picker, "files", { value: [file], configurable: true });
    await act(async () => {
      picker?.dispatchEvent(new Event("change", { bubbles: true }));
      await wait(10);
    });
  }

  await pick(new File(["draft notes"], "notes.txt", { type: "text/plain" }));
  assert.deepEqual(texts(container, ".attach-chip .attach-name"), ["notes.txt"]);
  assert.deepEqual(texts(container, ".attach-chip .attach-kind"), ["TXT"]);

  const remove = container.querySelector("[aria-label='Remove notes.txt']");
  assert.ok(remove);
  await act(async () => click(remove));
  assert.equal(container.querySelector("[data-testid=attachments]"), null);

  await pick(new File(["a,b\n1,2\n"], "data.csv", { type: "text/csv" }));
  await act(async () => typeInto(box, "see the file"));
  await act(async () => press(box, "Enter"));
  assert.equal(requests.length, 1);
  const [path, body] = requests[0] ?? [];
  assert.equal(path, "/api/prompt");
  assert.equal(body?.text, "see the file");
  assert.ok(Array.isArray(body?.attachments));
  assert.deepEqual(
    body.attachments.map((file: unknown) => (typeof file === "object" && file !== null && "name" in file ? file.name : null)),
    ["data.csv"],
  );
  assert.equal(container.querySelector("[data-testid=attachments]"), null);
});

test("backspace in an empty box removes the last file", async () => {
  const { container, box } = await mount();
  const picker = container.querySelector<HTMLInputElement>("[data-testid=attach-input]");
  assert.ok(picker);
  Object.defineProperty(picker, "files", { value: [new File(["x"], "a.txt"), new File(["y"], "b.txt")], configurable: true });
  await act(async () => {
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    await wait(10);
  });
  assert.deepEqual(texts(container, ".attach-chip .attach-name"), ["a.txt", "b.txt"]);
  await act(async () => press(box, "Backspace"));
  assert.deepEqual(texts(container, ".attach-chip .attach-name"), ["a.txt"]);
});

test("Grok offers queue or steer, also before a turn runs", async () => {
  localStorage.removeItem("x-bench-follow-ups");
  const { container } = await mount({ session: session({ status: "running" }) });
  assert.ok(container.querySelector("[data-testid=follow-up]"));
  const idle = await mount({ session: session({ id: "session-2" }) });
  assert.equal(must(idle.container.querySelector("[data-testid=follow-up]")).textContent, "Queue");
  // With no turn running, a message is an ordinary prompt whatever the choice.
  await typeInto(idle.box, "hello");
  await press(idle.box, "Enter");
  await wait();
  assert.deepEqual(idle.requests.at(-1), ["/api/prompt", { text: "hello" }]);
});

test("a running Claude turn offers Queue, Next step and Steer, starts on Next step, and sends files that way too", async () => {
  localStorage.removeItem("x-bench-follow-ups");
  const provider = {
    id: "claude",
    label: "Claude",
    enabled: true,
    status: "ready" as const,
    error: null,
    capabilities: { loadSession: true, steer: true, deliverNext: true, steerAttachments: true, btw: false },
    modes: [{ id: "auto" as const, name: "Auto" }],
    defaultMode: "auto" as const,
  };
  const { container, box, requests } = await mount({ provider, session: session({ status: "running", modeId: "auto" }) });
  assert.equal(must(container.querySelector("[data-testid=follow-up]")).textContent, "Next step");
  assert.equal(box.getAttribute("placeholder"), "Add to the next step");
  await click(must(container.querySelector("[data-testid=follow-up]")));
  assert.deepEqual(
    [...container.querySelectorAll("[role=option] .option-text")].map((name) => name.firstChild?.textContent),
    ["Queue", "Next step", "Steer"],
  );
  assert.equal(texts(container, "[aria-selected=true] .option-check").length, 1);
  await click(must(container.querySelector("[data-testid=follow-up]")));

  const picker = must(container.querySelector("[data-testid=attach-input]"));
  Object.defineProperty(picker, "files", { value: [new File(["x"], "notes.txt", { type: "text/plain" })], configurable: true });
  await act(async () => {
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    await wait(10);
  });
  await typeInto(box, "read this");
  await press(box, "Enter");
  await wait();
  const [path, body] = requests.at(-1) ?? [];
  assert.equal(path, "/api/steer");
  assert.equal(body?.at, "next");
  assert.equal(body?.text, "read this");
  assert.equal((body?.attachments as unknown[] | undefined)?.length, 1);
});

test("the model menu groups providers and folds older models until asked", async () => {
  const model = {
    id: "model",
    name: "Model",
    currentValue: "grok:grok-4.7",
    options: [
      { value: "grok:grok-4.7", name: "Grok 4.7", group: "Grok" },
      { value: "claude:opus", name: "Opus 5.5", group: "Claude" },
      { value: "claude:claude-opus-4-6", name: "Opus 4.6", group: "Claude", older: true },
      { value: "claude:claude-sonnet-4-6", name: "Sonnet 4.6", group: "Claude", older: true },
    ],
  };
  const { container } = await mount({ session: session({ configOptions: [model] }) });
  await click(must(container.querySelector("[data-testid=config-model]")));
  assert.deepEqual(texts(container, ".option-group"), ["Grok", "Claude"]);
  assert.deepEqual(texts(container, "[role=option]"), ["Grok 4.7", "Opus 5.5"]);
  await click(must(container.querySelector("[data-testid=more-models]")));
  assert.deepEqual(texts(container, "[role=option]"), ["Grok 4.7", "Opus 5.5", "Opus 4.6", "Sonnet 4.6"]);
});

test("an on/off option is a switch in the effort menu, which stays open when it flips", async () => {
  const effort = { id: "effort", name: "Effort", currentValue: "high", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] };
  const ultracode = { id: "ultracode", name: "Ultracode", currentValue: "off", options: [{ value: "on", name: "On" }, { value: "off", name: "Off" }] };
  const { container, requests } = await mount({ session: session({ configOptions: [effort, ultracode] }) });
  assert.equal(container.querySelector(".option-trigger[data-testid=config-ultracode]"), null);
  await click(must(container.querySelector("[data-testid=config-effort]")));
  const toggle = must(container.querySelector("[role=switch][data-testid=config-ultracode]"));
  assert.equal(toggle.getAttribute("aria-checked"), "false");
  await click(toggle);
  assert.deepEqual(requests.at(-1), ["/api/config", { configId: "ultracode", value: "on" }]);
  assert.ok(container.querySelector(".option-list"));
});

test("on a phone the option menus sit behind one button named by the model and its effort", async () => {
  const phone = { matches: true, addEventListener() {}, removeEventListener() {} };
  Object.defineProperty(window, "matchMedia", { value: () => phone, configurable: true, writable: true });
  try {
    const model = { id: "model", name: "Model", currentValue: "opus", options: [{ value: "opus", name: "Opus 5.5" }, { value: "sonnet", name: "Sonnet 5.5" }, { value: "haiku", name: "Haiku 4.5" }, { value: "fable", name: "Fable 5.1" }, { value: "old", name: "Opus 4.6", older: true }] };
    const effort = { id: "effort", name: "Reasoning", currentValue: "high", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] };
    const { container, requests } = await mount({ session: session({ configOptions: [model, effort] }) });
    assert.equal(container.querySelector("[data-testid=config-model]"), null);
    const trigger = must(container.querySelector("[data-testid=config-combined]"));
    assert.equal(trigger.textContent, "Opus 5.5 · High");
    await click(trigger);
    assert.deepEqual(texts(container, ".option-section h3"), ["Model", "Reasoning", "Approval"]);
    await click(must([...container.querySelectorAll("[role=radio]")].find((node) => node.textContent === "Low") ?? null));
    assert.deepEqual(requests.at(-1), ["/api/config", { configId: "effort", value: "low" }]);
    assert.ok(container.querySelector(".option-panel"), "the panel stays open for the next pick");
  } finally {
    Reflect.deleteProperty(window, "matchMedia");
  }
});

test("on a phone Send fills in the suggestion while the box is empty, and sends once it is filled", async () => {
  const phone = { matches: true, addEventListener() {}, removeEventListener() {} };
  Object.defineProperty(window, "matchMedia", { value: () => phone, configurable: true, writable: true });
  try {
    const { container, box, requests } = await mount({ session: session({ suggestion: "Open a pull request" }) });
    assert.equal(container.querySelector("[data-testid=send]"), null);
    const tap = new MouseEvent("click", { bubbles: true, cancelable: true });
    await act(async () => must(container.querySelector("[data-testid=fill-suggestion]")).dispatchEvent(tap));
    assert.equal(tap.defaultPrevented, true, "the tap that fills must not also submit");
    assert.equal(box.value, "Open a pull request");
    assert.deepEqual(requests, []);
    assert.equal(container.querySelector("[data-testid=fill-suggestion]"), null);
    await click(must(container.querySelector("[data-testid=send]")));
    assert.deepEqual(requests, [["/api/prompt", { text: "Open a pull request" }]]);
  } finally {
    Reflect.deleteProperty(window, "matchMedia");
  }
});

test("off a phone the suggestion leaves Send as it is", async () => {
  const { container } = await mount({ session: session({ suggestion: "Open a pull request" }) });
  assert.equal(container.querySelector("[data-testid=fill-suggestion]"), null);
  assert.equal(container.querySelector<HTMLButtonElement>("[data-testid=send]")?.disabled, true);
});

test("a provider without steer or side questions hides those controls, and its modes fill the approval menu", async () => {
  const provider = {
    id: "claude",
    label: "Claude",
    enabled: true,
    status: "ready" as const,
    error: null,
    capabilities: { loadSession: true, steer: false, deliverNext: false, steerAttachments: false, btw: false },
    modes: [
      { id: "ask" as const, name: "Ask first" },
      { id: "full" as const, name: "Always approve" },
    ],
    defaultMode: "ask" as const,
  };
  const { container, box, requests } = await mount({ provider, session: session({ status: "running", modeId: "ask" }) });
  // No queue-or-steer choice: a message sent during the turn waits in the queue.
  assert.equal(container.querySelector("[data-testid=follow-up]"), null);
  await click(must(container.querySelector("[data-testid=config-approval]")));
  assert.deepEqual(texts(container, "[role=option]"), ["Ask first", "Always approve"]);
  await typeInto(box, "/btw why?");
  await press(box, "Enter");
  await wait();
  assert.deepEqual(requests.at(-1), ["/api/prompt", { text: "/btw why?" }]);
});

test("a draft warms its provider once, on its first text, and an open session never does", async () => {
  let warmed = 0;
  const { box } = await mount({ onCommit: async () => {}, onWarm: () => { warmed += 1; }, session: session({ id: "draft" }) });
  await typeInto(box, "h");
  await typeInto(box, "hello");
  assert.equal(warmed, 1);
  const open = await mount({ onWarm: () => { warmed += 1; } });
  await typeInto(open.box, "hi");
  assert.equal(warmed, 1);
});

test("a chat whose provider is off has a disabled box that says how to go on, and does not send", async () => {
  const provider = {
    id: "claude",
    label: "Claude",
    enabled: false,
    status: "stopped" as const,
    error: null,
    capabilities: { loadSession: true, steer: true, deliverNext: false, steerAttachments: false, btw: false },
    modes: [{ id: "auto" as const, name: "Auto" }],
    defaultMode: "auto" as const,
  };
  const { container, box, requests } = await mount({ provider, session: session({ modeId: "auto" }) });
  const hint = "Claude is off. Turn it on in Settings, or start a new chat on another provider.";
  assert.equal(box.getAttribute("placeholder"), hint);
  assert.equal(box.disabled, true);
  assert.equal(box.getAttribute("title"), hint);
  const send = container.querySelector<HTMLButtonElement>("[data-testid=send]");
  assert.ok(send);
  assert.equal(send.disabled, true);
  assert.equal(send.getAttribute("title"), hint);
  await press(box, "Enter");
  assert.ok(!requests.some(([path]) => path === "/api/prompt"));
});

test("a new chat with every provider off has a disabled box that says to turn one on", async () => {
  const provider = {
    id: "grok",
    label: "Grok",
    enabled: false,
    status: "idle" as const,
    error: null,
    capabilities: { loadSession: true, steer: true, deliverNext: false, steerAttachments: false, btw: true },
    modes: [{ id: "full" as const, name: "Always approve" }],
    defaultMode: "full" as const,
  };
  const { box } = await mount({ provider, session: session({ id: "draft" }), onCommit: async () => {} });
  assert.equal(box.getAttribute("placeholder"), "No provider is on. Turn one on in Settings.");
  assert.equal(box.disabled, true);
});

test("the box measures again when its width changes, and not when only its height does", async () => {
  // happy-dom lays nothing out: the box wraps its placeholder onto many lines below 300 px wide.
  let width = 0;
  let lines: () => number = () => (width < 300 ? 12 : 1);
  const observers: { resize: () => void; disconnected: boolean; target?: unknown }[] = [];
  class FakeResizeObserver {
    disconnected = false;
    target?: unknown;
    constructor(callback: () => void) {
      observers.push(Object.assign(this, { resize: callback }));
    }
    observe(target: unknown) {
      this.target = target;
    }
    disconnect() {
      this.disconnected = true;
    }
  }
  Object.defineProperty(globalThis, "ResizeObserver", { value: FakeResizeObserver, configurable: true, writable: true });
  try {
    const { box } = await mount();
    Object.defineProperty(box, "offsetWidth", { get: () => width });
    Object.defineProperty(box, "scrollHeight", { get: () => lines() * 24 });
    const observer = observers.find((entry) => entry.target === box);
    assert.ok(observer);

    width = 250;
    observer.resize();
    assert.equal(box.style.height, "200px");

    width = 800;
    observer.resize();
    assert.equal(box.style.height, "24px");

    // Same width, so the box keeps its height even if a fresh measure would differ.
    lines = () => 3;
    observer.resize();
    assert.equal(box.style.height, "24px");

    lines = () => Math.ceil(box.value.length / 80) || 1;
    await act(async () => typeInto(box, "x".repeat(80 * 20)));
    assert.equal(box.style.height, "200px");

    await act(async () => mounted.pop()?.unmount());
    assert.equal(observer.disconnected, true);
  } finally {
    Reflect.deleteProperty(globalThis, "ResizeObserver");
  }
});

test("the + menu attaches files, takes a screenshot in the desktop app, and starts a mention or a command", async () => {
  Reflect.set(window, "xBenchDesktop", { screenshot: async () => new Uint8Array([1, 2, 3]) });
  try {
    const { container, box } = await mount();
    const plus = container.querySelector("[data-testid=plus]");
    assert.ok(plus);
    await act(async () => click(plus));
    assert.deepEqual(texts(container, ".plus-list [role=menuitem] span"), ["Attach files", "Take a screenshot", "Mention a file", "Run a command"]);

    const shot = [...container.querySelectorAll(".plus-list [role=menuitem]")].find((item) => item.textContent?.includes("screenshot"));
    assert.ok(shot);
    await act(async () => {
      click(shot);
      await wait(10);
    });
    assert.equal(container.querySelector(".plus-list"), null);
    assert.match(texts(container, ".attach-chip .attach-name")[0] ?? "", /^Screenshot .+\.png$/);

    await act(async () => click(plus));
    const command = [...container.querySelectorAll(".plus-list [role=menuitem]")].find((item) => item.textContent?.includes("command"));
    assert.ok(command);
    await act(async () => {
      click(command);
      await wait(10);
    });
    assert.equal(box.value, "/");
  } finally {
    Reflect.deleteProperty(window, "xBenchDesktop");
  }
});

test("a chat's + menu only attaches files", async () => {
  const { container } = await mount({ plain: true });
  const plus = container.querySelector("[data-testid=plus]");
  assert.ok(plus);
  await act(async () => click(plus));
  assert.deepEqual(texts(container, ".plus-list [role=menuitem] span"), ["Attach files"]);
});
