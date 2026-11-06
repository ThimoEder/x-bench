// A catalog refresh must not replace a cut-off sidebar.json or tickets.json.
// The host reads ~/.x-bench, so this file points HOME at a scratch directory before importing it.

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { act, createElement } from "react";
import { installDom } from "../ui/testing/dom.ts";

const home = path.join(os.tmpdir(), `x-bench-json-${process.pid}`);
rmSync(home, { recursive: true, force: true });
mkdirSync(home);
process.env.HOME = home;
for (const name of ["X_BENCH_SAK", "X_BENCH_TRELLO", "X_BENCH_JIRA", "X_BENCH_TICKETS", "GROK_HOME"]) delete process.env[name];

const dom = installDom();
const { createRoot } = await import("react-dom/client");
const { ServiceNotices } = await import("../ui/ServiceNotices.tsx");
const { GrokProvider } = await import("../bridge/grok/provider.ts");
const { createProviders } = await import("./providers/providers.ts");
const { createSessionIndex } = await import("./chat/sessionIndex.ts");
const { createApp } = await import("./app.ts");
const { createDesk } = await import("./desk.ts");
const { createDevices } = await import("./devices/devices.ts");
const { createVoice, modelDir } = await import("./voice/voice.ts");
const paths = (await import("./paths.ts")).xBenchPaths(home);
const { readTickets, writeTickets } = await import("./board/tickets.ts");
const { readSidebar } = await import("./sidebar/sidebar.ts");

test.after(async () => {
  await dom.happyDOM.abort();
  dom.close();
  rmSync(home, { recursive: true, force: true });
});

const PORT = 4321;
const TOKEN = "test-launch-token";

class Recorder extends ServerResponse {
  override end(): this {
    return this;
  }
}

// A request as the page sends it.
async function post(app: { handle: (req: IncomingMessage, res: ServerResponse) => Promise<void> }, url: string, body: unknown) {
  const req = new IncomingMessage(new Socket());
  req.method = "POST";
  req.url = url;
  Object.assign(req.headers, { host: `127.0.0.1:${PORT}`, "x-bench-token": TOKEN, "content-type": "application/json" });
  req.push(JSON.stringify(body));
  req.push(null);
  await app.handle(req, new Recorder(req));
}

function startApp() {
  return createApp({
    ...(() => {
      const grok = new GrokProvider();
      return { grok, providers: createProviders([grok], createSessionIndex(path.join(home, ".x-bench", "sessions.json"))) };
    })(),
    desk: createDesk(),
    voice: createVoice({ modelDir: modelDir(paths.voiceModels) }),
    devices: createDevices(),
    port: PORT,
    token: TOKEN,
    paths,
    cwd: home,
  });
}

test("a cut-off sidebar.json or tickets.json stays untouched after a refresh and the page shows the notice", async () => {
  const uiDir = path.join(home, ".x-bench");
  const sessions = path.join(home, ".grok", "sessions", "group", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  mkdirSync(uiDir, { recursive: true });
  mkdirSync(sessions, { recursive: true });
  const sidebar = path.join(uiDir, "sidebar.json");
  const tickets = path.join(uiDir, "tickets.json");
  // A session in the temp folder does not count, so the project sits outside the scratch home.
  const project = "/work/json-refresh";
  const sidebarCut = "{\"projects\":[";
  const ticketsCut = "{\"bindings\":{";
  writeFileSync(sidebar, sidebarCut);
  writeFileSync(tickets, ticketsCut);
  writeFileSync(path.join(uiDir, "sessions.json"), JSON.stringify({
    sessions: [{ id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", provider: "grok", harnessId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", cwd: project }],
  }));
  writeFileSync(path.join(sessions, "summary.json"), JSON.stringify({
    info: { id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", cwd: project },
    generated_title: "Keep",
    updated_at: "2026-09-28T00:00:00Z",
  }));

  const app = startApp();
  try {
    assert.equal(readFileSync(sidebar, "utf8"), sidebarCut);
    assert.equal(readFileSync(tickets, "utf8"), ticketsCut);
    assert.equal(readFileSync(`${sidebar}.bak`, "utf8"), sidebarCut);
    assert.equal(readFileSync(`${tickets}.bak`, "utf8"), ticketsCut);
    assert.equal(app.store.sidebarState.seenAt["aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"], "2026-09-28T00:00:00Z");

    writeTickets(readTickets(tickets), tickets);
    assert.equal(readFileSync(tickets, "utf8"), ticketsCut);

    const notices = app.store.snapshot.notices.filter((notice) => notice.severity === "error");
    assert.equal(notices.length, 2);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(ServiceNotices, { notices }));
    });
    const text = container.textContent || "";
    assert.match(text, /sidebar\.json/);
    assert.match(text, /sidebar\.json\.bak/);
    assert.match(text, /tickets\.json/);
    assert.match(text, /tickets\.json\.bak/);
    assert.equal(container.querySelectorAll("[data-testid=service-notice]").length, 2);
    root.unmount();

    // Once sidebar.json reads again, the host takes its state and saves from there.
    writeFileSync(sidebar, JSON.stringify({ titles: { kept: "Kept" } }));
    await post(app, "/api/projects/collapsed", { cwd: project, collapsed: true });
    assert.equal(app.store.sidebarState.titles.kept, "Kept");
    const saved = readSidebar(sidebar);
    assert.equal(saved.titles.kept, "Kept");
    assert.equal(saved.seenAt["aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"], "2026-09-28T00:00:00Z");
    const left = app.store.snapshot.notices.filter((notice) => notice.severity === "error");
    assert.deepEqual(left.map((notice) => notice.title), ["Could not read tickets.json"]);
  } finally {
    clearTimeout(app.store.catalogTimer);
  }
});

// Another host (npm run dev next to the app) saves sidebar.json too. A change here starts from the file.
test("a sidebar change keeps what another host saved in the meantime", async () => {
  const sidebar = path.join(home, ".x-bench", "sidebar.json");
  writeFileSync(sidebar, JSON.stringify({ titles: { first: "First" } }));
  const app = startApp();
  try {
    writeFileSync(sidebar, JSON.stringify({ titles: { first: "First", other: "From the other host" } }));
    await post(app, "/api/rename", { sessionId: "mine", title: "Mine" });
    assert.deepEqual(readSidebar(sidebar).titles, { first: "First", other: "From the other host", mine: "Mine" });
  } finally {
    clearTimeout(app.store.catalogTimer);
  }
});
