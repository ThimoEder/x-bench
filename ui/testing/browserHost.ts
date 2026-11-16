// What a browser test imports in place of @playwright/test. Each test gets a host of its own on a free port, with a
// scratch home folder and Claude on the fake adapter, and a page with a fixed clock. After test.use({ seeded: true })
// the home holds the chats and the board of seededHome.ts.

import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { test as base } from "@playwright/test";
import { ONBOARDED_KEY } from "../onboarding/Onboarding.tsx";
import { seedHome } from "./seededHome.ts";

export { expect } from "@playwright/test";
export { SEED } from "./seededHome.ts";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

// The page's clock stands still here. The host keeps the real time.
const NOW = new Date("2026-01-15T10:30:00Z");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no free port"))));
    });
  });
}

export const test = base.extend<{ seeded: boolean; host: { url: string } }>({
  seeded: [false, { option: true }],
  host: async ({ seeded }, provide) => {
    // The host names a folder by its real path, and the seed has to name it the same way.
    const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), "x-bench-browser-")));
    mkdirSync(path.join(home, ".x-bench"));
    const seed = seeded ? await seedHome(home) : null;
    writeFileSync(path.join(home, ".x-bench", "providers.json"), JSON.stringify({ defaultProvider: "claude", providers: { grok: { enabled: false }, chatgpt: { enabled: false } } }));
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const host = spawn(process.execPath, [path.join(repoRoot, "server", "index.ts")], {
      cwd: home,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        PORT: String(port),
        TZ: "UTC",
        X_BENCH_ROUTINES: "off",
        X_BENCH_CLAUDE_ADAPTER: JSON.stringify([process.execPath, path.join(repoRoot, "bridge", "testing", "fakeClaude.ts"), path.join(home, "fake-claude.json")]),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const ended = once(host, "exit");
    try {
      await new Promise<void>((resolve, reject) => {
        const read = (chunk: Buffer) => {
          output += chunk;
          if (output.includes(url)) resolve();
        };
        host.stdout.on("data", read);
        host.stderr.on("data", read);
        host.on("exit", (code) => reject(new Error(`The host stopped with code ${code} before it listened:\n${output}`)));
      });
      await provide({ url });
    } finally {
      host.kill("SIGTERM");
      await ended;
      await seed?.stop();
      // The fake agent outlives the host for a moment and may still save its store.
      rmSync(home, { recursive: true, force: true, maxRetries: 10 });
    }
  },
  baseURL: async ({ host }, provide) => {
    await provide(host.url);
  },
  // Onboarding turns on every agent installed on this machine, so a page starts past it.
  storageState: async ({ host }, provide) => {
    await provide({ cookies: [], origins: [{ origin: host.url, localStorage: [{ name: ONBOARDED_KEY, value: "1" }] }] });
  },
  page: async ({ page }, provide) => {
    await page.clock.setFixedTime(NOW);
    await provide(page);
  },
});
