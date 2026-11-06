// Starts X Bench Dev from this checkout (`npm run app`, `npm run app:dev`).
// macOS takes the menu bar name, the Dock label and the first Dock icon from
// the app bundle, so Electron.app is copied into node_modules/.cache under the
// feature label's name (`--label`, else the branch), with its own bundle id
// and the dev icon. The copy is made again when Electron, the icon or the name
// changes. Arguments go on to desktop/main.js, with the label.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { branchLabel, devAppEnv, devAppName, gitBranch, labelArg } from "./host.js";

const require = createRequire(import.meta.url);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const mainEntry = fileURLToPath(new URL("main.js", import.meta.url));
const icon = fileURLToPath(new URL("build/icon-dev.icns", import.meta.url));
const args = process.argv.slice(2);
const givenLabel = labelArg(args);
const label = (givenLabel ?? branchLabel(gitBranch(repoRoot))).trim();
const name = devAppName(label);
const bundleId = "dev.xbench.dev";
const cacheDir = path.join(repoRoot, "node_modules", ".cache", "x-bench-dev");
// The name is in the path, because macOS caches an app's name by its path.
// Bundles under earlier names stay, since an app may still run from one.
const bundle = path.join(cacheDir, `${name}.app`);
// Next to the bundle, since a file added inside it breaks its signature.
const stampFile = `${bundle}.json`;

// The electron package exports the path of Electron.app/Contents/MacOS/Electron.
const electronApp = path.resolve(require("electron"), "..", "..", "..");

function wantedStamp() {
  const { version } = require("electron/package.json");
  const iconHash = createHash("sha256").update(fs.readFileSync(icon)).digest("hex");
  return JSON.stringify({ electron: version, icon: iconHash, name, bundleId });
}

function readStamp() {
  try {
    return fs.readFileSync(stampFile, "utf8");
  } catch {
    return null;
  }
}

function buildBundle(stamp) {
  console.log(`Building ${name}.app from Electron.app.`);
  fs.mkdirSync(cacheDir, { recursive: true });
  const staging = path.join(cacheDir, `staging-${process.pid}.app`);
  fs.rmSync(staging, { recursive: true, force: true });
  try {
    // An APFS clone, which takes no extra space.
    execFileSync("cp", ["-cR", electronApp, staging], { stdio: "ignore" });
  } catch {
    fs.rmSync(staging, { recursive: true, force: true });
    execFileSync("cp", ["-R", electronApp, staging]);
  }
  const plist = path.join(staging, "Contents", "Info.plist");
  for (const [key, value] of [["CFBundleName", name], ["CFBundleDisplayName", name], ["CFBundleIdentifier", bundleId]]) {
    execFileSync("plutil", ["-replace", key, "-string", value, plist]);
  }
  fs.copyFileSync(icon, path.join(staging, "Contents", "Resources", "electron.icns"));
  // The edited Info.plist no longer matches Electron's signature.
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", staging], { stdio: "ignore" });
  fs.rmSync(bundle, { recursive: true, force: true });
  fs.renameSync(staging, bundle);
  fs.writeFileSync(stampFile, stamp);
}

const stamp = wantedStamp();
if (readStamp() !== stamp || !fs.existsSync(bundle)) buildBundle(stamp);

const passed = givenLabel === null && label ? [...args, `--label=${label}`] : args;
const child = spawn(path.join(bundle, "Contents", "MacOS", "Electron"), [mainEntry, ...passed], {
  cwd: repoRoot,
  env: devAppEnv(process.env, repoRoot),
  stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
