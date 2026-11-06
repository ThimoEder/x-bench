// The browser pane: web pages in WebContentsViews over the window, in a partition of their
// own, so they share no cookies or logins with the app. Each tab belongs to one chat, and each chat has its
// own current tab. The page places the pane and names the chat it shows through the preload
// (desktop/preload.cjs). The host drives it over a WebSocket link (server/browser/browser.ts): the app connects
// to the host and answers its calls, and sends the tabs whenever they change.
import { app, ipcMain, session, WebContentsView } from "electron";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { tokenPath } from "../host.js";
import { badgeBounds, chromeUserAgent, fitScale, paneOwner, paneUrl, parkedBounds, sameHostOrigin, viewBounds, viewportLabel } from "./browserRules.js";

const partition = "persist:x-bench-browser";
// The board's own site. Its storage holds the board's login, so it gets a partition the chats' tabs, and
// with them the agents, never load in, and no network log.
const boardOwner = "board";
const boardPartition = "persist:x-bench-board";
const loadTimeout = 15_000;
const relinkDelay = 1_000;
// Each tab keeps its latest console messages and network requests for the agent to read.
const keptMessages = 500;
const keptRequests = 300;
const keptPayload = 64_000;
const keptText = 4_000;
// The host's WebSocket refuses frames over 8 MB, and a refused frame closes the link for every chat.
const maxReply = 7_000_000;
const maxBody = 1_000_000;
// One chat's tabs. Pages that keep opening windows stop getting new tabs here.
const maxTabsPerChat = 12;
// open waits for the page at most this long, under the host's 30 second call limit.
const openTimeout = 20_000;
// A tab lays out at this size until the pane has been shown once.
const firstSize = { width: 1280, height: 800 };
// A tab off screen stays awake this long after an agent call on it.
const wakeMs = 1_000;
const badgePage = fileURLToPath(new URL("viewportBadge.html", import.meta.url));
const badgePreload = fileURLToPath(new URL("viewportBadge.cjs", import.meta.url));

// origin is the host the app talks to. X Bench Dev can move to another port, so relink takes the new one.
export function createBrowserPane({ origin: firstOrigin, home }) {
  let origin = firstOrigin;
  let window = null;
  // The view holding X Bench's page in that window.
  let page = null;
  let tabs = [];
  // Each chat's current tab.
  const active = new Map();
  let nextTab = 1;
  let bounds = null;
  let zoom = 1;
  // The page can't clip a native view, so the view takes the corners the page gives its slot.
  let radius = 0;
  // The chat whose tabs the page shows.
  let shown = null;
  let size = firstSize;
  // The viewport badge's view, made the first time a tab with a size of its own shows, its size as the badge
  // reports it, and whether it is on the window.
  let badge = null;
  let badgeSize = { width: 200, height: 40 };
  let badgeShown = false;
  let link = null;
  let linkTimer = null;
  let stateTimer = null;
  let stopped = false;

  for (const name of [partition, boardPartition]) {
    const pages = session.fromPartition(name);
    // Pages get no camera, microphone, location or notifications, and downloads are dropped.
    pages.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    pages.setPermissionCheckHandler(() => false);
    pages.on("will-download", (event) => event.preventDefault());
    pages.setUserAgent(chromeUserAgent(app.userAgentFallback));
    // The app's own host never loads in the pane, not even in a frame or as a resource: its page carries the
    // launch token, which the agent could read through the network tool.
    pages.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
      callback({ cancel: sameHostOrigin(details.url, origin) });
    });
  }

  // Only X Bench's own page places the pane. The error page and a page on its way out send nothing.
  ipcMain.on("browser:bounds", (event, value, owner) => {
    if (!page || event.sender !== page.webContents || !sameHostOrigin(event.sender.getURL(), origin)) return;
    zoom = page.webContents.getZoomFactor();
    bounds = viewBounds(value, zoom);
    radius = Math.max(0, Number(value?.radius) || 0);
    shown = paneOwner(owner);
    place();
  });

  // A capture of the shown tab, with the rectangle it fills in page pixels.
  ipcMain.handle("browser:freeze", async (event) => {
    const tab = frontTab();
    if (!page || event.sender !== page.webContents || !sameHostOrigin(event.sender.getURL(), origin) || !tab || !bounds) return null;
    const placed = bounds;
    const image = await tab.view.webContents.capturePage();
    if (image.isEmpty()) return null;
    const src = `data:image/jpeg;base64,${image.toJPEG(95).toString("base64")}`;
    return { src, x: placed.x / zoom, y: placed.y / zoom, width: placed.width / zoom, height: placed.height / zoom };
  });

  ipcMain.on("browser:viewport-badge-size", (event, width, height) => {
    if (!badge || event.sender !== badge.webContents) return;
    if (!Number.isFinite(width) || !Number.isFinite(height)) return;
    badgeSize = { width: Math.min(400, Math.max(1, Math.round(width))), height: Math.min(80, Math.max(1, Math.round(height))) };
    placeBadge();
  });

  ipcMain.on("browser:viewport-fit", (event) => {
    const tab = frontTab();
    if (!badge || event.sender !== badge.webContents || !tab?.viewport) return;
    clearViewport(tab).catch(() => {});
  });

  function frontTab() {
    return bounds && shown ? tabs.find((tab) => tab.id === active.get(shown)) : undefined;
  }

  function createBadge() {
    const view = new WebContentsView({
      webPreferences: { preload: badgePreload, contextIsolation: true, nodeIntegration: false, sandbox: true, navigateOnDragDrop: false },
    });
    view.setBackgroundColor("#00000000");
    const contents = view.webContents;
    contents.on("will-navigate", (event) => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("did-finish-load", placeBadge);
    contents.loadFile(badgePage).catch(() => {});
    return view;
  }

  // The badge shows over the pane's corner while the shown tab lays out at a size the agent set.
  function placeBadge() {
    if (!window || window.isDestroyed()) return;
    const tab = frontTab();
    if (tab?.viewport) {
      badge ??= createBadge();
      badge.setBounds(badgeBounds(bounds, badgeSize));
      window.contentView.addChildView(badge);
      badgeShown = true;
      badge.webContents.send("browser:viewport-label", viewportLabel(tab.viewport, fitScale(tab.viewport, size)));
    } else if (badgeShown) {
      window.contentView.removeChildView(badge);
      badgeShown = false;
    }
  }

  async function clearViewport(tab) {
    tab.viewport = null;
    tab.viewportScale = undefined;
    placeBadge();
    sendState();
    await cdp(tab, "Emulation.clearDeviceMetricsOverride");
  }

  function tabState(tab) {
    const contents = tab.view.webContents;
    return {
      id: tab.id,
      owner: tab.owner,
      url: contents.getURL(),
      title: contents.getTitle(),
      loading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      // A viewport shrunk to fit the pane takes mouse input in the shrunk view's pixels.
      inputScale: tab.viewport ? (tab.viewportScale ?? 1) : 1,
    };
  }

  function sendState() {
    clearTimeout(stateTimer);
    stateTimer = setTimeout(flushState, 50);
  }

  function flushState() {
    clearTimeout(stateTimer);
    send({ type: "state", tabs: tabs.map(tabState), active: Object.fromEntries(active) });
  }

  function send(message) {
    if (link && link.readyState === WebSocket.OPEN) link.send(JSON.stringify(message));
  }

  // The shown chat's current tab draws over the page where the page asked. Every other tab sits hidden beneath
  // the page at the pane's last size, so Chrome throttles it and it stops painting while its layout stays. A
  // view outside the window lays out at 0×0, which leaves the agent's reads of it empty.
  function place() {
    if (!window || window.isDestroyed()) return;
    const root = window.contentView;
    if (bounds) size = { width: bounds.width, height: bounds.height };
    const front = frontTab();
    const parked = parkedBounds(window.getContentBounds(), size);
    for (const tab of tabs) {
      const visible = tab === front;
      tab.view.setBounds(visible ? bounds : parked);
      if (tab.owner !== boardOwner) tab.view.setBorderRadius(Math.round(radius * zoom));
      tab.view.setVisible(visible || tab.woken);
      if (visible) root.addChildView(tab.view);
      else root.addChildView(tab.view, 0);
      if (tab.viewport) fitViewport(tab).catch(() => {});
    }
    placeBadge();
  }

  // A viewport the agent asked for lays out at its own size, and the person sees it shrunk to fit the pane.
  // The shrink applies to the drawn image only, so captures and the agent's coordinates keep the full size.
  async function fitViewport(tab) {
    const scale = Math.round(fitScale(tab.viewport, size) * 1000) / 1000;
    if (scale === tab.viewportScale) return;
    tab.viewportScale = scale;
    await cdp(tab, "Emulation.setDeviceMetricsOverride", { ...tab.viewport, deviceScaleFactor: 0, scale });
    sendState();
  }

  function findTab(id) {
    const tab = tabs.find((item) => item.id === Number(id));
    if (!tab) throw new Error("That tab is closed.");
    return tab;
  }

  function createTab(owner) {
    const board = owner === boardOwner;
    const view = new WebContentsView({
      webPreferences: { partition: board ? boardPartition : partition, contextIsolation: true, nodeIntegration: false, sandbox: true, navigateOnDragDrop: false },
    });
    view.setBackgroundColor("#ffffff");
    const tab = { id: nextTab++, owner, view, messages: [], requests: new Map(), calls: 0, woken: false, sleepTimer: undefined };
    const contents = view.webContents;
    contents.on("console-message", (details) => {
      tab.messages.push({ level: details.level, text: String(details.message).slice(0, keptText), source: details.sourceId, line: details.lineNumber, at: Date.now() });
      if (tab.messages.length > keptMessages) tab.messages.splice(0, tab.messages.length - keptMessages);
    });
    if (!board) watchNetwork(tab);
    // A page that asks for a new window gets a new tab of the same chat, up to the cap. Only http(s) opens.
    // The board's site opens new windows in its own tab, since the board's view shows only one.
    contents.setWindowOpenHandler(({ url }) => {
      const target = paneUrl(url, origin);
      const room = tabs.filter((item) => item.owner === owner).length < maxTabsPerChat;
      if (target && board) contents.loadURL(target).catch(() => {});
      else if (target && room) openTab(target, owner, true).catch(() => {});
      return { action: "deny" };
    });
    const guard = (event) => {
      if (!paneUrl(event.url, origin)) event.preventDefault();
    };
    contents.on("will-navigate", guard);
    contents.on("will-redirect", guard);
    for (const name of ["did-start-loading", "did-stop-loading", "did-navigate", "did-navigate-in-page", "page-title-updated"]) {
      contents.on(name, sendState);
    }
    contents.on("render-process-gone", sendState);
    tabs.push(tab);
    return tab;
  }

  // The debugger stays attached from the start, so requests made while the page loads are seen too.
  function watchNetwork(tab) {
    const dbg = tab.view.webContents.debugger;
    try {
      dbg.attach("1.3");
    } catch {
      return;
    }
    dbg.sendCommand("Network.enable").catch(() => {});
    dbg.on("message", (_event, method, params) => {
      const entry = tab.requests.get(params?.requestId);
      if (method === "Network.requestWillBeSent") {
        tab.requests.delete(params.requestId);
        tab.requests.set(params.requestId, {
          id: params.requestId,
          method: params.request?.method ?? "",
          url: params.request?.url ?? "",
          type: params.type ?? "",
          status: null,
          statusText: "",
          mimeType: "",
          failed: "",
          requestHeaders: params.request?.headers ?? {},
          postData: typeof params.request?.postData === "string" ? params.request.postData.slice(0, keptPayload) : null,
          hasPostData: params.request?.hasPostData === true,
          responseHeaders: {},
          at: Date.now(),
        });
        if (tab.requests.size > keptRequests) tab.requests.delete(tab.requests.keys().next().value);
      } else if (method === "Network.responseReceived" && entry) {
        entry.status = params.response?.status ?? null;
        entry.statusText = params.response?.statusText ?? "";
        entry.mimeType = params.response?.mimeType ?? "";
        entry.responseHeaders = params.response?.headers ?? {};
      } else if (method === "Network.loadingFailed" && entry) {
        entry.failed = params.errorText || "failed";
      }
    });
  }

  function closeTab(tab) {
    tabs = tabs.filter((item) => item !== tab);
    clearTimeout(tab.sleepTimer);
    if (window && !window.isDestroyed()) window.contentView.removeChildView(tab.view);
    try {
      if (tab.view.webContents.debugger.isAttached()) tab.view.webContents.debugger.detach();
    } catch {
      // Already detached.
    }
    tab.view.webContents.close();
    if (active.get(tab.owner) === tab.id) {
      const next = tabs.filter((item) => item.owner === tab.owner).at(-1);
      if (next) active.set(tab.owner, next.id);
      else active.delete(tab.owner);
    }
    place();
    sendState();
  }

  function settled(contents, timeoutMs = loadTimeout) {
    if (!contents.isLoading()) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        contents.off("did-stop-loading", done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      contents.on("did-stop-loading", done);
    });
  }

  // A chat's page opens in its current tab, or in a new one when asked or when the chat has none.
  async function openTab(url, owner, newTab, wait = true) {
    const target = paneUrl(url, origin);
    if (!target) throw new Error(sameHostOrigin(url, origin) ? "The pane does not open X Bench's own host." : `Cannot open ${url}`);
    const current = tabs.find((item) => item.id === active.get(owner));
    const created = newTab || !current;
    const tab = created ? createTab(owner) : current;
    active.set(owner, tab.id);
    place();
    sendState();
    const loading = tab.view.webContents.loadURL(target).catch(() => {});
    if (wait) {
      const started = Date.now();
      await Promise.race([loading, new Promise((resolve) => { setTimeout(resolve, openTimeout); })]);
      await settled(tab.view.webContents, Math.max(0, openTimeout - (Date.now() - started)));
    }
    sendState();
    return { tab: tab.id, created };
  }

  // A hidden tab paints no frames, so a capture of it never returns. An agent call shows it beneath the page
  // until wakeMs after the last call ends, unthrottled, so it also runs while the window is minimized.
  async function awake(tab, run) {
    tab.calls += 1;
    tab.woken = true;
    clearTimeout(tab.sleepTimer);
    tab.view.webContents.setBackgroundThrottling(false);
    tab.view.setVisible(true);
    try {
      return await run();
    } finally {
      tab.calls -= 1;
      if (!tab.calls) {
        tab.sleepTimer = setTimeout(() => {
          tab.woken = false;
          if (!tab.view.webContents.isDestroyed()) tab.view.webContents.setBackgroundThrottling(true);
          tab.view.setVisible(tab === frontTab());
        }, wakeMs);
      }
    }
  }

  async function cdp(tab, method, params) {
    const dbg = tab.view.webContents.debugger;
    if (!dbg.isAttached()) dbg.attach("1.3");
    return dbg.sendCommand(method, params ?? {});
  }

  // The visible part of a tab as a JPEG, one image pixel per CSS pixel, shrunk to at most maxWidth wide. A
  // clip is in page coordinates, so it starts at the scroll position, and the image comes out at the clip
  // size times its scale times the screen's pixel ratio.
  // Chrome's metrics, which a page's own script cannot change.
  async function capture(tab, maxWidth, quality) {
    const metrics = await cdp(tab, "Page.getLayoutMetrics");
    const css = metrics.cssVisualViewport ?? {};
    const width = Math.min(8000, Math.max(1, Math.round(css.clientWidth ?? 0)));
    const height = Math.min(8000, Math.max(1, Math.round(css.clientHeight ?? 0)));
    const x = Math.max(0, Number(css.pageX) || 0);
    const y = Math.max(0, Number(css.pageY) || 0);
    const ratio = Number(metrics.visualViewport?.clientWidth) / Number(css.clientWidth) || 1;
    const scale = Math.min(1, maxWidth / width);
    const shot = await cdp(tab, "Page.captureScreenshot", {
      format: "jpeg",
      quality,
      clip: { x, y, width, height, scale: scale / ratio },
      fromSurface: true,
      captureBeyondViewport: false,
    });
    return { data: shot.data ?? "", width: Math.round(width * scale), height: Math.round(height * scale), pageWidth: width, pageHeight: height };
  }

  const ops = {
    open: ({ url, owner, newTab, wait }) => {
      const chat = paneOwner(owner);
      if (!chat || chat === boardOwner) throw new Error("Name the chat the page opens for.");
      return openTab(String(url ?? ""), chat, newTab === true, wait !== false);
    },
    // A page of the board's own site in the board's tab, signed in. A site reads its login as it starts, so
    // the storage items go in from a page of the same origin before the asked page loads.
    openBoardPage: async ({ url, storage }) => {
      const target = paneUrl(String(url ?? ""), origin);
      const from = paneUrl(String(storage?.from ?? ""), origin);
      const items = Object.entries(storage?.items ?? {}).filter(([, value]) => typeof value === "string");
      if (!target || !from || new URL(from).origin !== new URL(target).origin) throw new Error("Give the page and a page of its site to sign in from.");
      const current = tabs.find((item) => item.id === active.get(boardOwner));
      const tab = current ?? createTab(boardOwner);
      active.set(boardOwner, tab.id);
      place();
      const contents = tab.view.webContents;
      const site = new URL(target).origin;
      await contents.loadURL(from).catch(() => {});
      // The write checks where it runs: a redirect or a failed load leaves the tab on another site.
      const stored = await contents.executeJavaScript(
        `location.origin === ${JSON.stringify(site)} && (${JSON.stringify(items)}.forEach(([key, value]) => localStorage.setItem(key, value)), true)`,
      );
      if (stored !== true) throw new Error("The board's site did not load.");
      contents.loadURL(target).catch(() => {});
      sendState();
      return { owner: boardOwner };
    },
    back: ({ tab }) => go(findTab(tab), (history) => history.goBack()),
    forward: ({ tab }) => go(findTab(tab), (history) => history.goForward()),
    reload: ({ tab }) => go(findTab(tab), (_history, contents) => contents.reload()),
    stop: ({ tab }) => {
      findTab(tab).view.webContents.stop();
      return {};
    },
    switch: ({ tab }) => {
      const found = findTab(tab);
      active.set(found.owner, found.id);
      place();
      sendState();
      return {};
    },
    close: ({ tab }) => {
      closeTab(findTab(tab));
      return {};
    },
    closeOwner: ({ owner }) => {
      for (const tab of tabs.filter((item) => item.owner === owner)) closeTab(tab);
      return {};
    },
    wait: async ({ tab, timeoutMs }) => {
      await settled(findTab(tab).view.webContents, Math.min(Number(timeoutMs) || loadTimeout, loadTimeout));
      return {};
    },
    cdp: async ({ tab, method, params }) => {
      const found = findTab(tab);
      return trimmed(String(method), await awake(found, () => cdp(found, String(method), params)));
    },
    console: ({ tab, clear }) => {
      const found = findTab(tab);
      const messages = found.messages;
      if (clear) found.messages = [];
      return { messages };
    },
    network: ({ tab, clear }) => {
      const found = findTab(tab);
      const requests = [...found.requests.values()].map(({ id, method, url, type, status, mimeType, failed, at }) => ({ id, method, url, type, status, mimeType, failed, at }));
      if (clear) found.requests.clear();
      return { requests };
    },
    // One request with its headers and payload. A payload too large for the event is asked for separately.
    request: async ({ tab, id }) => {
      const found = findTab(tab);
      const entry = found.requests.get(String(id));
      if (!entry) throw new Error(`The tab has no request ${id}. List the requests again.`);
      if (entry.hasPostData && entry.postData === null) {
        const posted = await cdp(found, "Network.getRequestPostData", { requestId: entry.id }).catch(() => null);
        if (typeof posted?.postData === "string") entry.postData = posted.postData.slice(0, keptPayload);
      }
      return { request: entry };
    },
    capture: ({ tab, maxWidth, quality }) => {
      const found = findTab(tab);
      return awake(found, () => capture(found, Number(maxWidth) || 1280, Number(quality) || 70));
    },
    viewport: async ({ tab, width, height, mobile }) => {
      const found = findTab(tab);
      if (!width) {
        await clearViewport(found);
        return {};
      }
      found.viewportScale = undefined;
      found.viewport = { width: Number(width), height: Number(height), mobile: mobile === true };
      placeBadge();
      await fitViewport(found);
      return {};
    },
  };

  async function go(tab, move) {
    const contents = tab.view.webContents;
    move(contents.navigationHistory, contents);
    await new Promise((resolve) => { setTimeout(resolve, 100); });
    await settled(contents);
    sendState();
    return {};
  }

  // A reply goes back on the socket its call came on. A host that restarted meanwhile numbers its calls anew.
  async function answer(message, socket) {
    const reply = (body) => {
      if (socket === link && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "reply", id: message.id, ...body }));
    };
    const op = ops[message.op];
    try {
      if (!op) throw new Error(`Unknown browser call: ${message.op}`);
      const result = await op(message.args ?? {});
      const size = Buffer.byteLength(JSON.stringify(result ?? null));
      if (size > maxReply) throw new Error(`The result is too large to send (${Math.round(size / 1_000_000)} MB).`);
      // The host reads the tabs as soon as the reply arrives.
      flushState();
      reply({ result });
    } catch (error) {
      reply({ error: error instanceof Error ? error.message : String(error) });
    }
  }

  // The host writes a new token on every start, so each try reads it again.
  function connect() {
    clearTimeout(linkTimer);
    if (stopped) return;
    let token = "";
    try {
      token = fs.readFileSync(tokenPath(portOf(origin), home), "utf8").trim();
    } catch {
      linkTimer = setTimeout(connect, relinkDelay);
      return;
    }
    const socket = new WebSocket(`ws://127.0.0.1:${portOf(origin)}/api/browser/link?token=${encodeURIComponent(token)}`);
    link = socket;
    socket.addEventListener("open", flushState);
    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message?.type === "call") answer(message, socket);
    });
    socket.addEventListener("close", () => {
      if (link !== socket) return;
      link = null;
      linkTimer = setTimeout(connect, relinkDelay);
    });
    socket.addEventListener("error", () => {});
  }

  return {
    // The window the pane draws in. A new window (macOS reopens one from the Dock) takes the tabs along.
    attach(next, nextPage) {
      if (window && !window.isDestroyed()) {
        for (const tab of tabs) window.contentView.removeChildView(tab.view);
        if (badgeShown) window.contentView.removeChildView(badge);
      }
      badgeShown = false;
      window = next;
      page = nextPage;
      bounds = null;
      place();
      next.on("resize", () => {
        if (window === next) place();
      });
      next.on("closed", () => {
        if (window === next) window = null;
      });
    },
    connect,
    // The host started listening, maybe on another port: link to it right away.
    relink(nextOrigin = origin) {
      origin = nextOrigin;
      if (link) link.close();
      else connect();
    },
    // Off the window until the page places it again, as while the error page shows.
    hide() {
      bounds = null;
      place();
    },
    stop() {
      stopped = true;
      clearTimeout(linkTimer);
      if (link) link.close();
    },
  };
}

function portOf(origin) {
  return Number(new URL(origin).port);
}

// Chrome's results cut down to what the host reads, so a big page stays under the link's frame size.
function trimmed(method, result) {
  if (method === "Accessibility.getFullAXTree" && Array.isArray(result?.nodes)) {
    return {
      nodes: result.nodes.map((node) => ({
        nodeId: node.nodeId,
        ...(node.ignored ? { ignored: true } : {}),
        role: { value: node.role?.value },
        ...(node.name?.value ? { name: { value: String(node.name.value).slice(0, 600) } } : {}),
        ...(node.value?.value !== undefined ? { value: { value: String(node.value.value).slice(0, 300) } } : {}),
        ...(node.properties?.length ? { properties: node.properties.filter((item) => ["level", "checked", "selected", "expanded", "pressed", "disabled"].includes(item.name)) } : {}),
        ...(node.childIds?.length ? { childIds: node.childIds } : {}),
        ...(node.backendDOMNodeId ? { backendDOMNodeId: node.backendDOMNodeId } : {}),
      })),
    };
  }
  if (method === "Network.getResponseBody" && typeof result?.body === "string" && result.body.length > maxBody) {
    return { ...result, body: result.body.slice(0, maxBody - (maxBody % 4)), truncated: true };
  }
  return result;
}
