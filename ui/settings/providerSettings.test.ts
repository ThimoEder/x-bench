import assert from "node:assert/strict";
import test from "node:test";
import { choicesBody, claudeChanged, detectedLine, formOf, isProviderSettingsView, type ProviderSettingsView } from "./providerSettings.ts";

function view(): ProviderSettingsView {
  return {
    defaultProvider: "grok",
    providers: [
      {
        id: "grok",
        label: "Grok",
        enabled: true,
        defaultMode: "full",
        modes: [{ id: "full", name: "Always approve" }],
        status: "ready",
        detected: { installed: true, version: "grok 1.0.60", signedIn: null, message: null },
        openChats: 2,
      },
      {
        id: "claude",
        label: "Claude",
        enabled: true,
        defaultMode: "auto",
        modes: [{ id: "auto", name: "Auto" }],
        status: "idle",
        detected: { installed: true, version: "2.1.284 (Claude Code)", signedIn: true, account: "me@example.com (Max)", message: null },
        openChats: 1,
      },
    ],
    claude: {
      configDir: "~/.claude-personal",
      configDirSaved: true,
      executable: "~/.local/bin/claude",
      installed: "~/.local/bin/claude",
      folders: ["~/.claude", "~/.claude-personal"],
      binaries: ["~/.local/bin/claude"],
      unreadable: false,
    },
    unreadable: false,
    canChoose: true,
  };
}

test("the page reads a settings view only when the fields it shows are there", () => {
  assert.equal(isProviderSettingsView(view()), true);
  assert.equal(isProviderSettingsView({ ...view(), providers: [{ id: "grok" }] }), false);
  assert.equal(isProviderSettingsView({ ...view(), claude: { configDir: 1 } }), false);
  assert.equal(isProviderSettingsView({ ...view(), claude: null }), true);
});

test("the provider line says installed, version and who is signed in", () => {
  const [grok, claude] = view().providers;
  assert.ok(grok && claude);
  assert.equal(detectedLine(claude), "Installed · 2.1.284 · Signed in as me@example.com (Max)");
  assert.equal(detectedLine(grok), "Installed · grok 1.0.60 · Sign-in is checked when a chat starts");
  assert.equal(detectedLine({ ...claude, detected: { ...claude.detected, signedIn: false, account: null } }), "Installed · 2.1.284 · Not signed in");
  assert.equal(detectedLine({ ...claude, detected: { installed: false, version: null, signedIn: null, message: "x" } }), "Not installed");
});

test("Claude's folder or program counts as changed only when it differs and claude.json reads", () => {
  const shown = view();
  const form = formOf(shown);
  assert.equal(claudeChanged(form, shown), false);
  assert.equal(claudeChanged({ ...form, claude: { ...form.claude, configDir: " ~/.claude-personal " } }, shown), false);
  const moved = { ...form, claude: { ...form.claude, configDir: "~/.claude-work" } };
  assert.equal(claudeChanged(moved, shown), true);
  const broken = { ...shown, claude: shown.claude ? { ...shown.claude, unreadable: true } : null };
  assert.equal(claudeChanged(moved, broken), false);
});

test("a switch or menu posts only the choices, never Claude's fields", () => {
  const form = { ...formOf(view()), claude: { configDir: "~/.claude-half-typed", executable: "" } };
  assert.deepEqual(choicesBody(form), {
    defaultProvider: "grok",
    providers: { grok: { enabled: true, defaultMode: "full" }, claude: { enabled: true, defaultMode: "auto" } },
  });
});
