import { protocol } from "electron";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const scheme = "x-bench";
const pages = new Map([
  ["/launch.html", "launch.html"],
  ["/error.html", "error.html"],
  ["/viewportBadge.html", "browser/viewportBadge.html"],
]);

export function registerAppScheme() {
  protocol.registerSchemesAsPrivileged([{ scheme, privileges: { standard: true, secure: true } }]);
}

export function serveAppPages() {
  protocol.handle(scheme, async (request) => {
    const url = new URL(request.url);
    const file = url.host === "app" ? pages.get(url.pathname) : undefined;
    if (!file) return new Response(null, { status: 404 });
    const body = await fs.promises.readFile(fileURLToPath(new URL(file, import.meta.url)));
    return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
  });
}

export function appPageUrl(name, query = {}) {
  const search = new URLSearchParams(query).toString();
  return `${scheme}://app/${name}${search ? `?${search}` : ""}`;
}
