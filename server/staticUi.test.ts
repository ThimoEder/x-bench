import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cacheControl, contentType, createStaticUi, fileUnder, takeUiSettings } from "./staticUi.ts";

function builtPage() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "x-bench-ui-"));
  fs.mkdirSync(path.join(root, "assets"));
  fs.writeFileSync(path.join(root, "index.html"), "<!doctype html><title>X Bench</title>");
  fs.writeFileSync(path.join(root, "assets", "main-abc123.js"), "console.log(1);");
  fs.writeFileSync(path.join(root, "favicon.png"), "png");
  return root;
}

async function listen(root: string, token = "", withToken = true) {
  const serve = createStaticUi(root, token);
  const server = http.createServer((req, res) => serve(req, res, new URL(req.url || "/", "http://127.0.0.1").pathname, withToken));
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string", "no port");
  return { base: `http://127.0.0.1:${address.port}`, close: () => new Promise((resolve) => {
    server.close(resolve);
  }) };
}

test("a request path maps to a file under the root, never outside it", () => {
  const root = path.resolve("/srv/ui");
  assert.equal(fileUnder(root, "/assets/a.js"), path.join(root, "assets", "a.js"));
  assert.equal(fileUnder(root, "/"), root);
  assert.equal(fileUnder(root, "/../secret"), path.join(root, "secret"));
  assert.equal(fileUnder(root, "/%2e%2e/%2e%2e/etc/passwd"), path.join(root, "etc", "passwd"));
  assert.equal(fileUnder(root, "/a%00b"), null);
  assert.equal(fileUnder(root, "/%E0%A4%A"), null);
});

test("hashed assets are cached for good, everything else is revalidated", () => {
  const root = path.resolve("/srv/ui");
  assert.match(cacheControl(root, path.join(root, "assets", "main-abc.js")), /immutable/);
  assert.equal(cacheControl(root, path.join(root, "index.html")), "no-cache");
  assert.equal(contentType("main.js"), "text/javascript; charset=utf-8");
  assert.equal(contentType("font.woff2"), "font/woff2");
  assert.equal(contentType("blob.bin"), "application/octet-stream");
});

test("without a built page the host fails at startup, not on the first request", () => {
  assert.throws(() => createStaticUi(fs.mkdtempSync(path.join(os.tmpdir(), "x-bench-empty-"))), /npm run build/);
});

test("files are served with their type, and other paths get index.html", async () => {
  const root = builtPage();
  const host = await listen(root);
  try {
    const asset = await fetch(`${host.base}/assets/main-abc123.js`);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.match(asset.headers.get("cache-control") ?? "", /immutable/);
    assert.equal(await asset.text(), "console.log(1);");

    for (const route of ["/", "/board/87", "/../../etc/passwd", "/assets/missing.js"]) {
      const page = await fetch(`${host.base}${route}`);
      assert.equal(page.status, 200, route);
      assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8", route);
      assert.equal(await page.text(), "<!doctype html><title>X Bench</title>", route);
    }

    const head = await fetch(`${host.base}/favicon.png`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), "3");

    const post = await fetch(`${host.base}/`, { method: "POST" });
    assert.equal(post.status, 405);
  } finally {
    await host.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a file that cannot be read ends that response, and the host keeps serving", async () => {
  const root = builtPage();
  const locked = path.join(root, "assets", "locked.js");
  fs.writeFileSync(locked, "secret");
  fs.chmodSync(locked, 0o000);
  const host = await listen(root);
  try {
    await assert.rejects(async () => {
      const res = await fetch(`${host.base}/assets/locked.js`);
      await res.text();
    });
    const page = await fetch(`${host.base}/`);
    assert.equal(page.status, 200);
  } finally {
    await host.close();
    fs.chmodSync(locked, 0o600);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("with a launch token, index.html carries it and is never cached", async () => {
  const root = builtPage();
  fs.writeFileSync(path.join(root, "index.html"), "<!doctype html><html><head><title>X Bench</title></head></html>");
  const host = await listen(root, "launch123");
  try {
    for (const route of ["/", "/index.html", "/board/87"]) {
      const page = await fetch(`${host.base}${route}`);
      assert.equal(page.status, 200, route);
      assert.equal(page.headers.get("cache-control"), "no-store", route);
      const html = await page.text();
      assert.match(html, /<meta name="x-bench-token" content="launch123" \/>/, route);
      assert.equal(page.headers.get("content-length"), String(Buffer.byteLength(html)), route);
    }
    const asset = await fetch(`${host.base}/assets/main-abc123.js`);
    assert.equal(await asset.text(), "console.log(1);");
  } finally {
    await host.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the page runs only its own scripts and cannot be framed", async () => {
  const root = builtPage();
  const inline = "document.documentElement.dataset.theme = 'dark';";
  fs.writeFileSync(path.join(root, "index.html"), `<!doctype html><html><head><script>${inline}</script><script type="module" crossorigin src="/assets/main-abc123.js"></script></head></html>`);
  const host = await listen(root, "launch123");
  try {
    const policy = (await fetch(`${host.base}/`)).headers.get("content-security-policy") ?? "";
    const hash = createHash("sha256").update(inline).digest("base64");
    assert.match(policy, new RegExp(`script-src 'self' 'sha256-${hash.replace(/[+/]/g, "\\$&")}';`));
    assert.equal(policy.match(/'sha256-/g)?.length, 1);
    for (const directive of ["default-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"]) {
      assert.ok(policy.split("; ").includes(directive), directive);
    }
    assert.ok(!/unsafe-(inline|eval)/.test(policy.split("; ").find((part) => part.startsWith("script-src")) ?? ""));
  } finally {
    await host.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a page for the remote tunnel goes out without the launch token", async () => {
  const root = builtPage();
  fs.writeFileSync(path.join(root, "index.html"), "<!doctype html><html><head><title>X Bench</title></head></html>");
  const host = await listen(root, "launch123", false);
  try {
    const page = await fetch(`${host.base}/`);
    assert.equal(page.headers.get("cache-control"), "no-store");
    const html = await page.text();
    assert.ok(!html.includes("launch123"));
    assert.match(html, /<meta name="x-bench-remote" content="1" \/>/);
  } finally {
    await host.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the page settings stay with the host, and the helper paths reach its sessions", () => {
  const env: NodeJS.ProcessEnv = {
    PATH: "/usr/bin",
    X_BENCH_UI: "dist",
    X_BENCH_UI_DIR: "/Applications/X Bench.app/Contents/Resources/app.asar/dist/ui",
    X_BENCH_SIM_HELPER: "/sim/xbench-sim",
    X_BENCH_ANDROID_HELPER: "/android/xbench-android.jar",
    X_BENCH_ANDROID_ENCODER: "/android/xbench-encode",
  };
  assert.deepEqual(takeUiSettings(env), { built: true, dir: "/Applications/X Bench.app/Contents/Resources/app.asar/dist/ui" });
  assert.deepEqual(env, {
    PATH: "/usr/bin",
    X_BENCH_SIM_HELPER: "/sim/xbench-sim",
    X_BENCH_ANDROID_HELPER: "/android/xbench-android.jar",
    X_BENCH_ANDROID_ENCODER: "/android/xbench-encode",
  });
  assert.deepEqual(takeUiSettings({}), { built: false, dir: undefined });
});
