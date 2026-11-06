import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import type { PullRequest } from "../../server/git/pullRequest.ts";
import { installDom } from "../testing/dom.ts";

const dom = installDom();
const { createRoot } = await import("react-dom/client");
const { PullChip, PullNotice, pullLabel, pullPrompt, usePullRequest } = await import("./PullRequest.tsx");

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

const pr: PullRequest = { number: 90, url: "https://github.com/o/r/pull/90", title: "Follow", head: "topic", base: "main", repo: "o/r", status: "ready", review: "", failing: [], pending: [] };

async function mount(element: ReturnType<typeof createElement>) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);
  await act(async () => {
    root.render(element);
  });
  return container;
}

test("the chip links to the pull request in the default browser", async () => {
  const chip = (await mount(createElement(PullChip, { pr }))).querySelector("a");
  assert.equal(chip?.getAttribute("href"), pr.url);
  assert.equal(chip?.getAttribute("target"), "_blank");
  assert.match(chip?.getAttribute("aria-label") || "", /Ready to merge/);
});

test("the notice shows only when the pull request needs the person, and its button asks the chat once GitHub still agrees", async () => {
  const conflict: PullRequest = { ...pr, status: "conflict" };
  let fresh: PullRequest = conflict;
  let stale = 0;
  const sent: unknown[] = [];
  const call = async (path: string, body?: Record<string, unknown>) => {
    if (path === "/api/git/pr") return { pr: fresh };
    sent.push([path, body?.text]);
    return {};
  };
  const onStale = () => stale++;
  assert.equal((await mount(createElement(PullNotice, { pr, running: false, act: call, onStale }))).childElementCount, 0);
  const notice = await mount(createElement(PullNotice, { pr: conflict, running: false, act: call, onStale }));
  assert.match(notice.textContent || "", /#90 · Merge conflicts with main/);
  await act(async () => notice.querySelector("button")?.click());
  assert.equal(sent.length, 1);
  assert.equal((sent[0] as unknown[])[0], "/api/prompt");
  assert.match(String((sent[0] as unknown[])[1]), /^First check that this folder is on branch topic\. If it is not, stop and tell me\./);
  assert.match(String((sent[0] as unknown[])[1]), /Fetch the latest main of o\/r, which may be another remote than origin/);

  fresh = { ...pr, status: "ready" };
  await act(async () => notice.querySelector("button")?.click());
  assert.equal(sent.length, 1);
  assert.equal(stale, 1);

  const busy = await mount(createElement(PullNotice, { pr: { ...pr, status: "failing", failing: ["Test"] }, running: true, act: call, onStale }));
  assert.equal(busy.querySelector("button")?.textContent, "Fix in chat");
  assert.equal(busy.querySelector("button")?.disabled, true);
});

test("another folder drops the old pull request before GitHub answers for the new one", async () => {
  let answer: (value: unknown) => void = () => {};
  let calls = 0;
  const call = () => {
    calls++;
    return calls === 1 ? Promise.resolve({ pr }) : new Promise<unknown>((resolve) => {
      answer = resolve;
    });
  };
  function Probe({ cwd }: { cwd: string }) {
    const { pr: shown } = usePullRequest(call, false, true, cwd);
    return createElement("p", null, shown ? `#${shown.number}` : "none");
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);
  await act(async () => root.render(createElement(Probe, { cwd: "/a" })));
  assert.equal(container.textContent, "#90");
  await act(async () => root.render(createElement(Probe, { cwd: "/b" })));
  assert.equal(container.textContent, "none");
  await act(async () => answer({ pr: { ...pr, number: 91 } }));
  assert.equal(container.textContent, "#91");
});

test("a failed check before sending sends nothing and refreshes the pull request", async () => {
  let stale = 0;
  const sent: string[] = [];
  const call = async (path: string) => {
    if (path === "/api/git/pr") throw new Error("offline");
    sent.push(path);
    return {};
  };
  const notice = await mount(createElement(PullNotice, { pr: { ...pr, status: "conflict" }, running: false, act: call, onStale: () => stale++ }));
  await act(async () => notice.querySelector("button")?.click());
  assert.deepEqual(sent, []);
  assert.equal(stale, 1);
  assert.equal(notice.querySelector("button")?.disabled, false);
});

test("the prompt checks for the local branch when it tracks the pull request's head under another name", () => {
  assert.match(pullPrompt({ ...pr, branch: "local", status: "conflict" }) || "", /^First check that this folder is on branch local\. .* #90 \(topic → main\)/);
});

test("a long list of failing checks shows five names", () => {
  const failing = ["a", "b", "c", "d", "e", "f", "g"];
  assert.equal(pullLabel({ ...pr, status: "failing", failing }), "a, b, c, d, e and 2 more failing");
});
