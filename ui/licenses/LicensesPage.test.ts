import { after, test } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { click, installDom, press, typeInto } from "../testing/dom.ts";

const dom = installDom();
const { createRoot } = await import("react-dom/client");
const { LicensesPage } = await import("./LicensesPage.tsx");

after(async () => {
  await dom.happyDOM.abort();
  dom.close();
});

const licenses = [
  { name: "Electron", version: "1.0.0", license: "MIT", url: "https://www.electronjs.org", text: "Electron text", credits: "/chromium-licenses.html" },
  { name: "react", version: "19.0.0", license: "MIT", url: "https://react.dev", text: "React text" },
  { name: "sherpa", version: "1.0.0", license: "Apache-2.0", url: "https://example.com", text: "Sherpa text" },
];

test("the page shows a component's license, finds components by name or license, and steps with the arrow keys", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(LicensesPage, { licenses })));
  const detail = () => container.querySelector("[data-testid=license]")!.textContent ?? "";
  const rows = () => [...container.querySelectorAll(".licenses-list button")].map((row) => row.querySelector(".licenses-name")!.textContent);

  assert.match(detail(), /Electron text/);
  assert.ok(container.querySelector("a[href='/chromium-licenses.html']"));

  await act(async () => click(container.querySelectorAll(".licenses-list button")[1]!));
  assert.match(detail(), /React text/);
  assert.equal(container.querySelector("a[href='/chromium-licenses.html']"), null);

  const search = container.querySelector("input")!;
  await act(async () => typeInto(search, "apache"));
  assert.deepEqual(rows(), ["sherpa"]);
  await act(async () => press(search, "ArrowDown"));
  assert.match(detail(), /Sherpa text/);

  await act(async () => typeInto(search, "nothing"));
  assert.match(container.textContent ?? "", /No component matches/);

  await act(async () => typeInto(search, ""));
  await act(async () => click([...container.querySelectorAll(".licenses-chips button")].find((chip) => chip.textContent?.startsWith("Apache"))!));
  assert.deepEqual(rows(), ["sherpa"]);
  await act(async () => root.unmount());
});
