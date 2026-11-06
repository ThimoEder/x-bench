// The review rail's hover label. It shows in a child window, since macOS draws that above the window's
// native views (the browser pane and the Unity view), which cover anything the page draws.
import { BrowserWindow, ipcMain } from "electron";
import { sameHostOrigin, viewBounds } from "./browser/browserRules.js";

const height = 26;
// The arrow's rotated square reaches 7px past the label.
const arrow = 7;
const gap = 4;
const tipPage = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<style>
  html, body { margin: 0; background: transparent; overflow: hidden; user-select: none; }
  body { padding-right: ${arrow}px; }
  #tip {
    position: relative;
    display: inline-block;
    box-sizing: border-box;
    height: ${height}px;
    padding: 0 10px;
    border-radius: 7px;
    background: #f2f2f4;
    color: #161618;
    font: 500 12px/${height}px system-ui, -apple-system, sans-serif;
    white-space: nowrap;
  }
  #tip::after {
    content: "";
    position: absolute;
    top: 50%;
    right: -5px;
    width: 10px;
    height: 10px;
    border-radius: 2px;
    background: #f2f2f4;
    transform: translateY(-50%) rotate(45deg);
  }
</style>
<span id="tip"></span>`)}`;

export function createRailTip({ origin }) {
  let window = null;
  let page = null;
  let tip = null;
  // Each label request, so a slow measure never shows a label the pointer already left.
  let ticket = 0;

  function fromPage(event) {
    return Boolean(page) && event.sender === page.webContents && sameHostOrigin(event.sender.getURL(), origin());
  }

  function create() {
    const view = new BrowserWindow({
      parent: window,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      // macOS rounds a window's corners by default, which cuts the label's ends off.
      roundedCorners: false,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      width: 1,
      height,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    view.setIgnoreMouseEvents(true);
    view.loadURL(tipPage).catch(() => {});
    return view;
  }

  function hide() {
    ticket += 1;
    if (tip && !tip.isDestroyed()) tip.hide();
  }

  // text is the label, rect the hovered button in the page's CSS pixels; no text hides the label.
  ipcMain.on("rail:tip", async (event, text, rect) => {
    if (!window || window.isDestroyed() || !fromPage(event)) return;
    const box = viewBounds(rect);
    if (typeof text !== "string" || !text || !box) {
      hide();
      return;
    }
    const shown = ++ticket;
    if (!tip || tip.isDestroyed()) tip = create();
    const width = await tip.webContents
      .executeJavaScript(`(() => { const tip = document.getElementById("tip"); tip.textContent = ${JSON.stringify(text.slice(0, 60))}; return Math.ceil(tip.getBoundingClientRect().width) + ${arrow}; })()`)
      .catch(() => 0);
    if (shown !== ticket || !width || window.isDestroyed()) return;
    // The page measures in CSS pixels, which page zoom scales against the window's points.
    const zoom = page.webContents.getZoomFactor();
    const content = window.getContentBounds();
    tip.setBounds({
      x: Math.round(content.x + box.x * zoom - width - gap),
      y: Math.round(content.y + (box.y + box.height / 2) * zoom - height / 2),
      width,
      height,
    });
    tip.showInactive();
  });

  return {
    attach(next, view) {
      window = next;
      page = view;
      view.webContents.on("did-start-navigation", (event) => {
        if (event.isMainFrame && !event.isSameDocument) hide();
      });
      next.on("blur", hide);
    },
  };
}
