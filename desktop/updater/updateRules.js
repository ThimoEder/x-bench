// The updater's rules that need no Electron.
import path from "node:path";

// Installed apps take an update only when this team's Developer ID signed it.
export const SIGNED_BY = `anchor apple generic and certificate leaf[subject.OU] = "NFH75RY9MR"`;

export class UpdateError extends Error {}

export function copyName(env = process.env) {
  return env.X_BENCH_APP_NAME?.trim() || null;
}

function parts(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version));
  return match ? match.slice(1).map(Number) : null;
}

export function isNewer(candidate, current) {
  const a = parts(candidate);
  const b = parts(current);
  if (!a || !b) return false;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index];
  }
  return false;
}

// Null outside a bundle, and for the read-only copy macOS runs an app from when it was opened straight from Downloads.
export function appBundle(executable) {
  const bundle = path.resolve(executable, "../../..");
  if (!bundle.endsWith(".app") || bundle.includes("/AppTranslocation/")) return null;
  return bundle;
}

// Release notes hold one note per line, grouped under optional heading lines such as "Fixed:".
export function noteSections(text) {
  const sections = [];
  for (const line of String(text ?? "").split("\n").map((each) => each.trim()).filter(Boolean)) {
    const heading = /^(.+):$/.exec(line)?.[1];
    if (heading || !sections.length) sections.push({ heading: heading ?? "", notes: [] });
    if (!heading) sections.at(-1).notes.push(line);
  }
  return sections.filter((section) => section.notes.length);
}

export function notesList(text, heading) {
  return noteSections(text)
    .map((section) => [section.heading && heading(section.heading), ...section.notes.map((note) => `- ${note}`)].filter(Boolean).join("\n"))
    .join("\n\n");
}
