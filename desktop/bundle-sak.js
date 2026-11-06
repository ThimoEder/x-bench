// Copies the SAK server into dist/sak for the packaged app, without its website.
// `npm run dist` runs it. The database is not copied: the app opens the file
// named in ~/.x-bench/sak.json, which can also name a SAK website to serve.
import { spawnSync } from "node:child_process";
import { cpSync, chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const sakRoot = process.env.SAK_ROOT || path.resolve(repoRoot, "..", "sak");
const fromCheckout = process.env.SAK_ROOT || existsSync(path.join(sakRoot, "sak"));
const binary = fromCheckout ? path.join(sakRoot, "sak") : path.join(repoRoot, "vendor", "sak", "sak");
const out = path.join(repoRoot, "dist", "sak");

if (!existsSync(binary)) {
  console.error(`bundle-sak: no sak binary at ${binary}. Build it in the SAK checkout first.`);
  process.exit(1);
}

const described = spawnSync("file", ["-b", binary], { encoding: "utf8" });
const kind = described.stdout || "";
if (described.status !== 0 || !kind.includes("arm64")) {
  console.error(`bundle-sak: the disk image is arm64, and ${binary} is not an arm64 executable (${kind.trim() || described.stderr}).`);
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(binary, path.join(out, "sak"));
chmodSync(path.join(out, "sak"), 0o755);
console.log(`bundle-sak: ${binary} → ${out}`);
