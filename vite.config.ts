// The UI's Vite config, used by the dev server in server/index.ts and by
// `npm run build`, which writes the page to dist/ui for X_BENCH_UI=dist.
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { licensesPlugin } from "./ui/licenses/licenses.ts";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.join(repoRoot, "ui"),
  plugins: [react(), katexWoff2Only(), licensesPlugin(repoRoot)],
  build: {
    outDir: path.join(repoRoot, "dist", "ui"),
    emptyOutDir: true,
    // The voice worklet stays a file, as in dev. Inlined, it would be a data:
    // URL, which audioWorklet.addModule and a future CSP may refuse.
    assetsInlineLimit: (file) => (file.endsWith("voice-worklet.js") ? false : undefined),
    // License headers (/*! … */ and @license) stay in the bundle, since MIT code must ship with its notice.
    rolldownOptions: { output: { comments: { legal: true, annotation: false, jsdoc: false } } },
  },
});

// KaTeX's stylesheet offers each font as woff2, woff and ttf. Chromium takes the woff2, so the page keeps
// only that and the other two stay out of dist/ui. The fonts are bundled files, never a CDN.
function katexWoff2Only(): Plugin {
  return {
    name: "katex-woff2-only",
    enforce: "pre",
    transform(code, id) {
      if (!/[\\/]katex[\\/]dist[\\/]katex(?:\.min)?\.css$/.test(id)) return null;
      return code.replace(/,\s*url\([^)]*\.(?:woff|ttf)\)\s*format\("(?:woff|truetype)"\)/g, "");
    },
  };
}
