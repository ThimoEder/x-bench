// Build-time list of the third-party code X Bench ships, with each license text, for the Open Source Licenses page.
// It runs in Node from vite.config.ts, and the page reads it as /licenses.json.
import fs from "node:fs";
import path from "node:path";
import { build as esbuild } from "esbuild";
import type { Plugin, Rollup } from "vite";
import { hostBundle } from "../../desktop/hostBundle.ts";

export interface License {
  name: string;
  version: string;
  license: string;
  url: string;
  text: string;
  note?: string;
  // A page of further notices, served by the host.
  credits?: string;
}

const CHROMIUM_CREDITS = "chromium-licenses.html";
const LICENSE_FILE = /^(licen[cs]e|copying|notice)([.\-_].*)?$/i;

const MIT_TERMS = `Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;
const MIT = (holder: string) => `MIT License\n\nCopyright (c) ${holder}\n\n${MIT_TERMS}`;

// Packages that Mermaid and its parser carry already bundled into their files, with no license file of their own.
const BUILT_INTO: Record<string, string> = {
  mermaid: `Mermaid and its parser also contain these packages, each under the MIT License below:

js-yaml 4.3.0: Copyright (C) 2011-2015 by Vitaly Puzrin
fastdom 1.0.12: Copyright (c) Wilson Page
langium 4.2.1: Copyright 2021 TypeFox GmbH
chevrotain-allstar 0.3.1: Copyright 2022 TypeFox GmbH
vscode-jsonrpc 8.2.0, vscode-languageserver-protocol 3.17.5, vscode-languageserver-textdocument 1.0.12, vscode-languageserver-types 3.17.5: Copyright (c) Microsoft Corporation
vscode-uri 3.1.0: Copyright (c) Microsoft
lodash-es 4.17.23: Copyright OpenJS Foundation and other contributors <https://openjsf.org/>

${MIT_TERMS}`,
};

// Code and models that do not come from npm.
const VENDORED: License[] = [
  {
    name: "Parakeet TDT 0.6B v3",
    version: "int8",
    license: "CC-BY-4.0",
    url: "https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3",
    note: "Speech model for dictation, downloaded on first use. By NVIDIA, converted to ONNX by the sherpa-onnx project.",
    text: "parakeet-tdt-0.6b-v3 © NVIDIA Corporation, licensed under the Creative Commons Attribution 4.0 International License (CC BY 4.0).\nConverted to ONNX and quantized to int8 by the k2-fsa/sherpa-onnx project.\n\nhttps://creativecommons.org/licenses/by/4.0/",
  },
  {
    name: "Lobe Icons",
    version: "",
    license: "MIT",
    url: "https://github.com/lobehub/lobe-icons",
    note: "The Claude, OpenAI and Grok marks. They are trademarks of Anthropic, OpenAI and xAI.",
    text: MIT("2023 LobeHub"),
  },
  {
    name: "idb",
    version: "",
    license: "MIT",
    url: "https://github.com/cameroncooke/idb",
    note: "Drives the iOS simulator.",
    text: MIT("Meta Platforms, Inc. and affiliates."),
  },
  {
    name: "Mantle",
    version: "",
    license: "MIT",
    url: "https://github.com/Mantle/Mantle",
    note: "Part of Electron on macOS.",
    text: MIT("GitHub, Inc.\nAll rights reserved."),
  },
  {
    name: "ReactiveObjC",
    version: "3.1.0",
    license: "MIT",
    url: "https://github.com/ReactiveCocoa/ReactiveObjC",
    note: "Part of Electron on macOS.",
    text: MIT("2012 - 2016, GitHub, Inc.\nAll rights reserved."),
  },
  {
    name: "SAK",
    version: "",
    license: "MIT",
    url: "https://git.swipelab.com/sx/sak",
    note: "The board server.",
    text: MIT("2026 Alexandru Agrapine"),
  },
  {
    name: "ONNX Runtime",
    version: "1.28.2",
    license: "MIT",
    url: "https://github.com/microsoft/onnxruntime",
    note: "Runs the dictation model, inside sherpa-onnx.",
    text: MIT("Microsoft Corporation"),
  },
];

// bundled holds the package folders the UI and host bundles carry code from.
export function collectLicenses(repoRoot: string, bundled: Iterable<string>): License[] {
  const lock = readJson<{ packages: Record<string, { dev?: boolean }> }>(path.join(repoRoot, "package-lock.json")).packages;
  const excluded = readJson<{ files: string[] }>(path.join(repoRoot, "desktop", "electron-builder.json"))
    .files.filter((pattern) => pattern.startsWith("!node_modules/"))
    .map((pattern) => pattern.slice(1));
  // electron-builder copies every production package into the app, except the ones its config leaves out.
  const shipped = Object.keys(lock)
    .filter((key) => key && !lock[key]!.dev && fs.existsSync(path.join(repoRoot, key, "package.json")))
    .filter((key) => !excluded.some((glob) => path.matchesGlob(`${key}/package.json`, glob)))
    .map((key) => path.join(repoRoot, key));

  const seen = new Map<string, License>();
  for (const dir of new Set([...shipped, ...shipped.flatMap(embeddedPackages), ...bundled])) {
    const entry = readPackage(dir);
    if (BUILT_INTO[entry.name]) entry.text += `\n\n${BUILT_INTO[entry.name]}`;
    seen.set(`${entry.name}@${entry.version}`, entry);
  }
  const packages = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  return [electron(repoRoot), scrcpy(repoRoot), ...VENDORED, ...packages];
}

function scrcpy(repoRoot: string): License {
  return {
    name: "scrcpy server",
    version: "4.1",
    license: "Apache-2.0",
    url: "https://github.com/Genymobile/scrcpy",
    note: "Mirrors Android phones and carries the agents' touches and typing on Android.",
    text: fs.readFileSync(path.join(repoRoot, "desktop", "devices", "android-helper", "scrcpy", "LICENSE"), "utf8"),
  };
}

// The package folder a bundled module comes from, or null for the app's own code.
export function packageDir(file: string): string | null {
  const at = file.lastIndexOf("/node_modules/");
  if (at < 0) return null;
  const rest = file.slice(at + "/node_modules/".length).split("/");
  const name = rest[0]!.startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0]!;
  return `${file.slice(0, at)}/node_modules/${name}`;
}

// The packages a shipped package carries already bundled into its own files, which esbuild marks with a
// `// node_modules/<name>/…` line before each module. They resolve through its dependency tree, as Node resolved
// them when it was built, so a nested older copy wins over a newer one elsewhere in node_modules.
export function embeddedPackages(dir: string): string[] {
  const names = new Set<string>();
  for (const file of fs.globSync("**/*.{js,mjs,cjs}", { cwd: dir })) {
    if (file.includes("node_modules")) continue;
    for (const [, name] of fs.readFileSync(path.join(dir, file), "utf8").matchAll(/^\/\/ node_modules\/((?:@[^/\s]+\/)?[^./\s][^/\s]*)\//gm)) names.add(name!);
  }
  const found: string[] = [];
  const seen = new Set([dir]);
  const queue = [dir];
  while (queue.length) {
    const from = queue.pop()!;
    const pkg = readJson<{ name?: string; dependencies?: object; peerDependencies?: object }>(path.join(from, "package.json"));
    if (from !== dir && pkg.name && names.has(pkg.name)) found.push(from);
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies })) {
      const next = installedDir(from, name);
      if (next && !seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return found;
}

function installedDir(from: string, name: string): string | null {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name);
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    if (dir === path.dirname(dir)) return null;
  }
}

async function hostPackages(repoRoot: string): Promise<string[]> {
  const { metafile } = await esbuild({ ...hostBundle, absWorkingDir: repoRoot, write: false, metafile: true, logLevel: "silent" });
  return Object.keys(metafile.inputs).map((file) => packageDir(path.resolve(repoRoot, file))).filter((dir) => dir !== null);
}

// The package folders a Vite build put code into, leaving out modules tree-shaking dropped.
function bundlePackages(bundle: Rollup.OutputBundle): string[] {
  return Object.values(bundle).flatMap((file) =>
    file.type === "chunk" ? Object.entries(file.modules).filter(([, module]) => module.renderedLength > 0).map(([id]) => packageDir(id.replace(/^\0/, "").split("?")[0]!)).filter((dir) => dir !== null) : [],
  );
}

export function readPackage(dir: string): License {
  const pkg = readJson<{ name: string; version: string; license?: unknown; homepage?: unknown; repository?: unknown }>(path.join(dir, "package.json"));
  const files = fs.readdirSync(dir).filter((file) => LICENSE_FILE.test(file)).sort();
  const text = files.map((file) => fs.readFileSync(path.join(dir, file), "utf8").trim()).join("\n\n");
  const declared = typeof pkg.license === "string" ? pkg.license : typeof pkg.license === "object" && pkg.license && "type" in pkg.license ? String(pkg.license.type) : "";
  return {
    name: pkg.name,
    version: pkg.version,
    license: declared.startsWith("SEE LICENSE") ? "Custom" : declared.replace(/^\((.*)\)$/, "$1") || "Other",
    url: webUrl(pkg.homepage) || webUrl(typeof pkg.repository === "object" && pkg.repository && "url" in pkg.repository ? pkg.repository.url : pkg.repository) || `https://www.npmjs.com/package/${pkg.name}`,
    text: text || `The package declares the ${declared || "unknown"} license and ships no license file.`,
  };
}

// An https link from a package.json homepage or repository field, which also comes as git+https:…git or github:owner/repo.
export function webUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  const github = /^(?:github:)?([\w.-]+\/[\w.-]+)$/.exec(value);
  const url = github ? `https://github.com/${github[1]}` : value.replace(/^git\+/, "").replace(/^git:\/\//, "https://").replace(/\.git$/, "").replace(/#.*$/, "");
  return url.startsWith("https://") ? url : "";
}

function electron(repoRoot: string): License {
  const dir = path.join(repoRoot, "node_modules", "electron");
  return {
    ...readPackage(dir),
    name: "Electron",
    url: "https://www.electronjs.org",
    note: "The app runs on Electron, which includes Chromium, Node.js and their third-party components.",
    credits: `/${CHROMIUM_CREDITS}`,
  };
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

// Writes /licenses.json next to the page, and Chromium's own credits page, which Electron ships beside its binary, as
// /chromium-licenses.html. The dev server builds the page in memory to learn what the list holds.
export function licensesPlugin(repoRoot: string): Plugin {
  const credits = path.join(repoRoot, "node_modules", "electron", "dist", "LICENSES.chromium.html");
  let writes = true;
  return {
    name: "x-bench-licenses",
    configResolved(config) {
      writes = config.build.write;
    },
    configureServer(server) {
      server.middlewares.use("/licenses.json", (_req, res) => {
        void buildList(repoRoot).then(
          (json) => {
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(json);
          },
          (error: unknown) => {
            res.statusCode = 500;
            res.end(String(error));
          },
        );
      });
      server.middlewares.use(`/${CHROMIUM_CREDITS}`, (_req, res) => {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        fs.createReadStream(credits).on("error", () => res.writeHead(404).end()).pipe(res);
      });
    },
    async generateBundle(_options, bundle) {
      const licenses = collectLicenses(repoRoot, [...bundlePackages(bundle), ...(await hostPackages(repoRoot))]);
      this.emitFile({ type: "asset", fileName: "licenses.json", source: JSON.stringify(licenses) });
      if (!writes) return;
      if (!fs.existsSync(credits)) this.error(`No ${credits}. Run node node_modules/electron/install.js.`);
      this.emitFile({ type: "asset", fileName: CHROMIUM_CREDITS, source: fs.readFileSync(credits) });
    },
  };
}

export async function buildList(repoRoot: string): Promise<string> {
  const { build } = await import("vite");
  const output = await build({ configFile: path.join(repoRoot, "vite.config.ts"), logLevel: "silent", build: { write: false } });
  const files = (Array.isArray(output) ? output : [output]).flatMap((result) => ("output" in result ? result.output : []));
  const list = files.find((file) => file.fileName === "licenses.json");
  if (list?.type !== "asset") throw new Error("The page build wrote no licenses.json.");
  return String(list.source);
}
