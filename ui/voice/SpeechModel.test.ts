import { after, test } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { click, installDom, wait } from "../testing/dom.ts";
import type { VoiceStatus } from "../../server/voice/voice.ts";

const dom = installDom();
const { createRoot } = await import("react-dom/client");
const { SpeechModel, SpeechModelSetting } = await import("./SpeechModel.tsx");
const { closeSpeechModel, openSpeechModel } = await import("./speechModel.ts");

let host: VoiceStatus = { state: "missing", received: 0, total: 0, size: 0, error: null };
const requests: string[] = [];
let failNext = false;
globalThis.fetch = async (input, init) => {
  const method = init?.method || "GET";
  requests.push(`${method} ${String(input)}`);
  if (failNext) {
    failNext = false;
    throw new TypeError("Failed to fetch");
  }
  if (method !== "GET" && new Headers(init?.headers).get("content-type") !== "application/json") return Response.json({ error: "Send application/json" }, { status: 415 });
  if (method === "DELETE") return Response.json({ error: "The speech model is in use. Try again when it is done." }, { status: 409 });
  if (String(input) === "/api/voice/download") host = { ...host, state: "downloading", received: 116e6, total: 465e6 };
  return Response.json(host);
};

after(async () => {
  await dom.happyDOM.abort();
  dom.close();
});

function dialog() {
  return document.querySelector('[data-testid="speech-model"]');
}

test("the overlay asks, shows the download, and closes once the model is ready", async () => {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root.render(createElement(SpeechModel)));
  assert.equal(dialog(), null);

  await act(async () => {
    openSpeechModel();
    await wait(10);
  });
  assert.match(dialog()?.textContent || "", /465 MB to download/);
  assert.ok(!requests.some((request) => request.startsWith("POST")));

  await act(async () => {
    click(document.querySelector('[data-testid="speech-download"]')!);
    await wait(10);
  });
  assert.ok(requests.includes("POST /api/voice/download"));
  assert.match(document.querySelector('[data-testid="speech-progress"]')?.textContent || "", /116 MB of 465 MB/);

  failNext = true;
  await act(async () => wait(600));
  host = { state: "ready", received: 0, total: 0, size: 640e6, error: null };
  await act(async () => wait(600));
  assert.equal(dialog(), null);

  await act(async () => root.unmount());
});

test("the settings row shows the model on disk and the host's refusal to remove it", async () => {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => {
    root.render(createElement(SpeechModelSetting));
    await wait(10);
  });
  const row = () => document.querySelector('[data-testid="speech-model-setting"]')?.parentElement?.textContent || "";
  assert.match(row(), /Ready, 640 MB on disk/);
  await act(async () => {
    click(document.querySelector('[data-testid="speech-remove"]')!);
    await wait(10);
  });
  assert.ok(requests.includes("DELETE /api/voice"));
  assert.match(document.querySelector('[role="alert"]')?.textContent || "", /in use/);
  await act(async () => {
    closeSpeechModel();
    root.unmount();
  });
});

test("a model that failed to load offers Remove beside Retry in Settings", async () => {
  host = { state: "error", received: 0, total: 0, size: 0, error: "bad weights" };
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => {
    root.render(createElement(SpeechModelSetting));
    await wait(10);
  });
  const buttons = [...document.querySelectorAll('[data-testid="speech-model-setting"] button')].map((button) => button.textContent);
  assert.deepEqual(buttons, ["Remove", "Retry"]);
  await act(async () => root.unmount());
});
