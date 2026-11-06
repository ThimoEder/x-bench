import { after, test } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { click, installDom, press } from "../testing/dom.ts";
import type { BoardLabel } from "./boardData.ts";

// react-dom checks for a DOM when it loads, so it comes in after installDom.
const dom = installDom();
const { createRoot } = await import("react-dom/client");
const { LabelPicker } = await import("./LabelPicker.tsx");

after(async () => {
  await dom.happyDOM.abort();
  dom.close();
});

const menu = () => document.querySelector('[role="menu"][aria-label="Labels"]');
const items = () => [...document.querySelectorAll('[role="menuitemcheckbox"]')];

test("the label menu lists the board's labels, checks the picked ones, stays open on a pick, and hands over to Manage", async () => {
  const toggles: [unknown, boolean][] = [];
  let managed = 0;
  const labels: BoardLabel[] = [{ id: 1, title: "bug", color: "#eb5a46" }, { id: 2, title: "idea", color: null }];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(LabelPicker, {
        labels,
        picked: new Set(["1"]),
        onToggle: (label: BoardLabel, on: boolean) => toggles.push([label.id, on]),
        onManage: () => {
          managed += 1;
        },
      }),
    ),
  );
  try {
    const pill = container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
    act(() => click(pill));
    assert.ok(menu(), "the menu opens on the page");
    assert.equal(container.contains(menu()), false, "the menu hangs outside the pill's container");
    assert.deepEqual(items().map((item) => [item.textContent, item.getAttribute("aria-checked")]), [["bug", "true"], ["idea", "false"]]);

    act(() => click(items()[1]!));
    act(() => click(items()[0]!));
    assert.deepEqual(toggles, [[2, true], [1, false]]);
    assert.ok(menu(), "a pick leaves the menu open");

    act(() => click([...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent?.includes("Manage labels"))!));
    assert.equal(managed, 1);
    assert.equal(menu(), null);

    act(() => click(pill));
    act(() => press(document.body, "Escape"));
    assert.equal(menu(), null, "Esc closes the menu");
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
