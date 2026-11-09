import { after, test } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import type { ProviderView, RoutinesView, RoutineView } from "../../server/snapshot.ts";
import { click, installDom, typeInto, wait } from "../testing/dom.ts";
import { fallbackCatalog } from "../chat/composer/draftConfig.ts";
import { bodyOf, draftOf, newDraft, presetOf, problemOf, scheduleOf } from "./routineForm.ts";
import { routineFolder, routinesTarget } from "./routineLink.ts";

// react-dom checks for a DOM when it loads, so it comes in after installDom.
const dom = installDom();
const { createRoot } = await import("react-dom/client");
const { groupSummary, routineGroups, Routines, routineStatus } = await import("./Routines.tsx");

after(async () => {
  await dom.happyDOM.abort();
  dom.close();
});

const grok: ProviderView = {
  id: "grok",
  label: "Grok",
  enabled: true,
  status: "ready",
  error: null,
  capabilities: {} as ProviderView["capabilities"],
  modes: [
    { id: "full", name: "Always approve" },
    { id: "acceptEdits", name: "Accept edits" },
    { id: "plan", name: "Plan" },
  ],
  defaultMode: "full",
};

const projects = [{ cwd: "/repo", name: "repo", sessions: [] }];

function routine(change: Partial<RoutineView> = {}): RoutineView {
  return {
    id: "r1",
    name: "Dependency check",
    prompt: "Check the dependencies.",
    cwd: "/repo",
    start: "worktree",
    provider: "grok",
    model: "grok-4.7",
    effort: "high",
    mode: "full",
    schedule: { every: "day", at: "09:00", days: [1, 2, 3, 4, 5] },
    catchUp: true,
    notify: true,
    enabled: true,
    armedAt: "2026-10-01T00:00:00.000Z",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    chat: false,
    nextRunAt: "2026-10-05T07:00:00.000Z",
    queued: false,
    runs: [],
    ...change,
  };
}

function view(list: RoutineView[], scheduler: RoutinesView["scheduler"] = { here: true, takesPart: true, port: 8797 }): RoutinesView {
  return { scheduler, desktop: true, list };
}

async function render(routines: RoutinesView, refuse: Record<string, string> = {}, providers: ProviderView[] = [grok], unread: string[] = []) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const calls: [string, Record<string, unknown>][] = [];
  const opened: unknown[] = [];
  await act(async () =>
    root.render(
      createElement(Routines, {
        routines,
        app: { desktop: true, keepAwake: false },
        projects,
        catalog: fallbackCatalog,
        providers,
        unread,
        call: async (path: string, body: Record<string, unknown>) => {
          calls.push([path, body]);
          if (refuse[path]) throw new Error(refuse[path]);
          return path === "/api/routines" ? { routine: { id: "new-1" } } : { ok: true };
        },
        onOpenRun: (run, chat) => opened.push({ ...run, chat }),
        seed: null,
        onSeedApplied: () => {},
      }),
    ),
  );
  return { container, calls, opened, root };
}

function button(container: Element, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((item) => (item.getAttribute("aria-label") || item.textContent || "").trim() === label);
  assert.ok(found, `no ${label} button`);
  return found as HTMLButtonElement;
}

test("schedule presets round-trip, and the body names the picked model's provider", () => {
  const draft = newDraft({ projects, catalog: fallbackCatalog, providers: [grok], now: new Date("2026-10-03T14:00:00") });
  assert.equal(draft.cwd, "/repo");
  assert.equal(draft.mode, "full");
  assert.equal(draft.once, "2026-10-04T09:00");
  assert.deepEqual(scheduleOf({ ...draft, preset: "weekly", weekday: 3, at: "08:30" }), { every: "day", at: "08:30", days: [3] });
  assert.deepEqual(scheduleOf({ ...draft, preset: "custom", days: [5, 1] }), { every: "day", at: "09:00", days: [1, 5] });
  assert.deepEqual(scheduleOf({ ...draft, preset: "hourly", hours: 6, minute: 15 }), { every: "hours", hours: 6, minute: 15 });
  for (const schedule of [{ every: "manual" }, { every: "hours", hours: 2, minute: 0 }, { every: "day", at: "09:00", days: [0, 1, 2, 3, 4, 5, 6] }, { every: "day", at: "09:00", days: [1, 2, 3, 4, 5] }, { every: "day", at: "09:00", days: [2] }, { every: "day", at: "09:00", days: [1, 3] }, { every: "once", at: "2026-10-04T09:00" }] as const) {
    const edited = draftOf(routine({ schedule: structuredClone(schedule) as RoutineView["schedule"] }), fallbackCatalog);
    assert.deepEqual(scheduleOf(edited), schedule, presetOf(schedule as RoutineView["schedule"]));
  }
  const body = bodyOf({ ...draft, name: " Check ", prompt: "Look.", picks: { model: "grok:grok-4.6", effort: "low" } }, fallbackCatalog);
  assert.deepEqual(
    { name: body.name, cwd: body.cwd, provider: body.provider, model: body.model, effort: body.effort, start: body.start },
    { name: "Check", cwd: "/repo", provider: "grok", model: "grok-4.6", effort: "low", start: "worktree" },
  );
  assert.equal(bodyOf({ ...draft, chat: true }, fallbackCatalog).chat, true);
  assert.equal(bodyOf({ ...draft, chat: true }, fallbackCatalog).start, "folder", "a chat has no worktree");
  assert.equal(problemOf({ ...draft, name: "x", prompt: "y", preset: "custom", days: [] }, fallbackCatalog), "Pick at least one day");
  assert.equal(problemOf({ ...draft, prompt: "y" }, fallbackCatalog), "Name the routine");
});

test("a routine's line says why it is paused, how its last run went and when it runs next", () => {
  const now = new Date("2026-10-03T14:00:00");
  const done = { id: "a", trigger: "schedule" as const, startedAt: new Date("2026-10-03T09:00:00").toISOString(), state: "done" as const, chat: false };
  assert.deepEqual(routineStatus(routine({ runs: [done], nextRunAt: new Date("2026-10-05T09:00:00").toISOString() }), now), { text: "Done (Today 09:00) · Next: Mon 09:00", tone: "is-done", mark: done });
  assert.equal(routineStatus(routine({ enabled: false, nextRunAt: null }), now).text, "Paused");
  assert.deepEqual(routineStatus(routine({ enabled: false, pausedReason: "Paused: the folder /repo is gone" }), now), { text: "Paused: the folder /repo is gone", tone: "is-failed" });
  const skipped = { ...done, state: "skipped" as const, reason: "The last run is still going" };
  assert.match(routineStatus(routine({ runs: [skipped] }), now).text, /^Skipped: The last run is still going/);
  const paused = routine({ enabled: false, nextRunAt: null, pausedReason: "Paused: its time came while the last run was still going", runs: [skipped, { ...done, state: "waiting" }] });
  assert.deepEqual(routineStatus(paused, now), { text: "Waiting for you (Today 09:00) · Paused: its time came while the last run was still going", tone: "is-waiting", mark: { ...done, state: "waiting" } });
  assert.match(routineStatus(routine({ runs: [{ ...done, state: "error", reason: "API error (status 429 Too Many Requests)" }] }), now).text, /^Ended with an error: API error \(status 429/);
});

test("the empty page's starter fills the editor, and Save and run now creates the routine and runs it", async () => {
  const { container, calls, root } = await render(view([]));
  await act(async () => click(button(container, container.querySelector(".routine-starter")?.textContent ?? "")));
  const editor = container.querySelector("[data-testid='routine-editor']");
  assert.ok(editor, "the editor opened");
  const name = container.querySelector<HTMLInputElement>("[data-testid='routine-name']");
  assert.equal(name?.value, "Morning PR summary");
  assert.match(container.querySelector("[data-testid='routine-next']")?.textContent ?? "", /^Weekdays at 08:30\. Next run: /);
  await act(async () => typeInto(name as HTMLInputElement, "PR summary"));
  await act(async () => {
    click(button(container, "Save and run now"));
    await wait(0);
  });
  assert.deepEqual(calls.map(([path]) => path), ["/api/routines", "/api/routines/run"]);
  assert.equal(calls[0]?.[1].name, "PR summary");
  assert.equal(calls[0]?.[1].cwd, "/repo");
  assert.deepEqual(calls[0]?.[1].schedule, { every: "day", at: "08:30", days: [1, 2, 3, 4, 5] });
  assert.deepEqual(calls[1]?.[1], { id: "new-1" });
  assert.equal(calls[0]?.[1].notify, true, "a new routine notifies");
  assert.equal(container.querySelector("[data-testid='routine-editor']"), null, "the editor closes after the save");
  await act(async () => root.unmount());
});

test("the editor refuses a custom schedule without days", async () => {
  const { container, calls, root } = await render(view([]));
  await act(async () => click(button(container, "New routine")));
  await act(async () => typeInto(container.querySelector("[data-testid='routine-name']") as HTMLInputElement, "Check"));
  await act(async () => typeInto(container.querySelector("[data-testid='routine-prompt']") as HTMLTextAreaElement, "Look."));
  await act(async () => click(button(container, "Days")));
  for (const day of ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]) await act(async () => click(button(container, day)));
  await act(async () => click(button(container, "Save")));
  assert.equal(container.querySelector("[role='alert']")?.textContent, "Pick at least one day");
  assert.deepEqual(calls, []);
  await act(async () => root.unmount());
});

test("a routine's row runs it, pauses it, and opens a run's chat", async () => {
  const run = { id: "a", trigger: "manual" as const, startedAt: "2026-10-03T07:00:00.000Z", state: "waiting" as const, sessionId: "s1", cwd: "/wt", chat: true };
  const { container, calls, opened, root } = await render(view([routine({ runs: [run] })], { here: false, takesPart: true, port: 8797 }));
  assert.equal(container.querySelector("[data-testid='routines-scheduler']")?.textContent, "Routines run on schedule in X Bench on port 8797. Run now works here.");
  assert.match(container.querySelector(".routine-meta")?.textContent ?? "", /^Weekdays at 09:00 · worktree · Grok 4\.7 · Always approve$/);
  await act(async () => click(button(container, "Run now")));
  await act(async () => click(button(container, "Pause Dependency check")));
  assert.deepEqual(calls, [["/api/routines/run", { id: "r1" }], ["/api/routines/update", { id: "r1", enabled: false }]]);
  // Run now opened the routine's history.
  assert.match(container.querySelector(".routine-run")?.textContent ?? "", /ManuallyWaiting for you/);
  const row = container.querySelector<HTMLButtonElement>("button.routine-run");
  assert.match(row?.getAttribute("aria-label") ?? "", /^Open the run from .+: Waiting for you$/);
  assert.ok(row?.querySelector(".status-dot.attention"), "a waiting run shows the yellow dot");
  await act(async () => click(row as HTMLButtonElement));
  assert.deepEqual(opened, [{ ...run, chat: true }]);
  await act(async () => (container.querySelector("[data-testid='keep-awake']") as HTMLInputElement).click());
  assert.deepEqual(calls.at(-1), ["/api/settings", { keepAwake: true }]);
  await act(async () => root.unmount());
});

test("the URL keeps the page, and a chat's routine runs in its project", () => {
  assert.equal(routinesTarget("?routines"), true);
  assert.equal(routinesTarget("?cwd=/repo"), false);
  const sidebar = [{ cwd: "/repo", sessions: [{ id: "run", cwd: "/wt/run" }] }];
  assert.equal(routineFolder({ id: "run", cwd: "/wt/run" }, sidebar), "/repo");
  assert.equal(routineFolder({ id: "draft", cwd: "/wt/run" }, sidebar), "/repo", "a draft in a worktree finds its project");
  assert.equal(routineFolder({ id: "draft", cwd: "/elsewhere" }, sidebar), "/elsewhere");
});

test("a routine can be saved with its notifications off", async () => {
  const { container, calls, root } = await render(view([]));
  await act(async () => click(button(container, container.querySelector(".routine-starter")?.textContent ?? "")));
  const notify = container.querySelector<HTMLInputElement>("[data-testid='routine-notify']");
  assert.equal(notify?.checked, true);
  await act(async () => notify?.click());
  await act(async () => {
    click(button(container, "Save"));
    await wait(0);
  });
  assert.deepEqual(calls.map(([path]) => path), ["/api/routines"]);
  assert.equal(calls[0]?.[1].notify, false);
  await act(async () => root.unmount());
});

test("a working run spins, and a run without a chat is not a button", async () => {
  const working = { id: "w", trigger: "schedule" as const, startedAt: new Date().toISOString(), state: "working" as const, sessionId: "s2", cwd: "/wt", chat: false };
  const skipped = { id: "k", trigger: "schedule" as const, startedAt: new Date().toISOString(), state: "skipped" as const, reason: "The last run is still going", chat: false };
  const { container, root } = await render(view([routine({ runs: [working, skipped] })]));
  assert.ok(container.querySelector(".routine-status .status-dot.working"), "the routine's line spins while its newest run works");
  await act(async () => click(container.querySelector(".routine-main") as HTMLButtonElement));
  const rows = [...container.querySelectorAll(".routine-run")];
  assert.deepEqual(rows.map((row) => row.tagName), ["BUTTON", "DIV"]);
  assert.ok(rows[0]?.querySelector(".status-dot.working"));
  assert.match(rows[1]?.textContent ?? "", /ScheduledSkipped: The last run is still going$/);
  await act(async () => root.unmount());
});

test("a finished run's dot stays green until its chat is opened", async () => {
  const run = { id: "a", trigger: "schedule" as const, startedAt: new Date().toISOString(), state: "done" as const, cwd: "/wt", chat: false };
  const { container, root } = await render(view([routine({ runs: [{ ...run, sessionId: "new" }, { ...run, id: "b", sessionId: "seen" }] })]), {}, [grok], ["new"]);
  assert.ok(container.querySelector(".routine-status .status-dot.unread"), "the routine's line is green while its newest run is unread");
  await act(async () => click(container.querySelector(".routine-main") as HTMLButtonElement));
  const dots = [...container.querySelectorAll(".routine-run .status-dot")].map((dot) => dot.className);
  assert.deepEqual(dots, ["status-dot unread", "status-dot run-quiet"]);
  await act(async () => root.unmount());
});

test("a first run that fails keeps the saved routine, so saving again changes it instead of making a second", async () => {
  const { container, calls, root } = await render(view([]), { "/api/routines/run": "Grok is off in Settings" });
  await act(async () => click(button(container, container.querySelector(".routine-starter")?.textContent ?? "")));
  await act(async () => {
    click(button(container, "Save and run now"));
    await wait(0);
  });
  assert.equal(container.querySelector("[role='alert']")?.textContent, "Saved, but the first run did not start: Grok is off in Settings");
  assert.equal(container.querySelector("#routine-editor-title")?.textContent, "Edit routine");
  await act(async () => {
    click(button(container, "Save"));
    await wait(0);
  });
  assert.deepEqual(calls.map(([path]) => path), ["/api/routines", "/api/routines/run", "/api/routines/update"]);
  assert.equal(calls[2]?.[1].id, "new-1");
  assert.equal(container.querySelector("[data-testid='routine-editor']"), null, "the editor closes after the save");
  await act(async () => root.unmount());
});

test("Enter in a new routine saves it without running it", async () => {
  const { container, calls, root } = await render(view([]));
  await act(async () => click(button(container, container.querySelector(".routine-starter")?.textContent ?? "")));
  const form = container.querySelector("form.routine-sheet") as HTMLFormElement;
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await wait(0);
  });
  assert.deepEqual(calls.map(([path]) => path), ["/api/routines"]);
  await act(async () => root.unmount());
});

test("editing a routine whose provider is off keeps its provider and approval mode", async () => {
  const claude: ProviderView = { ...grok, id: "claude", label: "Claude", enabled: false, modes: [{ id: "ask", name: "Ask" }, { id: "full", name: "Always approve" }], defaultMode: "ask" };
  const { container, calls, root } = await render(view([routine({ provider: "claude", model: "opus", mode: "ask" })]), {}, [grok, claude]);
  await act(async () => click(button(container, "Actions for Dependency check")));
  await act(async () => click(button(container, "Edit")));
  assert.match(container.querySelector("[data-testid='routine-provider-off']")?.textContent ?? "", /^Claude is off in Settings/);
  await act(async () => {
    click(button(container, "Save"));
    await wait(0);
  });
  const body = calls.find(([path]) => path === "/api/routines/update")?.[1];
  assert.equal(body?.mode, "ask");
  assert.equal("provider" in (body ?? {}), false, "the provider and model stay as saved");
  await act(async () => root.unmount());
});

test("Escape in the folder search closes the search and keeps the editor", async () => {
  const { container, root } = await render(view([]));
  await act(async () => click(button(container, "New routine")));
  await act(async () => click(container.querySelector("[data-testid='folder-menu']") as HTMLButtonElement));
  const search = container.querySelector("[data-testid='folder-search']") as HTMLInputElement;
  assert.ok(search, "the folder search is open");
  await act(async () => search.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  assert.ok(container.querySelector("[data-testid='routine-editor']"), "the editor stays");
  assert.equal(container.querySelector("[data-testid='folder-search']"), null, "the search closed");
  await act(async () => root.unmount());
});

test("a Once time that has passed is refused, and editing keeps a model the menu no longer offers", () => {
  const draft = newDraft({ projects, catalog: fallbackCatalog, providers: [grok], now: new Date("2026-10-03T14:00:00") });
  const once = { ...draft, name: "x", prompt: "y", preset: "once" as const };
  assert.equal(problemOf({ ...once, once: "2026-10-03T09:00" }, fallbackCatalog, new Date("2026-10-03T14:00:00")), "Pick a time that has not passed");
  assert.equal(problemOf({ ...once, once: "2026-10-04T09:00" }, fallbackCatalog, new Date("2026-10-03T14:00:00")), "");
  const gone = draftOf(routine({ model: "grok-retired", effort: "low" }), fallbackCatalog);
  assert.equal(gone.picks.model, "grok:grok-4.7", "the menu shows the provider's first model");
  const body = bodyOf({ ...gone, name: "Renamed" }, fallbackCatalog);
  assert.equal("model" in body || "provider" in body || "effort" in body, false, "an untouched model is not sent");
  assert.equal(bodyOf({ ...gone, modelTouched: true }, fallbackCatalog).model, "grok-4.7");
});

test("a run's row says its worktree was removed or why it stays, and deleting its chat offers to remove the worktree", async () => {
  const done = { id: "a", trigger: "schedule" as const, startedAt: new Date().toISOString(), state: "done" as const, sessionId: "s1", cwd: "/wt/a", chat: false };
  const kept = "The worktree stays: '/wt/c' contains modified or untracked files";
  const runs = [{ ...done, ownWorktree: true as const }, { ...done, id: "b", sessionId: "s2", worktreeRemoved: true as const }, { ...done, id: "c", sessionId: "s3", ownWorktree: true as const, worktreeKept: kept }];
  const { container, calls, root } = await render(view([routine({ runs })]));
  await act(async () => click(container.querySelector(".routine-main") as HTMLButtonElement));
  assert.deepEqual([...container.querySelectorAll(".routine-run-worktree")].map((note) => note.textContent), ["Worktree removed", kept]);
  const menus = () => [...container.querySelectorAll<HTMLButtonElement>(".routine-runs .routine-more")];
  await act(async () => click(menus()[0] as HTMLButtonElement));
  await act(async () => click(button(container, "Delete chat")));
  await act(async () => click(button(container, "Delete the worktree too")));
  assert.deepEqual(calls.at(-1), ["/api/delete", { sessionId: "s1", worktree: true }]);
  await act(async () => click(menus()[1] as HTMLButtonElement));
  await act(async () => click(button(container, "Delete chat")));
  assert.equal(container.querySelector(".routine-runs .routine-menu")?.textContent, "Delete this chat", "a removed worktree is not offered");
  await act(async () => click(button(container, "Delete this chat")));
  assert.deepEqual(calls.at(-1), ["/api/delete", { sessionId: "s2", worktree: false }]);
  await act(async () => root.unmount());
});

test("routines group by project in the sidebar's order, with plain chats last", async () => {
  const now = new Date("2026-10-03T14:00:00");
  const sidebar = [{ cwd: "/b", name: "b", sessions: [] }, { cwd: "/repo", name: "repo", sessions: [] }];
  const chat = routine({ id: "c", chat: true, cwd: "/home" });
  const groups = routineGroups([chat, routine({ id: "1" }), routine({ id: "2", cwd: "/gone" }), routine({ id: "3", cwd: "/b" }), routine({ id: "4" })], sidebar);
  assert.deepEqual(groups.map((group) => [group.name, group.routines.map((item) => item.id)]), [["b", ["3"]], ["repo", ["1", "4"]], ["gone", ["2"]], ["Chat", ["c"]]]);
  const run = { id: "a", trigger: "schedule" as const, startedAt: now.toISOString(), chat: false };
  const waiting = { ...run, state: "waiting" as const };
  assert.deepEqual(groupSummary([routine({ runs: [{ ...run, state: "error" }] }), routine({ runs: [waiting] })], now), { text: "1 waiting for you", tone: "is-waiting", mark: waiting });
  assert.equal(groupSummary([routine({ nextRunAt: new Date("2026-10-05T09:00:00").toISOString() }), routine({ nextRunAt: new Date("2026-10-04T09:00:00").toISOString() })], now).text, "Next: Tomorrow 09:00");
  assert.equal(groupSummary([routine({ enabled: false, nextRunAt: null })], now).text, "All paused");
  const working = { ...run, id: "w", state: "working" as const };
  assert.equal(groupSummary([routine({ runs: [working, waiting] })], now).text, "1 waiting for you", "a newer working run keeps an older waiting one in view");
  assert.equal(groupSummary([routine({ runs: [waiting, { ...waiting, id: "b" }] })], now).text, "2 waiting for you");

  const { container, root } = await render(view([routine(), routine({ id: "c", name: "Brief", chat: true })]));
  assert.deepEqual([...container.querySelectorAll(".routine-group-name")].map((item) => item.textContent), ["repo", "Chat"]);
  await act(async () => click(container.querySelector(".routine-group-toggle") as HTMLButtonElement));
  assert.deepEqual([...container.querySelectorAll(".routine-name")].map((item) => item.textContent), ["Brief"], "a folded project hides its routines");
  await act(async () => click(button(container, "New routine in repo")));
  await act(async () => typeInto(container.querySelector("[data-testid='routine-name']") as HTMLInputElement, "Check"));
  await act(async () => typeInto(container.querySelector("[data-testid='routine-prompt']") as HTMLTextAreaElement, "Look."));
  await act(async () => {
    click(button(container, "Save"));
    await wait(0);
  });
  assert.equal(container.querySelector(".routine-group-toggle")?.getAttribute("aria-expanded"), "true", "saving into a folded project unfolds it");
  await act(async () => root.unmount());
});
