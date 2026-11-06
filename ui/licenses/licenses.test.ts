import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildList, embeddedPackages, packageDir, readPackage, webUrl } from "./licenses.ts";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

test("the list holds what the app ships and leaves out build tools and excluded packages", async () => {
  const names = new Set((JSON.parse(await buildList(repoRoot)) as { name: string }[]).map((entry) => entry.name));
  for (const shipped of ["Electron", "ONNX Runtime", "Mantle", "react", "mermaid", "katex", "@xterm/xterm", "@xterm/headless", "node-pty", "@anthropic-ai/claude-agent-sdk", "zod", "cross-spawn", "vscode-jsonrpc"]) {
    assert.ok(names.has(shipped), shipped);
  }
  for (const left of ["vite", "typescript", "happy-dom", "electron-builder", "express", "@openai/codex", "@anthropic-ai/claude-agent-sdk-darwin-arm64", "@types/d3"]) {
    assert.ok(!names.has(left), left);
  }
});

test("a bundled file names the package folder it comes from", () => {
  assert.equal(packageDir("/r/node_modules/react-dom/cjs/client.js"), "/r/node_modules/react-dom");
  assert.equal(packageDir("/r/node_modules/@xterm/xterm/lib/xterm.mjs"), "/r/node_modules/@xterm/xterm");
  assert.equal(packageDir("/r/node_modules/mermaid/node_modules/uuid/dist/index.js"), "/r/node_modules/mermaid/node_modules/uuid");
  assert.equal(packageDir("/r/ui/App.tsx"), null);
});

test("a package's link and license text come from its own files", () => {
  assert.equal(webUrl("git+https://github.com/a/b.git"), "https://github.com/a/b");
  assert.equal(webUrl("github:a/b"), "https://github.com/a/b");
  assert.equal(webUrl("https://example.com/#readme"), "https://example.com/");
  assert.equal(webUrl("javascript:alert(1)"), "");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x-bench-license-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "p", version: "1.0.0", license: "(MIT OR Apache-2.0)" }));
  fs.writeFileSync(path.join(dir, "LICENSE-MIT"), "MIT text\n");
  fs.writeFileSync(path.join(dir, "NOTICE"), "Notice text\n");
  fs.writeFileSync(path.join(dir, "README.md"), "Readme\n");
  assert.deepEqual(readPackage(dir), { name: "p", version: "1.0.0", license: "MIT OR Apache-2.0", url: "https://www.npmjs.com/package/p", text: "MIT text\n\nNotice text" });
  fs.rmSync(dir, { recursive: true });
});

test("a package that ships other packages bundled into its files brings their licenses along, in the versions it depends on", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "x-bench-embedded-"));
  const write = (file: string, json: object | string) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), typeof json === "string" ? json : JSON.stringify(json));
  };
  write("node_modules/outer/package.json", { name: "outer", dependencies: { spawn: "1", "@scope/deep": "1", unused: "1" } });
  write("node_modules/outer/dist/index.js", "// node_modules/spawn/index.js\n// node_modules/inner/index.js\nvar a;\n// node_modules/@scope/deep/lib/x.js\n// node_modules/.bin/tool\n");
  write("node_modules/spawn/package.json", { name: "spawn", dependencies: { inner: "1" } });
  write("node_modules/spawn/node_modules/inner/package.json", { name: "inner" });
  write("node_modules/inner/package.json", { name: "inner" });
  write("node_modules/@scope/deep/package.json", { name: "@scope/deep" });
  write("node_modules/unused/package.json", { name: "unused" });
  const at = (dir: string) => path.join(root, "node_modules", dir);
  assert.deepEqual(embeddedPackages(at("outer")).sort(), [at("@scope/deep"), at("spawn"), at("spawn/node_modules/inner")].sort());
  fs.rmSync(root, { recursive: true });
});
