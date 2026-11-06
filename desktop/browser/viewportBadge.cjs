// The viewport badge's one way into the app: hear the shown tab's size, report the badge's own size, and put
// the tab back at the pane's size. Sandboxed preloads must be CommonJS.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("viewportBadge", {
  onLabel(listener) {
    ipcRenderer.on("browser:viewport-label", (_event, label) => listener(String(label)));
  },
  resize(width, height) {
    ipcRenderer.send("browser:viewport-badge-size", Number(width), Number(height));
  },
  fit() {
    ipcRenderer.send("browser:viewport-fit");
  },
});
