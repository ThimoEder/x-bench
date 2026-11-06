import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { installDom } from "../../testing/dom.ts";
import type { PermissionCardRequest } from "./PermissionCard.tsx";

const dom = installDom();
const { PermissionCard } = await import("./PermissionCard.tsx");

after(async () => {
  await dom.happyDOM.abort();
  dom.close();
});

const untitled: PermissionCardRequest = { title: "", rawInput: null, options: [{ optionId: "approved", name: "Allow", kind: "allow_once" }] };

function heading(permission: PermissionCardRequest, agent?: string) {
  const html = renderToStaticMarkup(createElement(PermissionCard, { permission, call: () => {}, agent }));
  return /<h2>(.*?)<\/h2>/.exec(html)?.[1];
}

test("a permission with no title names the thread's provider", () => {
  assert.equal(heading(untitled, "ChatGPT"), "ChatGPT wants to use a tool");
  assert.equal(heading(untitled), "The agent wants to use a tool");
  assert.equal(heading({ ...untitled, title: "mcp.linear.get_issue" }, "ChatGPT"), "mcp.linear.get_issue");
});

function buttons(permission: PermissionCardRequest) {
  const html = renderToStaticMarkup(createElement(PermissionCard, { permission, call: () => {} }));
  return [...html.matchAll(/<button[^>]*class="btn (\w+)"[^>]*>(.*?)<\/button>/g)].map((match) => `${match[2]}${match[1] === "primary" ? " (primary)" : ""}`);
}

test("a plan reads its harness's choices as Keep planning and Approve, with the first approval as the primary", () => {
  const plan: PermissionCardRequest = {
    title: "Ready to code?",
    rawInput: null,
    plan: "# Add a theme\n\n1. Add the row.",
    options: [
      { optionId: "exit-plan-default", name: "Yes, manually approve edits", kind: "allow_once" },
      { optionId: "exit-plan-auto", name: "Yes, and use auto mode", kind: "allow_always" },
      { optionId: "reject", name: "No, keep planning", kind: "reject_once" },
    ],
  };
  assert.deepEqual(buttons(plan), ["Keep planning", "Approve, use auto mode", "Approve (primary)"]);
  assert.equal(heading(plan), "Add a theme");
});

test("a short ticket link in a plan opens the ticket on the board of the chat's folder", async () => {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const plan: PermissionCardRequest = { title: "", rawInput: null, plan: "# Fix it\n\nCloses [#436](?task=436).", options: [] };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(PermissionCard, { permission: plan, call: () => {}, cwd: "/repo" })));
  assert.equal(new URL(container.querySelector<HTMLAnchorElement>(".plan-doc a[href]")!.href).search, "?cwd=%2Frepo&task=436");
  await act(async () => root.unmount());
});

test("a command shows its description and what Always allow covers", () => {
  const command: PermissionCardRequest = {
    title: "`npm test`",
    kind: "execute",
    rawInput: { command: "npm test", description: "Run the tests" },
    role: "shell",
    command: "npm test",
    label: "Run the tests",
    options: [
      { optionId: "allow-once", name: "Yes", kind: "allow_once" },
      { optionId: "allow-with-updates", name: "Yes, and don't ask again for npm commands", kind: "allow_always" },
      { optionId: "reject", name: "No", kind: "reject_once" },
    ],
  };
  const html = renderToStaticMarkup(createElement(PermissionCard, { permission: command, call: () => {}, agent: "Claude" }));
  assert.equal(heading(command, "Claude"), "Claude wants to run a command");
  assert.match(html, /<p class="card-note">Run the tests\. Always allow: don&#x27;t ask again for npm commands\.<\/p>/);
  assert.deepEqual(buttons(command), ["Deny", "Always allow", "Allow once (primary)"]);
});

test("a long edit shows its first 600 lines and says the rest is not shown", () => {
  const edit: PermissionCardRequest = { title: "Write `big.ts`", kind: "edit", rawInput: { file_path: "/repo/big.ts" }, role: "edit", path: "/repo/big.ts", options: [{ optionId: "allow-once", name: "Yes", kind: "allow_once" }] };
  const newText = Array.from({ length: 700 }, (_, line) => `line ${line}`).join("\n");
  const html = renderToStaticMarkup(createElement(PermissionCard, { permission: edit, call: () => {}, cwd: "/repo", diffs: [{ path: "/repo/big.ts", oldText: "", newText, truncated: false }] }));
  assert.equal(html.match(/class="dl add"/g)?.length, 600);
  assert.match(html, /The rest of this change is not shown\./);
});

test("past two ways to approve, the rest fold under the primary's caret and still answer", async () => {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const plan: PermissionCardRequest = {
    title: "Ready to code?",
    rawInput: null,
    plan: "# Add a theme\n\n1. Add the row.",
    options: [
      { optionId: "exit-plan-default", name: "Yes, manually approve edits", kind: "allow_once" },
      { optionId: "exit-plan-clear-auto", name: "Yes, clear context (5% used) and use auto mode", kind: "allow_always" },
      { optionId: "exit-plan-auto", name: "Yes, and use auto mode", kind: "allow_always" },
      { optionId: "reject", name: "No, keep planning", kind: "reject_once" },
    ],
  };
  const calls: unknown[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(PermissionCard, { permission: plan, call: async (_path, body) => void calls.push(body) })));
  const labels = () => [...container.querySelectorAll<HTMLButtonElement>(".card-actions button")].map((button) => button.textContent || button.getAttribute("aria-label"));
  assert.deepEqual(labels(), ["Keep planning", "Approve", "More ways to go ahead"]);
  await act(async () => container.querySelector<HTMLButtonElement>("[data-testid=more-choices]")!.click());
  assert.deepEqual(
    [...container.querySelectorAll("[role=menuitem]")].map((item) => item.textContent),
    ["Approve, clear context (5% used) and use auto mode", "Approve, use auto mode"],
  );
  await act(async () => container.querySelectorAll<HTMLButtonElement>("[role=menuitem]")[1]!.click());
  assert.deepEqual(calls, [{ optionId: "exit-plan-auto" }]);
  assert.equal(container.querySelector("[role=menu]"), null);
  await act(async () => root.unmount());
});
