import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { installDom, typeInto, wait } from "../testing/dom.ts";
import type { SettingsProps, SettingsTab } from "./Settings.tsx";
import type { ProviderSettingsView } from "./providerSettings.ts";
import type { ProviderView } from "../../server/snapshot.ts";

// react-dom checks for a DOM when it loads, so it comes in after installDom.
const dom = installDom();
const { createRoot } = await import("react-dom/client");
const { Settings } = await import("./Settings.tsx");

type Request = [path: string, body: unknown, method: string | undefined];

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

function view(): ProviderSettingsView {
  return {
    defaultProvider: "grok",
    providers: [
      {
        id: "grok",
        label: "Grok",
        enabled: true,
        defaultMode: "full",
        modes: [{ id: "full", name: "Always approve" }, { id: "plan", name: "Plan" }],
        status: "ready",
        detected: { installed: true, version: "grok 1.0.60", signedIn: null, message: null },
        openChats: 0,
      },
      {
        id: "claude",
        label: "Claude",
        enabled: true,
        defaultMode: "auto",
        modes: [{ id: "auto", name: "Auto" }, { id: "full", name: "Always approve" }],
        status: "ready",
        detected: {
          installed: true,
          version: "2.1.284 (Claude Code)",
          signedIn: false,
          account: null,
          message: "Claude is not signed in. Sign in with claude in a terminal: run CLAUDE_CONFIG_DIR=~/.claude-personal claude and sign in there, then try again.",
        },
        openChats: 1,
      },
    ],
    claude: {
      configDir: "~/.claude-personal",
      configDirSaved: true,
      executable: "~/.local/bin/claude",
      installed: "~/.local/bin/claude",
      folders: ["~/.claude", "~/.claude-personal"],
      binaries: ["~/.local/bin/claude"],
      unreadable: false,
    },
    unreadable: false,
    canChoose: false,
  };
}

// The snapshot's providers: Grok steers, Claude also reads a message at its next step.
function snapshotProviders(): ProviderView[] {
  const capabilities = { loadSession: true, steer: true, deliverNext: false, steerAttachments: false, btw: false };
  return [
    { id: "grok", label: "Grok", enabled: true, status: "ready", error: null, capabilities, modes: [], defaultMode: "full" },
    { id: "claude", label: "Claude", enabled: true, status: "ready", error: null, capabilities: { ...capabilities, deliverNext: true, steerAttachments: true }, modes: [], defaultMode: "auto" },
  ];
}

async function mount(reply: (request: Request) => unknown, props: Partial<SettingsProps> = {}) {
  const requests: Request[] = [];
  const tabs: SettingsTab[] = [];
  let closed = 0;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);
  const all: SettingsProps = {
    tab: "providers",
    providers: [],
    navWidth: 280,
    call: async (path, body, method) => {
      const request: Request = [path, body, method];
      requests.push(request);
      return reply(request);
    },
    onTab: (tab) => tabs.push(tab),
    onClose: () => {
      closed += 1;
    },
    ...props,
  };
  await act(async () => root.render(createElement(Settings, all)));
  await act(async () => wait());
  return { container, requests, tabs, closed: () => closed };
}

function must<T extends Element>(element: T | null): T {
  assert.ok(element, "the element is missing");
  return element;
}

test("the providers tab shows what each harness reported, and how to sign in, with no login form", async () => {
  const { container, tabs, closed } = await mount(() => view());
  assert.equal(must(container.querySelector("h1")).textContent, "Providers");
  const version = must(container.querySelector("[data-testid=settings-version]"));
  assert.match(version.textContent ?? "", /^v\d+\.\d+\.\d+$/);
  assert.equal(version.parentElement?.className, "settings-nav");
  assert.equal(must(container.querySelector("[data-testid=provider-state-grok]")).textContent, "Installed · grok 1.0.60 · Sign-in is checked when a chat starts");
  assert.equal(must(container.querySelector("[data-testid=provider-state-claude]")).textContent, "Installed · 2.1.284 · Not signed in");
  assert.match(must(container.querySelector("[data-testid=provider-claude]")).textContent ?? "", /CLAUDE_CONFIG_DIR=~\/\.claude-personal claude/);
  assert.equal(container.querySelector("input[type=password]"), null);
  assert.equal(must(container.querySelector<HTMLInputElement>("[data-testid=claude-config-dir]")).value, "~/.claude-personal");
  // Fast mode is not offered: the app keeps it off.
  assert.doesNotMatch(container.textContent ?? "", /Fast mode/);
  // Every choice applies at once, so there is no Save.
  assert.equal(container.querySelector("[data-testid=save-providers]"), null);
  await act(async () => must(container.querySelector<HTMLButtonElement>("[data-testid=settings-tab-boards]")).click());
  assert.deepEqual(tabs, ["boards"]);
  await act(async () => must(container.querySelector<HTMLButtonElement>("[data-testid=settings-back]")).click());
  assert.equal(closed(), 1);
});

test("turning Claude off applies at once, keeps its chats, sends only the choices, and the last provider can go off too", async () => {
  const saved = view();
  const { container, requests } = await mount(([path, body, method]) => {
    if (method === "GET") return view();
    assert.equal(path, "/api/providers");
    // The host answers with the choices it was sent.
    const choices = (body as { providers: Record<string, { enabled: boolean }> }).providers;
    return { ...saved, providers: saved.providers.map((row) => ({ ...row, enabled: choices[row.id]?.enabled ?? row.enabled })) };
  });
  await act(async () => must(container.querySelector<HTMLInputElement>("[data-testid=provider-enabled-claude]")).click());
  await act(async () => wait());
  const posted = requests.filter(([, , method]) => method !== "GET");
  assert.ok(posted.length >= 1);
  // Claude's folder and program are not part of a switch.
  assert.deepEqual(posted[0]?.[1], {
    defaultProvider: "grok",
    providers: { grok: { enabled: true, defaultMode: "full" }, claude: { enabled: false, defaultMode: "auto" } },
  });
  assert.equal(must(container.querySelector<HTMLInputElement>("[data-testid=provider-enabled-claude]")).checked, false);
  // Off keeps the open chats, so nothing asks about closing them.
  assert.equal(container.querySelector("[data-testid=settings-closes]"), null);
  assert.doesNotMatch(must(container.querySelector("[data-testid=provider-claude]")).textContent ?? "", /Off:/);
  // New chats can only start on a provider that is on.
  assert.deepEqual([...must(container.querySelector("[data-testid=default-provider]")).querySelectorAll("option")].map((option) => option.textContent), ["Grok"]);
  // The last one can go off too. Then new chats start nowhere.
  const grok = must(container.querySelector<HTMLInputElement>("[data-testid=provider-enabled-grok]"));
  assert.equal(grok.disabled, false);
  await act(async () => grok.click());
  await act(async () => wait());
  const menu = must(container.querySelector<HTMLSelectElement>("[data-testid=default-provider]"));
  assert.deepEqual([...menu.querySelectorAll("option")].map((option) => option.textContent), ["None"]);
  assert.equal(menu.disabled, true);
});

test("a menu the host refuses goes back, and the reason shows under it", async () => {
  const { container } = await mount(([, , method]) => {
    if (method === "GET") return view();
    throw new Error("A Claude turn is running. Stop it or wait for it to end, then save again.");
  });
  const mode = must(container.querySelector<HTMLSelectElement>("[data-testid=default-mode-claude]"));
  await act(async () => {
    mode.value = "full";
    mode.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => wait());
  assert.equal(must(container.querySelector<HTMLSelectElement>("[data-testid=default-mode-claude]")).value, "auto");
  assert.equal(must(container.querySelector("[data-testid=settings-error-claude]")).textContent, "A Claude turn is running. Stop it or wait for it to end, then save again.");
});

test("Claude's folder applies when the field is left, and asks first when that closes its open chats", async () => {
  const { container, requests } = await mount(([, body, method]) => {
    if (method === "GET") return view();
    const next = view();
    const folder = typeof body === "object" && body && "claude" in body ? String((body as { claude: { configDir: string } }).claude.configDir) : "";
    return { ...next, claude: next.claude ? { ...next.claude, configDir: folder } : null };
  });
  const folder = must(container.querySelector<HTMLInputElement>("[data-testid=claude-config-dir]"));
  const leave = () => folder.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  const posts = () => requests.filter(([, , method]) => method !== "GET");

  // Typing sends nothing. Leaving the field asks first, since a Claude chat is open.
  await act(async () => typeInto(folder, "~/.claude-work"));
  assert.equal(posts().length, 0);
  await act(async () => leave());
  assert.match(must(container.querySelector("[data-testid=settings-closes]")).textContent ?? "", /This closes the open Claude chat/);
  assert.equal(posts().length, 0);

  // Keeping the current one puts the field back.
  await act(async () => must(container.querySelector<HTMLButtonElement>("[data-testid=claude-keep]")).click());
  assert.equal(must(container.querySelector<HTMLInputElement>("[data-testid=claude-config-dir]")).value, "~/.claude-personal");
  assert.equal(posts().length, 0);

  await act(async () => typeInto(must(container.querySelector<HTMLInputElement>("[data-testid=claude-config-dir]")), "~/.claude-work"));
  await act(async () => leave());
  await act(async () => must(container.querySelector<HTMLButtonElement>("[data-testid=claude-apply]")).click());
  await act(async () => wait());
  assert.deepEqual(posts().map(([, body]) => body), [{ claude: { configDir: "~/.claude-work", executable: "~/.local/bin/claude" } }]);
  assert.equal(container.querySelector("[data-testid=settings-closes]"), null);
});

test("the general section picks the theme at once, and every other theme control follows", async () => {
  const { useTheme } = await import("../useTheme.ts");
  // Another theme control on the page, like the sidebar's toggle, shows the theme it holds.
  function Probe() {
    const [theme] = useTheme();
    return createElement("span", { "data-testid": "probe" }, theme);
  }
  const seen = () => document.querySelector("[data-testid=probe]")?.textContent;
  const { container } = await mount(() => view(), { tab: "general" });
  const probe = document.createElement("div");
  document.body.append(probe);
  const root = createRoot(probe);
  mounted.push(root);
  await act(async () => root.render(createElement(Probe)));
  assert.equal(must(container.querySelector("h1")).textContent, "General");
  const choice = must(container.querySelector<HTMLSelectElement>("[data-testid=theme-choice]"));
  for (const theme of ["light", "dark"]) {
    await act(async () => {
      choice.value = theme;
      choice.dispatchEvent(new Event("change", { bubbles: true }));
    });
    assert.equal(document.documentElement.dataset.theme, theme);
    assert.equal(localStorage.getItem("x-bench-theme"), theme);
    assert.equal(seen(), theme);
  }
  await act(async () => {
    choice.value = "system";
    choice.dispatchEvent(new Event("change", { bubbles: true }));
  });
  assert.equal(localStorage.getItem("x-bench-theme"), null);
  assert.equal(choice.value, "system");
});

test("the general section picks Studio or Classic colours at once, Studio by default", async () => {
  const { container } = await mount(() => view(), { tab: "general" });
  const studio = must(container.querySelector<HTMLButtonElement>("[data-testid=colors-studio]"));
  const classic = must(container.querySelector<HTMLButtonElement>("[data-testid=colors-classic]"));
  assert.equal(studio.getAttribute("aria-pressed"), "true");
  await act(async () => classic.click());
  assert.equal(document.documentElement.dataset.colors, "classic");
  assert.equal(localStorage.getItem("x-bench-colors"), "classic");
  assert.equal(classic.getAttribute("aria-pressed"), "true");
  await act(async () => studio.click());
  assert.equal(document.documentElement.dataset.colors, "studio");
  assert.equal(localStorage.getItem("x-bench-colors"), null);

  // Another window stores Classic and light: this one follows at once.
  const { followOtherWindows } = await import("../useTheme.ts");
  followOtherWindows();
  localStorage.setItem("x-bench-colors", "classic");
  localStorage.setItem("x-bench-theme", "light");
  await act(async () => window.dispatchEvent(new window.StorageEvent("storage", { key: "x-bench-colors" })));
  assert.equal(document.documentElement.dataset.colors, "classic");
  assert.equal(document.documentElement.dataset.theme, "light");
  assert.equal(classic.getAttribute("aria-pressed"), "true");
  localStorage.clear();
});

test("a board's Save turns on only once a field changed, and a saved connection's switch applies at once", async () => {
  let trelloOn = false;
  const { container, requests } = await mount(
    ([path, body, method]) => {
      if (path === "/api/sak/status") return { configured: true, enabled: true, reachable: true, version: "0.2.0", baseUrl: "http://127.0.0.1:4345" };
      if (path === "/api/trello/status") return { configured: true, enabled: false, reachable: false };
      if (path === "/api/trello/connection" && method === "PUT") {
        trelloOn = Boolean((body as { enabled?: boolean }).enabled);
        return { configured: true, enabled: trelloOn, reachable: trelloOn, username: "me" };
      }
      return {};
    },
    { tab: "boards" },
  );
  const sak = must(container.querySelector<HTMLButtonElement>("[data-testid=save-board-sak]"));
  const trello = must(container.querySelector<HTMLButtonElement>("[data-testid=save-board-trello]"));
  assert.equal(sak.disabled, true);
  assert.equal(trello.disabled, true);

  const address = must(container.querySelector<HTMLInputElement>("[data-testid=board-sak] input:not([type])"));
  await act(async () => typeInto(address, "http://127.0.0.1:4346"));
  assert.equal(sak.disabled, false);
  await act(async () => typeInto(address, "http://127.0.0.1:4345"));
  assert.equal(sak.disabled, true);

  // Trello's connection is saved, so its switch goes at once with only the switch, and Save stays off.
  await act(async () => must(container.querySelector<HTMLInputElement>("[data-testid=board-enabled-trello]")).click());
  await act(async () => wait());
  assert.deepEqual(requests.filter(([path, , method]) => path === "/api/trello/connection" && method === "PUT").map(([, body]) => body), [{ enabled: true }]);
  assert.equal(trelloOn, true);
  assert.equal(must(container.querySelector<HTMLInputElement>("[data-testid=board-enabled-trello]")).checked, true);
  assert.equal(trello.disabled, true);
  assert.match(must(container.querySelector("[data-testid=board-state-trello]")).textContent ?? "", /Connected · me/);
});

test("Jira is set up with its site, email and API token, and the token never comes back", async () => {
  let saved: Record<string, unknown> = {};
  const { container, requests } = await mount(
    ([path, body, method]) => {
      if (path === "/api/jira/status") return { configured: false, enabled: false, reachable: false, name: null, site: "", email: "" };
      if (path === "/api/jira/connection" && method === "PUT") {
        saved = body as Record<string, unknown>;
        return { configured: true, enabled: true, reachable: true, name: "Me", site: "https://example.atlassian.net", email: "me@example.com" };
      }
      return {};
    },
    { tab: "boards" },
  );
  const save = must(container.querySelector<HTMLButtonElement>("[data-testid=save-board-jira]"));
  const [site, email] = [...container.querySelectorAll<HTMLInputElement>("[data-testid=board-jira] input:not([type])")].map((input) => must(input));
  assert.ok(site && email, "the site and email fields are missing");
  const token = must(container.querySelector<HTMLInputElement>("[data-testid=jira-token]"));
  assert.equal(save.disabled, true);
  // The switch of a connection that is not saved yet goes with the first Save.
  await act(async () => must(container.querySelector<HTMLInputElement>("[data-testid=board-enabled-jira]")).click());
  assert.equal(requests.filter(([path]) => path === "/api/jira/connection").length, 0);
  await act(async () => typeInto(site, "example.atlassian.net"));
  await act(async () => typeInto(email, "me@example.com"));
  assert.equal(save.disabled, true);
  await act(async () => typeInto(token, "secret"));
  assert.equal(save.disabled, false);
  await act(async () => save.click());
  await act(async () => wait());
  assert.deepEqual(saved, { baseUrl: "example.atlassian.net", email: "me@example.com", token: "secret", enabled: true });
  assert.equal(requests.filter(([path]) => path === "/api/jira/connection").length, 1);
  assert.equal(token.value, "");
  assert.equal(site.value, "https://example.atlassian.net");
  assert.match(must(container.querySelector("[data-testid=board-state-jira]")).textContent ?? "", /Connected · Me/);

  // The switch of a saved connection applies at once and keeps a site edit that is not saved yet.
  await act(async () => typeInto(site, "other.atlassian.net"));
  await act(async () => must(container.querySelector<HTMLInputElement>("[data-testid=board-enabled-jira]")).click());
  await act(async () => wait());
  assert.deepEqual(saved, { enabled: false });
  assert.equal(site.value, "other.atlassian.net");
});

test("the general section sets each provider's follow-up, and every composer follows", async () => {
  const { useFollowUp, followUpChoices } = await import("../chat/useFollowUp.ts");
  const claude = { deliverNext: true, steer: true };
  // A composer on the page, holding the choice its follow-up menu shows.
  function Probe() {
    const [followUp] = useFollowUp("claude", followUpChoices(claude));
    return createElement("span", { "data-testid": "follow-up-probe" }, followUp);
  }
  localStorage.removeItem("x-bench-follow-ups");
  const { container } = await mount(() => view(), { tab: "general", providers: snapshotProviders() });
  const probe = document.createElement("div");
  document.body.append(probe);
  const root = createRoot(probe);
  mounted.push(root);
  await act(async () => root.render(createElement(Probe)));
  const shown = () => document.querySelector("[data-testid=follow-up-probe]")?.textContent;
  const grok = must(container.querySelector<HTMLSelectElement>("[data-testid=follow-up-choice-grok]"));
  const choice = must(container.querySelector<HTMLSelectElement>("[data-testid=follow-up-choice-claude]"));
  assert.equal(grok.value, "queue");
  assert.deepEqual([...grok.options].map((option) => option.textContent), ["Queue", "Steer"]);
  assert.equal(choice.value, "next");
  assert.deepEqual([...choice.options].map((option) => option.textContent), ["Queue", "Next step", "Steer"]);
  assert.equal(shown(), "next");
  for (const next of ["queue", "steer"]) {
    await act(async () => {
      choice.value = next;
      choice.dispatchEvent(new Event("change", { bubbles: true }));
    });
    assert.equal(JSON.parse(localStorage.getItem("x-bench-follow-ups") ?? "{}").claude, next);
    assert.equal(shown(), next);
  }
  assert.equal(grok.value, "queue");
});

test("a page opened through remote access has no Remote or Devices tab and no file pickers", async () => {
  const mark = document.createElement("meta");
  mark.setAttribute("name", "x-bench-remote");
  mark.setAttribute("content", "1");
  document.head.append(mark);
  try {
    const { container } = await mount(() => ({ ...view(), canChoose: true }));
    assert.equal(container.querySelector('[data-testid="settings-tab-remote"]'), null);
    assert.equal(container.querySelector('[data-testid="settings-tab-devices"]'), null);
    assert.ok(container.querySelector('[data-testid="settings-tab-providers"]'));
    assert.ok(![...container.querySelectorAll("button")].some((button) => button.textContent === "Choose…"));
  } finally {
    mark.remove();
  }
});

test("on the Mac the Remote tab and the file pickers are there", async () => {
  const { container } = await mount(() => ({ ...view(), canChoose: true }));
  assert.ok(container.querySelector('[data-testid="settings-tab-remote"]'));
  assert.ok([...container.querySelectorAll("button")].some((button) => button.textContent === "Choose…"));
});

test("the general section keeps the Mac awake through the host, and only in the app", async () => {
  const { container, requests } = await mount(() => ({ ok: true }), { tab: "general", app: { desktop: true, keepAwake: false, planTool: false } });
  const keepAwake = must(container.querySelector<HTMLInputElement>("[data-testid=misc-block] [data-testid=keep-awake]"));
  assert.equal(keepAwake.checked, false);
  await act(async () => keepAwake.click());
  assert.deepEqual(requests, [["/api/settings", { keepAwake: true }, undefined]]);
  assert.equal(container.querySelector("[data-testid=routine-notify]"), null, "notifications are set per routine");

  // A browser tab's host has no app to keep the Mac awake.
  const browser = await mount(() => ({ ok: true }), { tab: "general", app: { desktop: false, keepAwake: true, planTool: false } });
  assert.equal(browser.container.querySelector("[data-testid=misc-block]"), null);
});

test("the experimental section turns the plan steps on through the host, in the app and in a browser tab", async () => {
  const { container, requests } = await mount(() => ({ ok: true }), { tab: "general", app: { desktop: false, keepAwake: false, planTool: false } });
  const planTool = must(container.querySelector<HTMLInputElement>("[data-testid=experimental-block] [data-testid=plan-tool]"));
  assert.equal(planTool.checked, false);
  await act(async () => planTool.click());
  assert.deepEqual(requests, [["/api/settings", { planTool: true }, undefined]]);
});

test("the title pins as a bar once it has scrolled past its lead, and unpins at the top", async () => {
  const { container } = await mount(() => view());
  const main = must(container.querySelector<HTMLElement>(".settings-main"));
  must(container.querySelector<HTMLElement>(".settings-title")).style.top = "-36px";
  const scrollTo = async (top: number) => {
    await act(async () => {
      main.scrollTop = top;
      main.dispatchEvent(new Event("scroll"));
    });
    return main.classList.contains("is-pinned");
  };
  assert.equal(await scrollTo(20), false);
  assert.equal(await scrollTo(80), true);
  assert.equal(await scrollTo(0), false);
});
