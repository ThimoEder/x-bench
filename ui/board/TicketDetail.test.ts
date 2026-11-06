import { after, test } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import type { SidebarSession } from "../../server/snapshot.ts";
import { click, installDom, typeInto, wait } from "../testing/dom.ts";
import type { TicketDetailProps } from "./TicketDetail.tsx";

// react-dom checks for a DOM when it loads, so it comes in after installDom.
const dom = installDom();
const { createRoot } = await import("react-dom/client");
const { TicketDetail } = await import("./TicketDetail.tsx");

after(async () => {
  await dom.happyDOM.abort();
  dom.close();
});

function leave(field: Element) {
  act(() => {
    field.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
}

const noop = () => {};

// Ticket 41 on /repo, with chat s1 linked, and s2 in a project and s3 in the Chat tab.
async function mount(props: Partial<TicketDetailProps>) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(TicketDetail, {
        detail: { task: { id: 41, title: "Ship it", description: "", revision: 1 }, comments: [], links: [{ sessionId: "s1" }] },
        board: { provider: "sak", columns: [], tasks: [], capabilities: {} },
        cwd: "/repo",
        chats: [{ id: "s1", title: "Ship it" }, { id: "s2", title: "Look around" }, { id: "s3", title: "A plain chat" }] as SidebarSession[],
        call: async () => ({}),
        working: [],
        onChanged: noop,
        onReload: noop,
        onOpenSession: noop,
        onThread: noop,
        onUnlink: async () => {},
        onLink: async () => {},
        onMove: noop,
        onDelete: noop,
        onClose: noop,
        onOpenTicket: noop,
        onManageLabels: noop,
        expanded: false,
        onExpand: noop,
        ...props,
      }),
    ),
  );
  return { container, root };
}

test("a field left while another one saves goes after it, on the revision that save made", async () => {
  const patches: unknown[] = [];
  let answerFirst: (value: unknown) => void = () => {};
  const call = async (_path: string, body?: unknown, method?: string) => {
    if (method !== "PATCH") return {};
    patches.push(body);
    if (patches.length === 1) return new Promise((resolve) => { answerFirst = resolve; });
    return { task: { id: 41, title: "Ship it now", description: "Details", revision: 3 } };
  };
  const { container, root } = await mount({ call });

  act(() => click(container.querySelector('button[title="Edit the title"]')!));
  const title = container.querySelector<HTMLInputElement>("input.ticket-title")!;
  act(() => typeInto(title, "Ship it now"));
  leave(title);
  assert.equal(title.readOnly, true, "no newer draft while the title saves");

  act(() => click([...container.querySelectorAll("button")].find((button) => button.textContent === "Add a description")!));
  const description = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Description"]')!;
  assert.equal(description.readOnly, false, "another field opens while the title saves");
  act(() => typeInto(description, "Details"));
  leave(description);
  await act(() => wait());
  assert.deepEqual(patches, [{ revision: 1, title: "Ship it now" }]);
  act(() => click(container.querySelector('button[title="Edit the title"]')!));
  assert.equal(container.querySelector<HTMLInputElement>("input.ticket-title")?.readOnly, true, "a reopened title stays read-only while its save still runs");

  await act(async () => {
    answerFirst({ task: { id: 41, title: "Ship it now", description: "", revision: 2 } });
    await wait();
  });
  assert.deepEqual(patches[1], { revision: 2, description: "Details" });

  act(() => root.unmount());
});

test("the + under Chats links a sidebar chat by its session id, and says why it refuses one", async () => {
  const linked: string[] = [];
  const { container, root } = await mount({ onLink: async (sessionId) => void linked.push(sessionId) });
  const field = () => container.querySelector<HTMLInputElement>('input[aria-label="Session id"]');
  const alert = () => container.querySelector('[role="alert"]')?.textContent;
  async function submit(text: string) {
    act(() => typeInto(field()!, text));
    await act(async () => {
      field()!.form!.requestSubmit();
      await wait();
    });
  }

  act(() => click(container.querySelector('button[aria-label="Link a chat by its session id"]')!));
  await submit("nope");
  assert.equal(alert(), "No chat has this session id.");
  await submit("s1");
  assert.equal(alert(), "This chat is already linked.");
  await submit(" s2 ");
  assert.deepEqual(linked, ["s2"]);
  act(() => click(container.querySelector('button[aria-label="Link a chat by its session id"]')!));
  await submit("s3");
  assert.deepEqual(linked, ["s2", "s3"]);
  assert.equal(field(), null, "the field closes once linked");

  act(() => root.unmount());
});

test("a picture and a clip the ticket keeps show in its description from the board API, and a path on this machine stays its name", async () => {
  const meta = document.createElement("meta");
  meta.name = "x-bench-token";
  meta.content = "launch";
  document.head.append(meta);
  const files = [
    { id: 9, url: "/api/files/9", content_type: "image/png" },
    { id: 10, url: "/api/files/10", content_type: "video/mp4" },
  ];
  const { container, root } = await mount({
    detail: { task: { id: 41, title: "Ship it", description: "Before ![board](/api/files/9), ![run](/api/files/10) and ![local](/tmp/a.png)", revision: 1 }, comments: [], links: [] },
    call: async (path) => (path.endsWith("/files") ? { files } : {}),
  });
  await act(async () => wait());
  const images = [...container.querySelectorAll(".ticket-prose img")];
  assert.deepEqual(images.map((image) => image.getAttribute("src")), ["/api/board/tasks/41/files/9?token=launch"]);
  assert.equal(container.querySelector(".ticket-prose video")?.getAttribute("src"), "/api/board/tasks/41/files/10.mp4?token=launch");
  assert.equal(container.querySelector('.ticket-prose .md-file[title="/tmp/a.png"]')?.textContent, "local");
  act(() => root.unmount());
  meta.remove();
});

test("a comment is Markdown, and a picture named the way Jira writes it shimmers until the ticket's files load", async () => {
  const calls: string[] = [];
  let answer: (data: unknown) => void = noop;
  const { container, root } = await mount({
    detail: {
      task: { id: "APP-1", title: "Ship it", description: "Seen here: !shot.png|width=300!", revision: 1 },
      comments: [{ id: "1", body: "**Fixed** in ![after](/api/files/9)" }],
      links: [],
    },
    board: { provider: "jira", columns: [], tasks: [], capabilities: { embedsByName: true } },
    call: (path) => {
      calls.push(path);
      if (!path.endsWith("/files")) return Promise.resolve({});
      return new Promise((resolve) => {
        answer = resolve;
      });
    },
  });
  assert.deepEqual(calls, ["/api/board/tasks/APP-1/files"]);
  assert.equal(container.querySelector('.md-image-pending[aria-label="Loading shot.png"]')?.getAttribute("role"), "status");
  assert.equal(container.textContent?.includes("!shot.png"), false, "the markup does not show while the list loads");
  await act(async () => {
    answer({ files: [{ id: "10001", name: "shot.png", content_type: "image/png" }, { id: 9, url: "/api/files/9", content_type: "image/png" }] });
    await wait();
  });
  assert.equal(container.querySelector(".md-image-pending"), null);
  const sources = [...container.querySelectorAll(".ticket-prose img")].map((image) => image.getAttribute("src"));
  assert.deepEqual(sources, ["/api/board/tasks/APP-1/files/10001", "/api/board/tasks/APP-1/files/9"]);
  assert.equal(container.querySelector(".ticket-comment-body strong")?.textContent, "Fixed");
  act(() => root.unmount());
});

test("a pick in the label menu takes an attached label off the ticket and puts another one on", async () => {
  const calls: string[] = [];
  const call = async (path: string, _body?: unknown, method?: string) => {
    calls.push(`${method} ${path}`);
    return { task: { id: 41, title: "Ship it", revision: 2 } };
  };
  let managed = 0;
  const { container, root } = await mount({
    call,
    detail: { task: { id: 41, title: "Ship it", description: "", revision: 1, labels: [{ id: 1, title: "bug" }] }, comments: [], links: [] },
    board: { provider: "sak", columns: [], tasks: [], capabilities: { labels: true }, labels: [{ id: 1, title: "bug" }, { id: 2, title: "idea" }] },
    onManageLabels: () => {
      managed += 1;
    },
  });
  try {
    act(() => click(container.querySelector('.label-picker button[aria-haspopup="menu"]')!));
    const pick = async (title: string) => {
      await act(async () => {
        click([...document.querySelectorAll('[role="menuitemcheckbox"]')].find((item) => item.textContent === title)!);
        await wait(0);
      });
    };
    await pick("bug");
    await pick("idea");
    assert.deepEqual(calls, ["DELETE /api/board/tasks/41/labels/1", "PUT /api/board/tasks/41/labels/2"]);
    act(() => click([...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent?.includes("Manage labels"))!));
    assert.equal(managed, 1);
  } finally {
    act(() => root.unmount());
  }
});
