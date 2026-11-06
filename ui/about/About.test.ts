import { after, test } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import pkg from "../../package.json" with { type: "json" };
import { click, installDom, press } from "../testing/dom.ts";

// react-dom checks for a DOM when it loads, so it comes in after installDom.
const dom = installDom();
const { createRoot } = await import("react-dom/client");
const { AboutButton } = await import("./About.tsx");

after(async () => {
  await dom.happyDOM.abort();
  dom.close();
});

test("About opens from its button and closes with Escape, a click outside, or its close button", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(AboutButton)));
  const about = () => document.body.querySelector<HTMLElement>("[data-testid=about]");
  const open = () => act(async () => click(container.querySelector("[data-testid=open-about]")!));

  await open();
  assert.match(about()!.textContent ?? "", new RegExp(`Version ${pkg.version.replaceAll(".", "\\.")}`));
  assert.ok([...about()!.querySelectorAll("a")].every((link) => link.target === "_blank"));
  assert.ok(about()!.querySelector("a[href='https://xbench.dev/privacy.html']"));
  assert.ok(about()!.querySelector("a[href='https://xbench.dev/impressum.html']"));
  await act(async () => click(about()!.querySelector("h2")!));
  assert.ok(about(), "a click inside keeps it open");

  await act(async () => press(document.body, "Escape"));
  assert.equal(about(), null);

  await open();
  await act(async () => click(document.body.querySelector(".sheet-scrim")!));
  assert.equal(about(), null);

  await open();
  await act(async () => click(about()!.querySelector("[aria-label=Close]")!));
  assert.equal(about(), null);

  await act(async () => root.unmount());
  container.remove();
});
