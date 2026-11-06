import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));

// Packages the packaged app runs from node_modules, not from the host bundle (see bundle-host.js).
const UNBUNDLED = ["@agentclientprotocol/claude-agent-acp/dist/index.js", "@agentclientprotocol/codex-acp/dist/index.js", "@ngrok/ngrok", "electron-updater", "node-pty", "sherpa-onnx-node"];

// The node_modules packages electron-builder.json leaves out of the app.
function excludedPackages() {
  const config = JSON.parse(readFileSync(path.join(root, "desktop", "electron-builder.json"), "utf8"));
  return config.files.flatMap((entry) => {
    const match = /^!node_modules\/(?:\{([^}]+)\}|([^/]+))\/\*\*$/.exec(entry);
    return match ? (match[1] ?? match[2]).split(",") : [];
  });
}

// Every package an unbundled package loads at runtime, by name: the packages its import graph reaches.
// The native build for each platform, which a package names in optionalDependencies and picks at runtime, is left out.
async function runtimeClosure() {
  const { metafile } = await build({ absWorkingDir: root, entryPoints: UNBUNDLED, bundle: true, platform: "node", format: "esm", write: false, metafile: true, outdir: "out", logLevel: "silent", loader: { ".node": "empty" } });
  const dirs = new Set(Object.keys(metafile.inputs).map((file) => /^.*node_modules\/(?:@[^/]+\/)?[^/]+/.exec(file)?.[0]).filter(Boolean));
  const manifests = [...dirs].map((dir) => JSON.parse(readFileSync(path.join(root, dir, "package.json"), "utf8")));
  const native = new Set(manifests.flatMap((manifest) => Object.keys(manifest.optionalDependencies ?? {})));
  return new Set(manifests.map((manifest) => manifest.name).filter((name) => !native.has(name)));
}

// The desktop files main.js loads, itself included, following their relative imports.
function desktopModules() {
  const found = new Set();
  const visit = (file) => {
    if (found.has(file)) return;
    found.add(file);
    const source = readFileSync(path.join(root, file), "utf8");
    for (const [, specifier] of source.matchAll(/^import [^"]*"(\.{1,2}\/[^"]+)";$/gm)) {
      visit(path.posix.join(path.posix.dirname(file), specifier));
    }
  };
  visit("desktop/main.js");
  return [...found];
}

test("the app keeps every desktop module the main process imports", () => {
  const config = JSON.parse(readFileSync(path.join(root, "desktop", "electron-builder.json"), "utf8"));
  assert.ok(desktopModules().includes("desktop/browser/browser.js"), "main.js's imports were not read");
  assert.deepEqual(desktopModules().filter((file) => !config.files.includes(file)), []);
});

test("the app keeps every package that the Claude and ChatGPT adapters and the speech model load at runtime", async () => {
  const needed = await runtimeClosure();
  assert.ok(needed.has("@agentclientprotocol/sdk"), "the adapters' dependencies were not read");
  assert.deepEqual(excludedPackages().filter((name) => needed.has(name)), []);
});
