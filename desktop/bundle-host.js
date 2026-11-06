// Bundles the X Bench host (server/index.ts) into dist/host/index.mjs for the
// packaged app (ticket 87, phase 4), so the app ships one file instead of
// server/, bridge/ and their dependencies. `npm run dist` runs it.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { hostBundle } from "./hostBundle.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

await build({
  absWorkingDir: repoRoot,
  ...hostBundle,
  outfile: "dist/host/index.mjs",
  sourcemap: true,
  // Bundled CommonJS code calls require, which an ES module does not have.
  banner: { js: 'import { createRequire as __xBenchRequire } from "node:module"; const require = __xBenchRequire(import.meta.url);' },
  logLevel: "info",
});
