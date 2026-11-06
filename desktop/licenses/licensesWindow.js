// The Open Source Licenses page, and the Chromium credits it links to, each in a window of its own.
import { BrowserWindow, shell } from "electron";
import { route } from "../host.js";

const windows = new Map();

export function openLicensesWindow(url, { origin, backgroundColor }) {
  const open = windows.get(url);
  if (open) {
    open.focus();
    return;
  }
  const window = new BrowserWindow({
    width: 820,
    height: 600,
    minWidth: 560,
    minHeight: 360,
    backgroundColor,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  windows.set(url, window);
  window.on("closed", () => windows.delete(url));
  const contents = window.webContents;
  contents.setWindowOpenHandler(({ url: link }) => {
    const where = route(link, origin);
    if (where === "inside") openLicensesWindow(link, { origin, backgroundColor });
    else if (where === "outside") shell.openExternal(link);
    return { action: "deny" };
  });
  // Chromium's credits link out without target="_blank", so those links arrive here.
  contents.on("will-navigate", (event) => {
    event.preventDefault();
    if (route(event.url, origin) === "outside") shell.openExternal(event.url);
  });
  void window.loadURL(url);
}
