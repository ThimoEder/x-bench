// Rules for the browser pane's URLs and placement. Kept apart from browser.js so they run without Electron.

// The pane opens http(s) pages, never the app's own host, whose page carries the launch token.
export function paneUrl(value, origin) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (sameHostOrigin(url.href, origin)) return null;
  return url.href;
}

// 127.0.0.1 and localhost on the host's port are the same host.
export function sameHostOrigin(value, origin) {
  let url;
  let host;
  try {
    url = new URL(String(value));
    host = new URL(origin);
  } catch {
    return false;
  }
  const local = (name) => name === "127.0.0.1" || name === "localhost" || name === "[::1]";
  return url.port === host.port && local(url.hostname) && local(host.hostname);
}

// The page's rectangle for the pane in window pixels, or null to hide it. The page measures in CSS pixels,
// which a zoomed page scales by its zoom factor.
export function viewBounds(value, zoom = 1) {
  if (typeof value !== "object" || value === null) return null;
  const numbers = ["x", "y", "width", "height"].map((key) => Number(value[key]));
  if (numbers.some((number) => !Number.isFinite(number))) return null;
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const [left, top, w, h] = numbers.map((number) => number * scale);
  const x = Math.round(left);
  const y = Math.round(top);
  const width = Math.round(left + w) - x;
  const height = Math.round(top + h) - y;
  if (width < 1 || height < 1) return null;
  return { x: Math.max(0, x), y: Math.max(0, y), width, height };
}

// The pane's user agent: Chrome's own, without the Electron, app and X Bench marks. Some sites refuse
// browsers that name Electron, and an X Bench page in the pane must not take itself for the desktop app.
export function chromeUserAgent(value) {
  return String(value)
    .replace(/\s+X Bench Desktop\b/g, "")
    .replace(/\s+Electron\/\S+/g, "")
    // The app's own product token, like XBench/44.4.5 or a dev app's branch name, sits right before Chrome's.
    .replace(/(\(KHTML, like Gecko\))(?:\s+(?!Chrome\/)\S+\/\S+)+(?=\s+Chrome\/)/, "$1")
    .trim();
}

// How much a viewport the agent asked for shrinks to fit the room the pane has. 1 when it fits.
export function fitScale(viewport, room) {
  if (!viewport || !room || room.width < 1 || room.height < 1) return 1;
  return Math.min(1, room.width / viewport.width, room.height / viewport.height);
}

// A chat id as the page and the host name it, or null.
export function paneOwner(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null;
}

// The viewport badge sits in the pane's bottom right corner, cut to the pane.
export function badgeBounds(bounds, size, inset = 2) {
  if (!bounds) return null;
  const width = Math.min(size.width, bounds.width);
  const height = Math.min(size.height, bounds.height);
  return {
    x: Math.max(bounds.x, bounds.x + bounds.width - width - inset),
    y: Math.max(bounds.y, bounds.y + bounds.height - height - inset),
    width,
    height,
  };
}

// A tab off screen keeps its size with one pixel in the window's bottom right corner. macOS gives the mouse to
// a web view under the page, and one wholly outside the window lays out at 0×0 and stops painting.
export function parkedBounds(window, size) {
  return { x: Math.max(0, window.width - 1), y: Math.max(0, window.height - 1), width: size.width, height: size.height };
}

// What the viewport badge says: the size the page lays out at, and how far it is shrunk to fit the pane.
export function viewportLabel(viewport, scale) {
  const size = `${viewport.width}×${viewport.height}`;
  return scale < 1 ? `${size} · ${Math.round(scale * 100)}%` : size;
}
