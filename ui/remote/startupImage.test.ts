import assert from "node:assert/strict";
import test from "node:test";
import { addStartupImage, launchSvg } from "./startupImage.ts";

test("the startup image fills the screen in device pixels and centers the logo", () => {
  const svg = launchSvg("dark", 393, 852, 3);
  assert.match(svg, /width="1179" height="2556" viewBox="0 0 393 852"/);
  assert.match(svg, /translate\(136\.5 366\) scale/);
  assert.doesNotMatch(svg, /filter="url\(#shadow\)"/);
});

test("the light startup image uses the light palette and the plate's shadow", () => {
  const svg = launchSvg("light", 375, 667, 2);
  assert.match(svg, /stop-color="#e6e6ea"/);
  assert.match(svg, /<g filter="url\(#shadow\)">/);
});

test("a theme change redraws the one startup image, and a slower earlier draw does not win", async () => {
  const links: { rel: string; href: string }[] = [];
  const loads: (() => void)[] = [];
  const fakes: Record<string, unknown> = {
    navigator: { standalone: false },
    screen: { width: 393, height: 852 },
    devicePixelRatio: 3,
    Image: class {
      onload = () => {};
      src = "";
      constructor() {
        loads.push(() => this.onload());
      }
    },
    document: {
      head: { append: (link: { rel: string; href: string }) => links.push(link) },
      querySelector: () => links[0] ?? null,
      createElement: (tag: string) =>
        tag === "canvas" ? { getContext: () => ({ drawImage: (image: { src: string }) => (drawnSrc = image.src) }), toDataURL: () => drawnSrc } : { rel: "", href: "" },
    },
  };
  let drawnSrc = "";
  const saved = Object.keys(fakes).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const [name, value] of Object.entries(fakes)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  try {
    addStartupImage("dark");
    addStartupImage("dark");
    addStartupImage("light");
    assert.equal(loads.length, 2);
    loads[1]?.();
    loads[0]?.();
    assert.equal(links.length, 1);
    assert.match(decodeURIComponent(links[0]?.href ?? ""), /stop-color="#e6e6ea"/);
  } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
