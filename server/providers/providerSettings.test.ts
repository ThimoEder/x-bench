import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Provider } from "../../bridge/provider.ts";
import { createProviders } from "./providers.ts";
import { createProviderSettings, memoryProviderSettings } from "./providerSettings.ts";
import type { SessionIndexStore } from "../chat/sessionIndex.ts";

const index: SessionIndexStore = {
  all: () => [],
  get: () => null,
  chatOf: () => null,
  record: (entry) => ({ harnessId: entry.id, cwd: "", title: "", createdAt: "", updatedAt: "", ...entry }),
  drop() {},
};

// Only what the registry reads of a provider. catalog names the stored sessions it reports.
function provider(id: string, modes: string[], defaultMode: string, catalog: string[] = []): Provider {
  return { id, label: id, modes: modes.map((mode) => ({ id: mode, name: mode })), defaultMode, getSession: () => null, catalog: new Map(catalog.map((sessionId) => [sessionId, { sessionId }])) } as unknown as Provider;
}

const grok = provider("grok", ["full", "acceptEdits", "plan"], "full");
const claude = provider("claude", ["ask", "acceptEdits", "plan", "auto", "full"], "auto", ["stored"]);

test("without settings every provider is on, the first is the default, and each starts in its own mode", () => {
  const providers = createProviders([grok, claude], index);
  assert.deepEqual(providers.enabled().map((item) => item.id), ["grok", "claude"]);
  assert.equal(providers.defaultProvider().id, "grok");
  assert.equal(providers.defaultMode(claude), "auto");
});

test("the default provider is the chosen one while it is on, else the first that is on", () => {
  const settings = memoryProviderSettings({ defaultProvider: "claude", providers: { claude: { defaultMode: "plan" } } });
  const providers = createProviders([grok, claude], index, settings);
  assert.equal(providers.defaultProvider().id, "claude");
  assert.equal(providers.defaultMode(claude), "plan");
  settings.save({ defaultProvider: "claude", providers: { claude: { enabled: false }, grok: { defaultMode: "auto" } } });
  assert.equal(providers.isEnabled(claude), false);
  assert.equal(providers.defaultProvider().id, "grok");
  // Grok has no auto mode, so it keeps its own.
  assert.equal(providers.defaultMode(grok), "full");
  // A session the index does not know goes to the provider whose catalog lists it, else to the default.
  assert.equal(providers.forSession("stored").id, "claude");
  assert.equal(providers.forSession("unknown").id, "grok");
});

test("providers.json round-trips, and one that does not read is left alone", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "x-bench-provider-settings-"));
  const file = path.join(folder, "providers.json");
  try {
    const store = createProviderSettings(file);
    assert.deepEqual(store.read(), { providers: {} });
    assert.equal(store.save({ defaultProvider: "claude", providers: { grok: { enabled: false, defaultMode: "plan" } } }), true);
    assert.deepEqual(createProviderSettings(file).read(), { defaultProvider: "claude", providers: { grok: { enabled: false, defaultMode: "plan" } } });

    fs.writeFileSync(file, "{ broken");
    const broken = createProviderSettings(file);
    assert.deepEqual(broken.read(), { providers: {} });
    assert.equal(broken.unreadable(), true);
    assert.equal(broken.save({ providers: {} }), false);
    assert.equal(fs.readFileSync(file, "utf8"), "{ broken");
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
