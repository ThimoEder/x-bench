// Serves the built page from dist/ui when the host runs with X_BENCH_UI=dist
// (ticket 87), so it does not load Vite at all. Any path that is not a file
// gets index.html, as the dev server does.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { injectToken, markRemote } from "./launchToken.ts";

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

export function contentType(file: string): string {
  return contentTypes[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

// Inline styles stay allowed because KaTeX and Mermaid draw with them, and web images because replies show them.
export function pagePolicy(html: string): string {
  const hashes = [...html.matchAll(/<script\b(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(
    ([, body]) => ` 'sha256-${createHash("sha256").update(body ?? "").digest("base64")}'`,
  );
  return [
    "default-src 'self'",
    `script-src 'self'${hashes.join("")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: http: https:",
    "media-src 'self' blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

// The file under root that a request path names, or null when the path is
// malformed or would leave root.
export function fileUnder(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const file = path.resolve(root, `.${path.posix.normalize(`/${decoded}`)}`);
  return file === root || file.startsWith(`${root}${path.sep}`) ? file : null;
}

// Vite puts hashed file names under assets/, so those never change.
export function cacheControl(root: string, file: string): string {
  return path.relative(root, file).startsWith(`assets${path.sep}`)
    ? "public, max-age=31536000, immutable"
    : "no-cache";
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

// Reads the page settings and removes them from env, so the agents and shells
// the host starts run `npm run dev` from their checkout with Vite.
export function takeUiSettings(env: NodeJS.ProcessEnv = process.env): { built: boolean; dir: string | undefined } {
  const settings = { built: env.X_BENCH_UI === "dist", dir: env.X_BENCH_UI_DIR || undefined };
  delete env.X_BENCH_UI;
  delete env.X_BENCH_UI_DIR;
  return settings;
}

// token is the launch token, written into index.html on every request for it (see launchToken.ts).
export function createStaticUi(dir: string, token = "") {
  const root = path.resolve(dir);
  const index = path.join(root, "index.html");
  if (!isFile(index)) throw new Error(`No built page in ${root}. Run npm run build first.`);

  // withToken is false for a page served through the remote tunnel, which must never carry the launch token.
  return function serve(req: IncomingMessage, res: ServerResponse, pathname: string, withToken = true) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" });
      res.end();
      return;
    }
    const named = fileUnder(root, pathname);
    const file = named && isFile(named) ? named : index;
    if (file === index) {
      // The token changes on every launch, so the page is never cached.
      const html = fs.readFileSync(index, "utf8");
      const page = Buffer.from(withToken ? (token ? injectToken(html, token) : html) : markRemote(html));
      res.writeHead(200, {
        "Content-Type": contentType(index),
        "Content-Length": page.length,
        "Cache-Control": "no-store",
        "Content-Security-Policy": pagePolicy(html),
      });
      res.end(req.method === "HEAD" ? undefined : page);
      return;
    }
    res.writeHead(200, {
      "Content-Type": contentType(file),
      "Content-Length": fs.statSync(file).size,
      "Cache-Control": cacheControl(root, file),
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    // A read that fails after the stat ends this response instead of
    // crashing the host with an unhandled stream error.
    pipeline(fs.createReadStream(file), res, () => {});
  };
}
