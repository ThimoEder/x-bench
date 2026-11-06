import { after, test } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { installDom, wait } from "../testing/dom.ts";

const dom = installDom();
const { createRoot } = await import("react-dom/client");
const { RemoteSettings } = await import("./RemoteSettings.tsx");

after(async () => {
  await dom.happyDOM.abort();
  dom.close();
});

const on = (url: string) => ({ enabled: true, tunnel: { state: "on", url, error: "" } });

test("the pairing QR codes go once a tunnel turns off", async () => {
  const urls = ["https://abc.ngrok-free.app/pair#CODE", "https://192.168.1.20:9797/pair#CODE"];
  const view = {
    hasAuthtoken: true,
    domain: "",
    ngrok: on("https://abc.ngrok-free.app"),
    local: on("https://192.168.1.20:9797"),
    devices: [],
    pairing: null as null | { code: string; expiresAt: number; urls: string[] },
  };
  const call = async (path: string, _body?: unknown, method?: string) => {
    if (path === "/api/remote/pairing" && method !== "DELETE") {
      view.pairing = { code: "CODE", expiresAt: Date.now() + 120_000, urls };
      return { ...view.pairing, qrs: ["<svg/>", "<svg/>"] };
    }
    if (path === "/api/remote/enabled") {
      view.ngrok = { enabled: false, tunnel: { state: "off", url: "", error: "" } };
      view.pairing = { code: "CODE", expiresAt: Date.now() + 120_000, urls: [urls[1] ?? ""] };
    }
    return structuredClone(view);
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(RemoteSettings, { call }));
    await wait();
  });
  await act(async () => {
    container.querySelector<HTMLElement>('[data-testid="remote-pair"]')?.click();
    await wait();
  });
  assert.equal(container.querySelectorAll("figcaption").length, 2);
  await act(async () => {
    container.querySelector<HTMLElement>('[data-testid="remote-enabled-ngrok"]')?.click();
    await wait();
  });
  assert.equal(container.querySelectorAll("figcaption").length, 0);
  assert.ok(container.querySelector('[data-testid="remote-pair"]'));
  await act(async () => root.unmount());
});
