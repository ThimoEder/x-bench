import { useEffect, useState } from "react";
import type { KeyboardEvent } from "react";
import {
  choicesBody,
  claudeChanged,
  detectedLine,
  detectedTone,
  formOf,
  isProviderSettingsView,
  type ProviderForm,
  type ProviderSettingsRow,
  type ProviderSettingsView,
} from "./providerSettings.ts";
import { remotePage } from "../launchToken.ts";

export interface ProviderSettingsProps {
  call: (path: string, body?: unknown, method?: string) => Promise<unknown>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "";
}

// A refusal, and the part of the page it belongs under: a provider's id, "default" or "claude".
interface Refusal {
  scope: string;
  text: string;
}

// The Providers section of Settings. Switches and menus apply at once. Claude's folder and program
// apply on Enter, when the field is left, or when one is chosen. Login stays in each harness: the
// section says how to sign in and never asks for a password or a token.
export function ProviderSettings({ call }: ProviderSettingsProps) {
  const [view, setView] = useState<ProviderSettingsView | null>(null);
  const [form, setForm] = useState<ProviderForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [loadError, setLoadError] = useState("");
  // Claude's new folder or program waits here while the page asks whether to close its open chats.
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    let cancel = false;
    call("/api/providers", null, "GET")
      .then((next) => {
        if (cancel) return;
        if (!isProviderSettingsView(next)) throw new Error("Request failed");
        setView(next);
        setForm(formOf(next));
      })
      .catch((failure: unknown) => {
        if (!cancel) setLoadError(messageOf(failure) || "Request failed");
      });
    return () => {
      cancel = true;
    };
  }, [call]);

  async function post(body: unknown): Promise<ProviderSettingsView> {
    const next = await call("/api/providers", body);
    if (!isProviderSettingsView(next)) throw new Error("Request failed");
    return next;
  }

  // Applies a switch or menu at once. A refusal puts it back and says why under it.
  async function applyChoices(scope: string, next: ProviderForm) {
    if (!view || !form) return;
    setForm(next);
    setRefusal(null);
    setBusy(true);
    try {
      const saved = await post(choicesBody(next));
      setView(saved);
      // Claude's fields keep what is being typed there.
      setForm((current) => ({ ...formOf(saved), claude: current?.claude ?? formOf(saved).claude }));
    } catch (failure) {
      setForm((current) => (current ? { ...current, defaultProvider: formOf(view).defaultProvider, providers: formOf(view).providers } : current));
      setRefusal({ scope, text: messageOf(failure) || "Request failed" });
    } finally {
      setBusy(false);
    }
  }

  function setProvider(id: string, field: "enabled" | "defaultMode", value: boolean | string) {
    if (!form) return;
    const providers = { ...form.providers, [id]: { enabled: true, defaultMode: "", ...form.providers[id], [field]: value } };
    // New chats cannot start on a provider that is off: the first one still on takes over.
    const defaultProvider = providers[form.defaultProvider]?.enabled === false
      ? (Object.keys(providers).find((key) => providers[key]?.enabled) ?? form.defaultProvider)
      : form.defaultProvider;
    applyChoices(id, { ...form, providers, defaultProvider });
  }

  function setClaude(field: keyof ProviderForm["claude"], value: string) {
    setForm((current) => (current ? { ...current, claude: { ...current.claude, [field]: value } } : current));
    setConfirming(false);
    if (refusal?.scope === "claude") setRefusal(null);
  }

  // Claude's folder or program is done: apply it, or ask first when it would close open Claude chats.
  function commitClaude(next: ProviderForm | null = form) {
    if (!view || !next || !claudeChanged(next, view)) return;
    const open = view.providers.find((row) => row.id === "claude")?.openChats ?? 0;
    if (open > 0) {
      setConfirming(true);
      return;
    }
    saveClaude(next);
  }

  async function saveClaude(next: ProviderForm | null = form) {
    if (!next) return;
    setConfirming(false);
    setRefusal(null);
    setBusy(true);
    try {
      const saved = await post({ claude: next.claude });
      setView(saved);
      setForm(formOf(saved));
    } catch (failure) {
      // The typed value stays, so it can be fixed.
      setRefusal({ scope: "claude", text: messageOf(failure) || "Request failed" });
    } finally {
      setBusy(false);
    }
  }

  function keepClaude() {
    if (!view) return;
    setConfirming(false);
    setForm((current) => (current ? { ...current, claude: formOf(view).claude } : current));
  }

  async function choose(kind: "folder" | "binary") {
    if (!form) return;
    try {
      const reply = await call("/api/providers/choose", { kind });
      const picked = typeof reply === "object" && reply !== null && "path" in reply && typeof reply.path === "string" ? reply.path : "";
      if (!picked) return;
      const next = { ...form, claude: { ...form.claude, [kind === "folder" ? "configDir" : "executable"]: picked } };
      setForm(next);
      commitClaude(next);
    } catch (failure) {
      setRefusal({ scope: "claude", text: messageOf(failure) || "Could not open the chooser" });
    }
  }

  if (!view || !form) {
    return (
      <div data-testid="provider-settings">
        {loadError ? <p className="sheet-error">{loadError}</p> : <p className="setup-status">Checking providers…</p>}
      </div>
    );
  }

  const on = view.providers.filter((row) => form.providers[row.id]?.enabled);
  const locked = busy || view.unreadable;

  return (
    <div data-testid="provider-settings">
      <p className="sheet-copy">Choose which agents run chats, where a new chat starts, and how each one works.</p>
      {view.unreadable ? <p className="sheet-error">providers.json in ~/.x-bench does not read. Fix it by hand to change these settings.</p> : null}
      <label className="sheet-field">
        New chats start on
        <select
          value={on.length ? form.defaultProvider : ""}
          disabled={locked || !on.length}
          data-testid="default-provider"
          onChange={(event) => applyChoices("default", { ...form, defaultProvider: event.target.value })}
        >
          {on.length ? on.map((row) => (
            <option key={row.id} value={row.id}>{row.label}</option>
          )) : <option value="">None</option>}
        </select>
      </label>
      {refusal?.scope === "default" ? <Refused text={refusal.text} scope="default" /> : null}
      {view.providers.map((row) => (
        <ProviderBlock
          key={row.id}
          row={row}
          form={form}
          view={view}
          locked={locked}
          refusal={refusal}
          confirming={confirming}
          onProvider={setProvider}
          onClaude={setClaude}
          onCommitClaude={() => commitClaude()}
          onConfirmClaude={() => saveClaude()}
          onKeepClaude={keepClaude}
          onChoose={choose}
        />
      ))}
    </div>
  );
}

function Refused({ text, scope }: { text: string; scope: string }) {
  return <p className="sheet-error" data-testid={`settings-error-${scope}`}>{text}</p>;
}

interface ProviderBlockProps {
  row: ProviderSettingsRow;
  form: ProviderForm;
  view: ProviderSettingsView;
  // A change is on its way to the host, or providers.json cannot be read.
  locked: boolean;
  refusal: Refusal | null;
  confirming: boolean;
  onProvider: (id: string, field: "enabled" | "defaultMode", value: boolean | string) => void;
  onClaude: (field: keyof ProviderForm["claude"], value: string) => void;
  onCommitClaude: () => void;
  onConfirmClaude: () => void;
  onKeepClaude: () => void;
  onChoose: (kind: "folder" | "binary") => void;
}

function ProviderBlock({ row, form, view, locked, refusal, confirming, onProvider, onClaude, onCommitClaude, onConfirmClaude, onKeepClaude, onChoose }: ProviderBlockProps) {
  const prefs = form.providers[row.id];
  const enabled = prefs?.enabled ?? row.enabled;
  const claude = row.id === "claude" ? view.claude : null;
  const tone = detectedTone(row);
  // Enter applies the field, as leaving it does.
  const onEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    onCommitClaude();
  };
  return (
    <section className={enabled ? "provider-block" : "provider-block is-off"} data-testid={`provider-${row.id}`}>
      <header className="provider-head">
        <h3>{row.label}</h3>
        <label className="provider-switch">
          <input
            type="checkbox"
            role="switch"
            checked={enabled}
            disabled={locked}
            data-testid={`provider-enabled-${row.id}`}
            onChange={(event) => onProvider(row.id, "enabled", event.target.checked)}
          />
          {enabled ? "On" : "Off"}
        </label>
      </header>
      <p className="provider-state" data-tone={tone} data-testid={`provider-state-${row.id}`}>
        <span className="provider-dot" aria-hidden="true" />
        {detectedLine(row)}
      </p>
      {row.detected.message ? <p className="provider-note">{row.detected.message}</p> : null}
      {refusal?.scope === row.id ? <Refused text={refusal.text} scope={row.id} /> : null}
      <label className="sheet-field">
        Approval for a new session
        <select
          value={prefs?.defaultMode ?? row.defaultMode}
          disabled={locked}
          data-testid={`default-mode-${row.id}`}
          onChange={(event) => onProvider(row.id, "defaultMode", event.target.value)}
        >
          {row.modes.map((mode) => (
            <option key={mode.id} value={mode.id}>{mode.name}</option>
          ))}
        </select>
      </label>
      {claude ? (
        claude.unreadable ? (
          <p className="sheet-error">claude.json in ~/.x-bench does not read. Fix it by hand. Claude does not start until then.</p>
        ) : (
          <>
            <label className="sheet-field">
              Config folder
              <span className="provider-path">
                <input
                  value={form.claude.configDir}
                  list="claude-folders"
                  spellCheck={false}
                  autoComplete="off"
                  disabled={locked}
                  data-testid="claude-config-dir"
                  onChange={(event) => onClaude("configDir", event.target.value)}
                  onBlur={onCommitClaude}
                  onKeyDown={onEnter}
                />
                {view.canChoose && !remotePage() ? <button type="button" className="text-button" disabled={locked} onClick={() => onChoose("folder")}>Choose…</button> : null}
              </span>
              <span className="provider-hint">
                {claude.configDirSaved ? "Claude keeps this account's login and chats here." : "The folder claude uses in a terminal. Choosing one keeps it, whatever the environment says later."}
              </span>
            </label>
            <datalist id="claude-folders">
              {claude.folders.map((folder) => <option key={folder} value={folder} />)}
            </datalist>
            <label className="sheet-field">
              Claude program
              <span className="provider-path">
                <input
                  value={form.claude.executable}
                  list="claude-binaries"
                  placeholder={claude.installed || "claude"}
                  spellCheck={false}
                  autoComplete="off"
                  disabled={locked}
                  data-testid="claude-executable"
                  onChange={(event) => onClaude("executable", event.target.value)}
                  onBlur={onCommitClaude}
                  onKeyDown={onEnter}
                />
                {view.canChoose && !remotePage() ? <button type="button" className="text-button" disabled={locked} onClick={() => onChoose("binary")}>Choose…</button> : null}
              </span>
              <span className="provider-hint">{claude.installed ? `Empty runs the installed claude, ${claude.installed}.` : "Empty runs the claude on PATH."}</span>
            </label>
            <datalist id="claude-binaries">
              {claude.binaries.map((binary) => <option key={binary} value={binary} />)}
            </datalist>
            {confirming ? (
              <div className="provider-confirm" data-testid="settings-closes">
                <p>
                  This closes the {row.openChats === 1 ? "open Claude chat" : `${row.openChats} open Claude chats`}, which the other account cannot open.
                  {row.openChats === 1 ? " It stays" : " They stay"} in the sidebar.
                </p>
                <div className="sheet-actions">
                  <button type="button" className="text-button" data-testid="claude-keep" onClick={onKeepClaude}>Keep the current one</button>
                  <button type="button" className="primary" data-testid="claude-apply" onClick={onConfirmClaude}>Switch</button>
                </div>
              </div>
            ) : null}
            {refusal?.scope === "claude" ? <Refused text={refusal.text} scope="claude" /> : null}
          </>
        )
      ) : null}
    </section>
  );
}
