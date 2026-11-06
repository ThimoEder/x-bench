import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { installDom, wait } from "../testing/dom.ts";
import type { ProviderSettingsRow, ProviderSettingsView } from "../settings/providerSettings.ts";

// react-dom checks for a DOM when it loads, so it comes in after installDom.
const dom = installDom();
const { createRoot } = await import("react-dom/client");
const { Onboarding, installedDefaults, isReady, setupCommand } = await import("./Onboarding.tsx");

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

function row(id: string, label: string, detected: Partial<ProviderSettingsRow["detected"]>): ProviderSettingsRow {
  return {
    id,
    label,
    enabled: true,
    defaultMode: "full",
    modes: [{ id: "full", name: "Always approve" }],
    status: "ready",
    detected: { installed: true, version: null, signedIn: null, message: null, ...detected },
    openChats: 0,
  };
}

function view(claudeSignedIn: boolean): ProviderSettingsView {
  return {
    defaultProvider: "grok",
    providers: [
      row("grok", "Grok", { installed: false, command: "curl -fsSL https://x.ai/cli/install.sh | bash" }),
      row("claude", "Claude", { signedIn: claudeSignedIn, command: claudeSignedIn ? null : "claude" }),
      row("chatgpt", "ChatGPT", { signedIn: false, command: "codex login" }),
    ],
    claude: null,
    unreadable: false,
    canChoose: false,
  };
}

function must<T extends Element>(element: T | null): T {
  assert.ok(element, "the element is missing");
  return element;
}

test("only installed agents start on, Continue waits for a signed-in one, and new chats then start on it", async () => {
  let signedIn = false;
  let saved: { defaultProvider: string; providers: Record<string, { enabled: boolean }> } | null = null;
  // The host keeps what onboarding saved, over what each check detects.
  const current = (): ProviderSettingsView => {
    const detected = view(signedIn);
    if (!saved) return detected;
    const choices = saved;
    return { ...detected, defaultProvider: choices.defaultProvider, providers: detected.providers.map((item) => ({ ...item, enabled: choices.providers[item.id]?.enabled ?? item.enabled })) };
  };
  const posts: unknown[] = [];
  const done: boolean[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);
  const call = async (_path: string, body?: unknown, method?: string) => {
    if (method !== "GET") {
      posts.push(body);
      saved = body as NonNullable<typeof saved>;
    }
    return current();
  };
  await act(async () => root.render(createElement(Onboarding, { call, onDone: (chat: boolean) => done.push(chat) })));
  await act(async () => wait());
  await act(async () => must(container.querySelector<HTMLButtonElement>("[data-testid=onboarding-start]")).click());

  assert.match(must(container.querySelector("[data-testid=onboarding-grok]")).textContent ?? "", /x\.ai\/cli\/install\.sh/);
  assert.match(must(container.querySelector("[data-testid=onboarding-chatgpt]")).textContent ?? "", /codex login/);
  assert.equal(must(container.querySelector<HTMLInputElement>("[data-testid=onboarding-enabled-grok]")).checked, false);
  assert.equal(must(container.querySelector<HTMLInputElement>("[data-testid=onboarding-enabled-claude]")).checked, true);
  const next = must(container.querySelector<HTMLButtonElement>("[data-testid=onboarding-continue]"));
  assert.equal(next.disabled, true);

  signedIn = true;
  await act(async () => must(container.querySelector<HTMLButtonElement>("[data-testid=onboarding-check]")).click());
  await act(async () => wait());
  assert.equal(next.disabled, false);
  assert.doesNotMatch(must(container.querySelector("[data-testid=onboarding-claude]")).textContent ?? "", /Copy/);

  await act(async () => next.click());
  await act(async () => wait());
  assert.deepEqual(posts.map((body) => (body as { defaultProvider: string }).defaultProvider), ["claude"]);
  assert.match(container.textContent ?? "", /Claude · new chats start here/);

  await act(async () => must(container.querySelector<HTMLButtonElement>("[data-testid=onboarding-finish]")).click());
  assert.deepEqual(done, [true]);
});

test("Skip leaves without starting a chat", async () => {
  const done: boolean[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);
  await act(async () => root.render(createElement(Onboarding, { call: async () => view(false), onDone: (chat: boolean) => done.push(chat) })));
  await act(async () => must(container.querySelector<HTMLButtonElement>("[data-testid=onboarding-skip]")).click());
  assert.deepEqual(done, [false]);
});

test("a card offers the command its agent reports: install while missing, sign-in while signed out", () => {
  assert.deepEqual(setupCommand(row("a", "A", { installed: false, command: "install a" })), { text: "Install it, then sign in", command: "install a" });
  assert.deepEqual(setupCommand(row("a", "A", { signedIn: false, command: "a login" })), { text: "Sign in", command: "a login" });
  assert.equal(setupCommand(row("a", "A", { signedIn: true })), null);
});

test("the welcome page's theme previews switch the app's theme", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);
  await act(async () => root.render(createElement(Onboarding, { call: async () => view(false), onDone: () => {} })));
  await act(async () => must(container.querySelector<HTMLButtonElement>("[data-testid=onboarding-theme-light]")).click());
  assert.equal(document.documentElement.dataset.theme, "light");
  assert.equal(must(container.querySelector("[data-testid=onboarding-theme-light]")).getAttribute("aria-checked"), "true");
  await act(async () => must(container.querySelector<HTMLButtonElement>("[data-testid=onboarding-theme-dark]")).click());
  assert.equal(document.documentElement.dataset.theme, "dark");
});

test("Continue stays on the agent step and shows why when saving the default fails", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);
  const call = async (_path: string, _body?: unknown, method?: string) => {
    if (method !== "GET") throw new Error("providers.json does not read");
    return view(true);
  };
  await act(async () => root.render(createElement(Onboarding, { call, onDone: () => {} })));
  await act(async () => wait());
  await act(async () => must(container.querySelector<HTMLButtonElement>("[data-testid=onboarding-start]")).click());
  await act(async () => must(container.querySelector<HTMLButtonElement>("[data-testid=onboarding-continue]")).click());
  await act(async () => wait());
  assert.ok(container.querySelector("[data-testid=onboarding-continue]"), "the agent step is still showing");
  assert.match(container.textContent ?? "", /providers\.json does not read/);
});

test("an agent that reports a problem is not ready, while an unknown sign-in is", () => {
  const form = { defaultProvider: "a", providers: { a: { enabled: true, defaultMode: "" } }, claude: { configDir: "", executable: "" } };
  assert.equal(isReady(row("a", "A", { signedIn: null }), form), true);
  assert.equal(isReady(row("a", "A", { signedIn: null, message: "The config folder is missing." }), form), false);
});

test("onboarding turns on exactly the installed providers, except one whose switch the person flipped", () => {
  const detected: ProviderSettingsView = { ...view(true), defaultProvider: "grok" };
  const wanted = installedDefaults(detected, new Set());
  assert.deepEqual(wanted && Object.entries(wanted.providers).map(([id, choice]) => [id, choice.enabled]), [["grok", false], ["claude", true], ["chatgpt", true]]);
  assert.equal(wanted?.defaultProvider, "claude");
  assert.equal(installedDefaults(detected, new Set(["grok"])), null);
  assert.equal(installedDefaults({ ...detected, unreadable: true }, new Set()), null);
});

test("the switches stay locked while onboarding saves the installed agents", async () => {
  let release = () => {};
  const call = async (_path: string, _body?: unknown, method?: string) => {
    if (method !== "GET") {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    return view(true);
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);
  await act(async () => root.render(createElement(Onboarding, { call, onDone: () => {} })));
  await act(async () => wait());
  await act(async () => must(container.querySelector<HTMLButtonElement>("[data-testid=onboarding-start]")).click());
  const claude = () => must(container.querySelector<HTMLInputElement>("[data-testid=onboarding-enabled-claude]"));
  assert.equal(claude().disabled, true);
  await act(async () => {
    release();
    await wait();
  });
  assert.equal(claude().disabled, false);
});
