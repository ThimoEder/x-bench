import assert from "node:assert/strict";
import test from "node:test";
import { badgeBounds, chromeUserAgent, fitScale, paneOwner, paneUrl, parkedBounds, sameHostOrigin, viewBounds, viewportLabel } from "./browserRules.js";

const origin = "http://127.0.0.1:8797";

test("the pane opens http and https pages, and never the app's own host", () => {
  assert.equal(paneUrl("https://example.com", origin), "https://example.com/");
  assert.equal(paneUrl("http://127.0.0.1:5173/", origin), "http://127.0.0.1:5173/", "another local port is a dev server");
  assert.equal(paneUrl("http://127.0.0.1:8797/", origin), null);
  assert.equal(paneUrl("http://localhost:8797/api/events", origin), null);
  assert.equal(paneUrl("file:///etc/passwd", origin), null);
  assert.equal(paneUrl("javascript:alert(1)", origin), null);
  assert.equal(paneUrl("not a url", origin), null);
  assert.equal(sameHostOrigin("http://[::1]:8797/", origin), true);
  assert.equal(sameHostOrigin("http://example.com:8797/", origin), false);
});

test("the page's rectangle is rounded and kept on the window, and anything else hides the pane", () => {
  assert.deepEqual(viewBounds({ x: 840.4, y: 120.6, width: 421.5, height: 710 }), { x: 840, y: 121, width: 422, height: 710 });
  assert.deepEqual(viewBounds({ x: -3, y: 0, width: 10, height: 10 }), { x: 0, y: 0, width: 10, height: 10 });
  assert.equal(viewBounds(null), null);
  assert.equal(viewBounds({ x: 0, y: 0, width: 0, height: 10 }), null);
  assert.equal(viewBounds({ x: "a", y: 0, width: 10, height: 10 }), null);
});

test("a zoomed page's rectangle scales by its zoom factor", () => {
  assert.deepEqual(viewBounds({ x: 700, y: 100, width: 500, height: 600 }, 1.2), { x: 840, y: 120, width: 600, height: 720 });
  assert.deepEqual(viewBounds({ x: 840, y: 120, width: 400, height: 600 }, 0.5), { x: 420, y: 60, width: 200, height: 300 });
  assert.deepEqual(viewBounds({ x: 10, y: 10, width: 10, height: 10 }, Number.NaN), { x: 10, y: 10, width: 10, height: 10 });
});

test("a tab's owner is a chat id", () => {
  assert.equal(paneOwner("0199aa00-1111-7222-8333-444455556666"), "0199aa00-1111-7222-8333-444455556666");
  assert.equal(paneOwner(""), null);
  assert.equal(paneOwner("../x"), null);
  assert.equal(paneOwner(7), null);
});

test("the pane looks like plain Chrome to sites", () => {
  const app = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) XBench/44.4.5 Chrome/152.0.7977.130 Electron/44.4.5 Safari/537.36 X Bench Desktop";
  const plain = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.130 Safari/537.36";
  assert.equal(chromeUserAgent(app), plain);
  assert.equal(chromeUserAgent(app.replace("XBench/44.4.5", "ticket-124-browser/44.4.5")), plain, "a dev app's branch name stays out");
  assert.equal(chromeUserAgent(plain), plain);
});

test("a viewport wider or taller than the pane shrinks to fit it", () => {
  assert.equal(fitScale({ width: 1280, height: 800 }, { width: 640, height: 720 }), 0.5);
  assert.equal(fitScale({ width: 375, height: 812 }, { width: 453, height: 1000 }), 1);
  assert.equal(fitScale(null, { width: 453, height: 720 }), 1);
});

test("the viewport badge sits in the pane's bottom right corner and never outside it", () => {
  assert.deepEqual(badgeBounds({ x: 100, y: 50, width: 1000, height: 590 }, { width: 200, height: 40 }), { x: 898, y: 598, width: 200, height: 40 });
  assert.deepEqual(badgeBounds({ x: 0, y: 0, width: 80, height: 30 }, { width: 200, height: 40 }), { x: 0, y: 0, width: 80, height: 30 });
  assert.equal(badgeBounds(null, { width: 200, height: 40 }), null);
});

test("a tab off screen keeps its size with only its corner pixel in the window", () => {
  assert.deepEqual(parkedBounds({ x: 0, y: 0, width: 1173, height: 1085 }, { width: 389, height: 1033 }), { x: 1172, y: 1084, width: 389, height: 1033 });
  assert.deepEqual(parkedBounds({ x: 0, y: 0, width: 0, height: 0 }, { width: 1280, height: 800 }), { x: 0, y: 0, width: 1280, height: 800 });
});

test("the viewport badge names the page's size, and how far it is shrunk when it is", () => {
  assert.equal(viewportLabel({ width: 1280, height: 800 }, 0.528), "1280×800 · 53%");
  assert.equal(viewportLabel({ width: 375, height: 812 }, 1), "375×812");
});
