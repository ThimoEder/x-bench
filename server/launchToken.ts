// The per-launch token. The host makes a new one at startup, writes it into the page and into a file only
// this user can read, and every /api request must carry it (see apiGuard.ts).

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const TOKEN_META = "x-bench-token";

export function createLaunchToken(): string {
  return randomBytes(32).toString("base64url");
}

// Scripts read the file, for example: curl -H "X-Bench-Token: $(cat ~/.x-bench/launch-token-8787)" ...
export function writeTokenFile(file: string, token: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${token}\n`, { mode: 0o600 });
  fs.chmodSync(temp, 0o600);
  fs.renameSync(temp, file);
}

// Leaves the file alone when a newer host on the same port has already replaced it.
export function removeTokenFile(file: string, token: string) {
  try {
    if (fs.readFileSync(file, "utf8").trim() === token) fs.rmSync(file);
  } catch {
    // Nothing to remove.
  }
}

export const REMOTE_META = "x-bench-remote";

// A page served through remote access carries this mark in place of the token, so it hides what stays on the Mac.
export function markRemote(html: string): string {
  const meta = `<meta name="${REMOTE_META}" content="1" />`;
  if (html.includes("</head>")) return html.replace("</head>", `    ${meta}\n  </head>`);
  return `${meta}\n${html}`;
}

// The page reads the token from <meta name="x-bench-token"> (ui/launchToken.ts).
export function injectToken(html: string, token: string): string {
  const meta = `<meta name="${TOKEN_META}" content="${token}" />`;
  if (html.includes("</head>")) return html.replace("</head>", `    ${meta}\n  </head>`);
  return `${meta}\n${html}`;
}
