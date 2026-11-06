// The Unity tab's Game view: unity_view.node (desktop/unity/unity-view) draws Unity's Syphon server in a Metal
// layer over the page, where the tab reports its rectangle through the preload. Touches and keys go to the
// Pipeline server of the Unity Editor in the shown chat's folder.
import { ipcMain } from "electron";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { sameHostOrigin, viewBounds } from "../browser/browserRules.js";
import { createHeldInput, createInputQueue, findPipeline, readPipeline, serverFor } from "./unityRules.js";

// An Editor paused in a debugger answers nothing, and must not hold up input for the others.
const requestTimeout = 2_000;
const addonPath = fileURLToPath(new URL("unity-view/build/unity_view.node", import.meta.url));

function loadAddon() {
  try {
    return createRequire(import.meta.url)(addonPath);
  } catch (error) {
    console.error(`Unity view: ${error.message}`);
    return null;
  }
}

export function createUnityView({ origin }) {
  const addon = loadAddon();
  let page = null;
  let window = null;
  // Whether the tab is in its full screen mode, and whether it put the window into macOS fullscreen, so
  // leaving only undoes its own.
  let screenMode = false;
  let ownFullScreen = false;
  let timer = null;
  let last = { frames: 0, at: Date.now() };
  // The shown chat's folder while the Unity tab shows, and the Editor found in it.
  let folder = null;
  let target = null;
  const held = createHeldInput();
  // Input was lost, so what it may have pressed goes up once an Editor answers again.
  let letGoOnReturn = false;
  const queue = createInputQueue({
    post: async (to, command, parameters) => {
      const response = await fetch(to.url, {
        method: "POST",
        headers: { authorization: `Bearer ${to.token}`, "content-type": "application/json" },
        body: JSON.stringify({ command, parameters }),
        signal: AbortSignal.timeout(requestTimeout),
      });
      if (!response.ok) throw new Error(`Unity answered ${response.status}`);
    },
    // The Editor quit, reloads its scripts, hangs or refused the input, so it is looked up again on the next tick.
    failed: (to, lost) => {
      for (const item of lost) held.lost(item.command, item.parameters);
      letGoOnReturn = true;
      if (target?.url === to.url) target = null;
    },
  });

  function fromPage(event) {
    return Boolean(page) && event.sender === page.webContents && sameHostOrigin(event.sender.getURL(), origin());
  }

  function send(command, parameters) {
    if (!target) return;
    held.sent(command, parameters);
    queue.push(target, command, parameters);
  }

  // The keys and finger still down go up, for instance when the page goes away without letting go of them.
  function letGo() {
    for (const { command, parameters } of held.release()) send(command, parameters);
  }

  // null while the tab is hidden, so no folder is searched then.
  ipcMain.on("unity:folder", (event, value) => {
    if (!fromPage(event) || (value !== null && typeof value !== "string") || value === folder) return;
    letGo();
    folder = value;
    target = folder ? findPipeline(folder) : null;
  });

  ipcMain.on("unity:pointer", (event, x, y, action) => {
    if (!fromPage(event) || !["move", "down", "up"].includes(action) || !Number.isFinite(x) || !Number.isFinite(y)) return;
    send("xbench_touch", { x, y, action });
  });

  ipcMain.on("unity:key", (event, key, action) => {
    if (!fromPage(event) || typeof key !== "string" || !/^[A-Za-z0-9]{1,16}$/.test(key) || !["down", "up"].includes(action)) return;
    send("simulate_key", { key, action });
  });

  ipcMain.on("unity:fullscreen", (event, flag) => {
    if (!window || window.isDestroyed() || !fromPage(event)) return;
    screenMode = Boolean(flag);
    if (screenMode && !window.isFullScreen()) {
      ownFullScreen = true;
      window.setFullScreen(true);
    } else if (!screenMode && ownFullScreen) {
      ownFullScreen = false;
      window.setFullScreen(false);
    }
  });

  ipcMain.on("unity:bounds", (event, value) => {
    if (!addon || !fromPage(event)) return;
    const bounds = viewBounds(value);
    // The page measures in CSS pixels, which page zoom scales against the window's points.
    const zoom = page.webContents.getZoomFactor();
    if (bounds) addon.setBounds(bounds.x * zoom, bounds.y * zoom, bounds.width * zoom, bounds.height * zoom);
    else addon.setBounds();
  });

  // Once a second the page hears how the view is doing, so a tab opened at any time shows it, and the Editor
  // is looked up again, since it may have started, quit or moved to another port.
  function tick() {
    target = folder ? (target && readPipeline(target.project)) || findPipeline(folder) : null;
    if (target && letGoOnReturn) {
      letGoOnReturn = false;
      letGo();
    }
    if (!page || page.webContents.isDestroyed()) return;
    if (!addon) {
      page.webContents.send("unity:stats", { missing: true });
      return;
    }
    if (!target) addon.disconnect();
    const connected = target ? addon.connect(serverFor(target.project)) : false;
    const stats = addon.stats();
    const now = Date.now();
    const fps = ((stats.frames - last.frames) * 1000) / Math.max(1, now - last.at);
    last = { frames: stats.frames, at: now };
    page.webContents.send("unity:stats", { ...stats, connected, fps, inputMs: queue.ms, project: target?.project ?? null });
  }

  return {
    attach(next, view) {
      page = view;
      window = next;
      // A page that replaces X Bench's, like the error page or a reload, runs none of the tab's cleanup.
      view.webContents.on("did-start-navigation", (event) => {
        if (!event.isMainFrame || event.isSameDocument) return;
        addon?.setBounds();
        letGo();
      });
      view.webContents.on("render-process-gone", () => {
        addon?.setBounds();
        letGo();
      });
      // Leaving macOS fullscreen another way, with the green button or Ctrl-Cmd-F, ends the view's too.
      next.on("leave-full-screen", () => {
        if (!screenMode) return;
        screenMode = false;
        ownFullScreen = false;
        if (!view.webContents.isDestroyed()) view.webContents.send("unity:fullscreen-left");
      });
      next.on("closed", () => {
        clearInterval(timer);
        addon?.setBounds();
        letGo();
      });
      addon?.attach(next.getNativeWindowHandle());
      clearInterval(timer);
      timer = setInterval(tick, 1000);
    },
    stop() {
      clearInterval(timer);
      addon?.disconnect();
    },
  };
}
