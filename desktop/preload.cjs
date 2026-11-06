// The page's calls into the desktop app: the browser pane, rail tips, theme, screenshots, the Unity view and updates.
// Sandboxed preloads must be CommonJS.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("xBenchDesktop", {
  appName: process.argv.find((arg) => arg.startsWith("--x-bench-app-name="))?.slice("--x-bench-app-name=".length) ?? "",
  browserBounds(bounds, owner) {
    ipcRenderer.send("browser:bounds", bounds ?? null, owner ?? null);
  },
  browserFreeze() {
    return ipcRenderer.invoke("browser:freeze");
  },
  railTip(text, rect) {
    ipcRenderer.send("rail:tip", text ?? null, rect ?? null);
  },
  ...(process.platform === "darwin" ? { screenshot: () => ipcRenderer.invoke("screenshot:take") } : {}),
  theme(choice) {
    ipcRenderer.send("app:theme", choice);
  },
  unityBounds(bounds) {
    ipcRenderer.send("unity:bounds", bounds ?? null);
  },
  unityFolder(cwd) {
    ipcRenderer.send("unity:folder", cwd);
  },
  unityPointer(x, y, action) {
    ipcRenderer.send("unity:pointer", x, y, action);
  },
  unityKey(key, action) {
    ipcRenderer.send("unity:key", key, action);
  },
  unityFullScreen(flag, onLeft) {
    ipcRenderer.send("unity:fullscreen", Boolean(flag));
    if (!flag) return () => {};
    const forward = () => onLeft();
    ipcRenderer.once("unity:fullscreen-left", forward);
    return () => ipcRenderer.removeListener("unity:fullscreen-left", forward);
  },
  updateCheck() {
    ipcRenderer.send("update:check");
  },
  updateInstall() {
    ipcRenderer.send("update:install");
  },
  updateRestart() {
    ipcRenderer.send("update:restart");
  },
  onUpdate(listener) {
    const forward = (_event, state) => listener(state);
    ipcRenderer.on("update:state", forward);
    ipcRenderer.send("update:state");
    return () => ipcRenderer.removeListener("update:state", forward);
  },
  onUnityStats(listener) {
    const forward = (_event, stats) => listener(stats);
    ipcRenderer.on("unity:stats", forward);
    return () => ipcRenderer.removeListener("unity:stats", forward);
  },
});
