// The app's updater: electron-updater on the feed named under publish in electron-builder.json, installing through
// Squirrel.Mac. The page asks through the preload and sees each step through "update:state".
import { app, ipcMain, autoUpdater as squirrel } from "electron";
import electronUpdater from "electron-updater";
import fs from "node:fs";
import { sameHostOrigin } from "../browser/browserRules.js";
import { UpdateError, appBundle, copyName, noteSections } from "./updateRules.js";

const { autoUpdater } = electronUpdater;
const OFFLINE = "Couldn't check for updates. Check your connection and try again.";
const DAMAGED = "The update did not pass its checks. Nothing was changed.";
const STOPPED = "The download stopped. Check your connection and try again.";
const FIRST_CHECK_MS = 30_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
// app.getVersion() is Electron's own version when X Bench Dev runs main.js from a checkout.
const VERSION = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;

export function createUpdater({ origin }) {
  let page = null;
  let state = { phase: "idle" };
  let release = null;
  autoUpdater.autoDownload = false;
  // Blanks the random install ID that electron-updater keeps in <userData>/.updaterId and otherwise sends to the feed.
  autoUpdater.requestHeaders = { "x-user-staging-id": "" };

  function publish(value) {
    state = { ...value, version: VERSION };
    if (page && !page.webContents.isDestroyed()) page.webContents.send("update:state", state);
  }

  function fromPage(event) {
    return Boolean(page) && event.sender === page.webContents && sameHostOrigin(event.sender.getURL(), origin());
  }

  async function check(quiet = false) {
    // The feed's X Bench build would replace a copy's name, icon and settings.
    const copy = copyName();
    if (copy) {
      publish({ phase: "error", error: `${copy} does not update itself. Install the update in X Bench, then make the copy again.` });
      return;
    }
    if (!app.isPackaged) {
      publish({ phase: "error", error: "X Bench Dev does not update itself. Install the update in X Bench." });
      return;
    }
    if (!quiet) publish({ phase: "checking" });
    try {
      // Overlapping checks share one request, so a check the gear starts during a quiet one gets the same answer.
      const result = await autoUpdater.checkForUpdates();
      if (!result?.isUpdateAvailable) {
        publish({ phase: "current" });
        return;
      }
      const { version, files, releaseNotes, releaseNotesGrouped } = result.updateInfo;
      const notes = noteSections(typeof releaseNotesGrouped === "string" ? releaseNotesGrouped : typeof releaseNotes === "string" ? releaseNotes : "");
      release = { version, size: files.find((file) => file.url.endsWith(".zip"))?.size ?? 0, notes };
      publish({ phase: "available", release });
    } catch {
      if (!quiet) publish({ phase: "error", error: OFFLINE });
    }
  }

  async function install() {
    if (!appBundle(app.getPath("exe"))) throw new UpdateError("Move X Bench to the Applications folder, then try again.");
    publish({ phase: "downloading", progress: 0, release });
    await autoUpdater.downloadUpdate();
  }

  autoUpdater.on("download-progress", ({ percent }) => {
    const progress = Math.min(99, Math.floor(percent));
    if (state.phase === "downloading" && progress !== state.progress) publish({ phase: "downloading", progress, release });
  });
  // The zip matched the feed's sha512, and Squirrel.Mac now checks that our team signed it.
  autoUpdater.on("update-downloaded", () => publish({ phase: "verifying", release }));
  squirrel.on("update-downloaded", () => {
    if (state.phase === "verifying") publish({ phase: "ready", release });
  });
  // Without a listener, electron-updater's error event would throw in the main process.
  autoUpdater.on("error", () => {
    if (state.phase === "verifying") publish({ phase: "error", error: DAMAGED });
  });

  // An update already found stays on offer until the restart, so a check never lands in the middle of its download.
  const canCheck = () => ["idle", "current", "error"].includes(state.phase);

  if (app.isPackaged && !copyName()) {
    const checkQuietly = () => {
      if (canCheck()) check(true);
    };
    setTimeout(checkQuietly, FIRST_CHECK_MS);
    setInterval(checkQuietly, CHECK_EVERY_MS);
  }

  ipcMain.on("update:state", (event) => {
    if (fromPage(event)) publish(state);
  });
  ipcMain.on("update:check", (event) => {
    if (fromPage(event) && canCheck()) check();
  });
  ipcMain.on("update:install", (event) => {
    if (!fromPage(event) || state.phase !== "available") return;
    install().catch((error) => {
      if (state.phase !== "error") publish({ phase: "error", error: error instanceof UpdateError ? error.message : STOPPED });
    });
  });
  ipcMain.on("update:restart", (event) => {
    if (fromPage(event) && state.phase === "ready") autoUpdater.quitAndInstall();
  });

  return {
    attach(_window, view) {
      page = view;
    },
  };
}
