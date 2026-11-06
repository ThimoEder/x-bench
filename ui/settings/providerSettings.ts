// The settings page's provider form: checking what the host sent, the form's state, and what a
// change posts.

import type { ClaudeSettingsView, ProviderSettingsRow, ProviderSettingsView } from "../../server/providers/routes.ts";

export type { ProviderSettingsRow, ProviderSettingsView };

export interface ProviderForm {
  defaultProvider: string;
  providers: Record<string, { enabled: boolean; defaultMode: string }>;
  claude: { configDir: string; executable: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRow(value: unknown): value is ProviderSettingsRow {
  if (!isRecord(value) || !isRecord(value.detected)) return false;
  const detected = value.detected;
  return (
    typeof value.id === "string" &&
    typeof value.label === "string" &&
    typeof value.enabled === "boolean" &&
    typeof value.defaultMode === "string" &&
    typeof value.openChats === "number" &&
    Array.isArray(value.modes) &&
    value.modes.every((mode) => isRecord(mode) && typeof mode.id === "string" && typeof mode.name === "string") &&
    typeof detected.installed === "boolean" &&
    (detected.version === null || typeof detected.version === "string") &&
    (detected.signedIn === null || typeof detected.signedIn === "boolean") &&
    (detected.message === null || typeof detected.message === "string") &&
    (detected.account === undefined || detected.account === null || typeof detected.account === "string") &&
    (detected.command === undefined || detected.command === null || typeof detected.command === "string")
  );
}

function isClaude(value: unknown): value is ClaudeSettingsView {
  return (
    isRecord(value) &&
    typeof value.configDir === "string" &&
    typeof value.configDirSaved === "boolean" &&
    typeof value.executable === "string" &&
    typeof value.installed === "string" &&
    isStringList(value.folders) &&
    isStringList(value.binaries) &&
    typeof value.unreadable === "boolean"
  );
}

export function isProviderSettingsView(value: unknown): value is ProviderSettingsView {
  return (
    isRecord(value) &&
    typeof value.defaultProvider === "string" &&
    Array.isArray(value.providers) &&
    value.providers.every(isRow) &&
    (value.claude === null || isClaude(value.claude)) &&
    typeof value.unreadable === "boolean" &&
    typeof value.canChoose === "boolean"
  );
}

export function formOf(view: ProviderSettingsView): ProviderForm {
  return {
    defaultProvider: view.defaultProvider,
    providers: Object.fromEntries(view.providers.map((row) => [row.id, { enabled: row.enabled, defaultMode: row.defaultMode }])),
    claude: {
      configDir: view.claude?.configDir ?? "",
      executable: view.claude?.executable ?? "",
    },
  };
}

// Whether Claude's folder or program differs from what the page loaded.
export function claudeChanged(form: ProviderForm, view: ProviderSettingsView): boolean {
  if (!view.claude || view.claude.unreadable) return false;
  const saved = formOf(view).claude;
  return form.claude.configDir.trim() !== saved.configDir || form.claude.executable.trim() !== saved.executable;
}

// What POST /api/providers gets when a switch or menu changes. Claude's fields are left out, so the
// folder or program being typed is applied only when that field is done.
export function choicesBody(form: ProviderForm) {
  return { defaultProvider: form.defaultProvider, providers: form.providers };
}

// One line on what the harness reported: installed, version, signed in.
export function detectedLine(row: ProviderSettingsRow): string {
  const { detected } = row;
  if (!detected.installed) return "Not installed";
  const parts = ["Installed"];
  if (detected.version) parts.push(detected.version.replace(/\s*\(Claude Code\)$/, ""));
  if (detected.signedIn === true) parts.push(detected.account ? `Signed in as ${detected.account}` : "Signed in");
  else if (detected.signedIn === false) parts.push("Not signed in");
  else parts.push("Sign-in is checked when a chat starts");
  return parts.join(" · ");
}

// ok, warn or off, for the mark next to the line.
export function detectedTone(row: ProviderSettingsRow): "ok" | "warn" | "off" {
  if (!row.detected.installed || row.detected.signedIn === false || row.detected.message) return "warn";
  return row.detected.signedIn === true ? "ok" : "off";
}
