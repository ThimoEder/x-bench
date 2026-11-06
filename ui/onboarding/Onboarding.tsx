import { useCallback, useEffect, useRef, useState } from "react";
import { ProviderMark } from "../chat/messages/providerMark.tsx";
import type { ThemeSetting } from "../theme.ts";
import { useCopy } from "../useCopy.ts";
import { useTheme } from "../useTheme.ts";
import {
  choicesBody,
  detectedLine,
  detectedTone,
  formOf,
  isProviderSettingsView,
  type ProviderForm,
  type ProviderSettingsRow,
  type ProviderSettingsView,
} from "../settings/providerSettings.ts";

export const ONBOARDED_KEY = "x-bench-onboarded";

// Installed, reporting no problem, and not known to be signed out. Some agents only find out when a chat starts.
export function isReady(row: ProviderSettingsRow, form: ProviderForm): boolean {
  const { installed, signedIn, message } = row.detected;
  return Boolean(form.providers[row.id]?.enabled) && installed && !message && signedIn !== false;
}

export function installedDefaults(view: ProviderSettingsView, touched: ReadonlySet<string>): ProviderForm | null {
  if (view.unreadable) return null;
  const form = formOf(view);
  let changed = false;
  for (const row of view.providers) {
    const choice = form.providers[row.id];
    if (!choice || touched.has(row.id) || choice.enabled === row.detected.installed) continue;
    form.providers[row.id] = { ...choice, enabled: row.detected.installed };
    changed = true;
  }
  if (!changed) return null;
  // New chats cannot start on a provider that is off: the first one still on takes over.
  if (!form.providers[form.defaultProvider]?.enabled) form.defaultProvider = view.providers.find((row) => form.providers[row.id]?.enabled)?.id ?? form.defaultProvider;
  return form;
}

export function setupCommand(row: ProviderSettingsRow): { text: string; command: string } | null {
  const { command, installed } = row.detected;
  if (!command) return null;
  return { text: installed ? "Sign in" : "Install it, then sign in", command };
}

export interface OnboardingProps {
  call: (path: string, body?: unknown, method?: string) => Promise<unknown>;
  // startChat is true when the person left through the last step's button.
  onDone: (startChat: boolean) => void;
}

type Step = "welcome" | "agents" | "done";
const STEPS: Step[] = ["welcome", "agents", "done"];

const THEMES: { id: ThemeSetting; name: string }[] = [
  { id: "light", name: "Light" },
  { id: "dark", name: "Dark" },
  { id: "system", name: "System" },
];

// First launch: pick a theme and connect an agent, then hand over to the app. Every choice here is also in Settings.
export function Onboarding({ call, onDone }: OnboardingProps) {
  const [step, setStep] = useState<Step>("welcome");
  // A page slides in from the side it lies on: the next one from the right, the previous one from the left.
  const [back, setBack] = useState(false);
  const [, chooseTheme, themeSetting] = useTheme();
  const stage = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<ProviderSettingsView | null>(null);
  const [form, setForm] = useState<ProviderForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // The providers whose switch the person flipped here.
  const touched = useRef(new Set<string>());

  const show = useCallback((next: unknown) => {
    if (!isProviderSettingsView(next)) throw new Error("Request failed");
    setView(next);
    setForm(formOf(next));
    setError("");
    return next;
  }, []);

  const check = useCallback(() => {
    call("/api/providers", null, "GET")
      .then((next) => {
        const wanted = installedDefaults(show(next), touched.current);
        if (!wanted) return undefined;
        // The switches wait for this save, so a later flip cannot be overwritten by its answer.
        setBusy(true);
        return call("/api/providers", choicesBody(wanted))
          .then(show)
          .finally(() => setBusy(false));
      })
      .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : "Request failed"));
  }, [call, show]);

  useEffect(check, [check]);

  useEffect(() => stage.current?.focus(), [step]);

  // A sign-in happens in the terminal, so coming back to the window checks again.
  useEffect(() => {
    if (step !== "agents") return;
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, [step, check]);

  // True once the host saved it.
  async function apply(next: ProviderForm): Promise<boolean> {
    if (!view) return false;
    setForm(next);
    setBusy(true);
    try {
      show(await call("/api/providers", choicesBody(next)));
      return true;
    } catch (failure) {
      setForm(formOf(view));
      setError(failure instanceof Error ? failure.message : "Request failed");
      return false;
    } finally {
      setBusy(false);
    }
  }

  function toggle(id: string, enabled: boolean) {
    if (!form) return;
    touched.current.add(id);
    const providers = { ...form.providers, [id]: { defaultMode: "", ...form.providers[id], enabled } };
    // New chats cannot start on a provider that is off: the first one still on takes over.
    const defaultProvider = providers[form.defaultProvider]?.enabled === false
      ? (Object.keys(providers).find((key) => providers[key]?.enabled) ?? form.defaultProvider)
      : form.defaultProvider;
    apply({ ...form, providers, defaultProvider }).catch(() => {});
  }

  function go(next: Step) {
    setBack(STEPS.indexOf(next) < STEPS.indexOf(step));
    setStep(next);
  }

  const ready = view && form ? view.providers.filter((row) => isReady(row, form)) : [];

  // New chats start on an agent that can run them.
  async function finishAgents() {
    const first = ready[0];
    if (form && first && !ready.some((row) => row.id === form.defaultProvider) && !(await apply({ ...form, defaultProvider: first.id }))) return;
    go("done");
  }

  return (
    <div className="onboarding" data-testid="onboarding" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
      <div className="onboarding-steps" aria-hidden="true">
        {STEPS.map((item, index) => <span key={item} className={index <= STEPS.indexOf(step) ? "is-on" : undefined} />)}
      </div>
      {step === "welcome" ? (
        <div key={step} className="onboarding-stage" data-from={back ? "left" : "right"} ref={stage} tabIndex={-1}>
          <Logo />
          <h1 id="onboarding-title">Welcome to X Bench</h1>
          <p className="lede">X Bench runs the coding agents you already use, right in your project folders. Connect one and you can start.</p>
          <div className="onboarding-themes" role="radiogroup" aria-label="Theme">
            {THEMES.map((item) => (
              <button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={themeSetting === item.id}
                className={themeSetting === item.id ? "is-on" : undefined}
                data-testid={`onboarding-theme-${item.id}`}
                onClick={() => chooseTheme(item.id)}
              >
                <span className="onboarding-thumb" data-theme-preview={item.id} aria-hidden="true"><i /><i /><i /></span>
                {item.name}
              </button>
            ))}
          </div>
          <div className="onboarding-actions">
            <button type="button" data-testid="onboarding-skip" onClick={() => onDone(false)}>Skip</button>
            <button type="button" className="primary" data-testid="onboarding-start" onClick={() => go("agents")}>Get started</button>
          </div>
        </div>
      ) : step === "agents" ? (
        <div key={step} className="onboarding-stage is-top" data-from={back ? "left" : "right"} ref={stage} tabIndex={-1}>
          <h1 id="onboarding-title">Connect an agent</h1>
          <p className="lede">Each agent signs in with its own app in a terminal. X Bench never asks for a password.</p>
          <div className="onboarding-list">
            {!view || !form ? (
              error ? null : <p className="setup-status">Checking agents…</p>
            ) : view.providers.map((row) => (
              <AgentCard key={row.id} row={row} enabled={Boolean(form.providers[row.id]?.enabled)} locked={busy || view.unreadable} onToggle={toggle} />
            ))}
            {error ? <p className="sheet-error">{error}</p> : null}
            {view && form && ready.length > 1 ? (
              <label className="onboarding-row">
                New chats start on
                <select
                  value={ready.some((row) => row.id === form.defaultProvider) ? form.defaultProvider : ready[0]?.id}
                  disabled={busy}
                  data-testid="onboarding-default"
                  onChange={(event) => apply({ ...form, defaultProvider: event.target.value }).catch(() => {})}
                >
                  {ready.map((row) => <option key={row.id} value={row.id}>{row.label}</option>)}
                </select>
              </label>
            ) : (
              <div className="onboarding-row">
                <span>{ready.length ? "" : "Signed in somewhere else? Check again."}</span>
                <button type="button" className="text-button" data-testid="onboarding-check" onClick={check}>Check again</button>
              </div>
            )}
          </div>
          <div className="onboarding-actions">
            <button type="button" onClick={() => go("welcome")}>Back</button>
            <button type="button" className="primary" data-testid="onboarding-continue" disabled={!ready.length || busy} onClick={() => finishAgents().catch(() => {})}>Continue</button>
          </div>
        </div>
      ) : (
        <div key={step} className="onboarding-stage" data-from={back ? "left" : "right"} ref={stage} tabIndex={-1}>
          <h1 id="onboarding-title">You're set</h1>
          <p className="lede">Change agents and the theme any time in Settings.</p>
          <ul className="onboarding-done">
            {ready.map((row) => (
              <li key={row.id}>
                <ProviderMark provider={row.id} />
                {row.label}{row.id === form?.defaultProvider ? " · new chats start here" : ""}
              </li>
            ))}
          </ul>
          <div className="onboarding-actions">
            <button type="button" className="primary" data-testid="onboarding-finish" onClick={() => onDone(true)}>Start a chat</button>
          </div>
        </div>
      )}
    </div>
  );
}

// Keep in step with the launch screen's icon in index.html.
function Logo() {
  return (
    <svg className="onboarding-logo" viewBox="100 100 824 824" aria-hidden="true">
      <defs>
        <linearGradient id="onboarding-plate" x1="0" y1="0" x2="0" y2="1"><stop offset="0" className="plate-top" /><stop offset="1" className="plate-bottom" /></linearGradient>
        <linearGradient id="onboarding-right" x1="0" y1="0" x2="1" y2="1"><stop offset="0" className="right-top" /><stop offset="1" className="right-bottom" /></linearGradient>
      </defs>
      <rect x="100" y="100" width="824" height="824" rx="185" fill="url(#onboarding-plate)" />
      <path className="left" d="M300 318 L446 512 L300 706" fill="none" strokeWidth="100" strokeLinecap="round" strokeLinejoin="round" />
      <path className="right" d="M724 318 L578 512 L724 706" fill="none" stroke="url(#onboarding-right)" strokeWidth="100" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

interface AgentCardProps {
  row: ProviderSettingsRow;
  enabled: boolean;
  locked: boolean;
  onToggle: (id: string, enabled: boolean) => void;
}

function AgentCard({ row, enabled, locked, onToggle }: AgentCardProps) {
  const fix = enabled || !row.detected.installed ? setupCommand(row) : null;
  const [copied, copy] = useCopy(fix?.command ?? "");
  return (
    <section className={`provider-block${enabled ? "" : " is-off"}${enabled && detectedTone(row) === "ok" ? " is-ready" : ""}`} data-testid={`onboarding-${row.id}`}>
      <header className="provider-head">
        <h3><ProviderMark provider={row.id} />{row.label}</h3>
        <label className="provider-switch">
          <input
            type="checkbox"
            role="switch"
            checked={enabled}
            disabled={locked}
            data-testid={`onboarding-enabled-${row.id}`}
            onChange={(event) => onToggle(row.id, event.target.checked)}
          />
          {enabled ? "On" : "Off"}
        </label>
      </header>
      <p className="provider-state" data-tone={detectedTone(row)}>
        <span className="provider-dot" aria-hidden="true" />
        {detectedLine(row)}
      </p>
      {fix ? (
        <div className="onboarding-fix">
          {fix.text}
          <code>{fix.command}</code>
          <button type="button" className="text-button" onClick={copy}>
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      ) : null}
      {enabled && !fix && row.detected.message ? <p className="provider-note">{row.detected.message}</p> : null}
    </section>
  );
}
