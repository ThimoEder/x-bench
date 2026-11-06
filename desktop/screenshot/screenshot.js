// The composer's Take a screenshot: macOS's own picker for a region or a window, read back as PNG bytes.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ipcMain } from "electron";

export function handleScreenshots(fromPage) {
  ipcMain.handle("screenshot:take", async (event) => {
    if (process.platform !== "darwin" || !fromPage(event.sender.getURL())) return null;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "x-bench-shot-"));
    const file = path.join(dir, "shot.png");
    try {
      // -i lets the person pick, -x keeps it silent. Esc leaves no file.
      await new Promise((resolve) => {
        execFile("/usr/sbin/screencapture", ["-i", "-x", file], () => resolve());
      });
      return await fs.readFile(file).catch(() => null);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
}
