import { useEffect, useRef, useState } from "react";
import type { RemoteView } from "../../server/remote/remote.ts";
import type { RemoteKind, TunnelStatus } from "../../server/remote/remoteTunnel.ts";

export interface RemoteSettingsProps {
  call: (path: string, body?: unknown, method?: string) => Promise<unknown>;
}

interface ShownPairing {
  code: string;
  urls: string[];
  expiresAt: number;
  qrs: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isView(value: unknown): value is RemoteView {
  return isRecord(value) && isRecord(value.ngrok) && isRecord(value.local) && Array.isArray(value.devices);
}

function isPairing(value: unknown): value is ShownPairing {
  return isRecord(value) && typeof value.code === "string" && Array.isArray(value.urls) && Array.isArray(value.qrs) && typeof value.expiresAt === "number";
}

function tunnelLine(tunnel: TunnelStatus, off: string): { tone: string; text: string } {
  if (tunnel.state === "on") return { tone: "ok", text: tunnel.url };
  if (tunnel.state === "starting") return { tone: "warn", text: tunnel.error || "Starting…" };
  if (tunnel.state === "failed") return { tone: "warn", text: tunnel.error };
  return { tone: "off", text: off };
}

function when(time: number): string {
  return new Date(time).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

// The Remote tab of Settings: the ngrok tunnel and the local network, each with its own switch, pairing a phone by QR code, and the paired devices.
export function RemoteSettings({ call }: RemoteSettingsProps) {
  const [view, setView] = useState<RemoteView | null>(null);
  const [authtoken, setAuthtoken] = useState("");
  const [domain, setDomain] = useState<string | null>(null);
  const [pairing, setPairing] = useState<ShownPairing | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const pairingRef = useRef(pairing);
  pairingRef.current = pairing;

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    try {
      const next = await action();
      if (isView(next)) setView(next);
      setError("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    let live = true;
    const read = () => {
      call("/api/remote", null, "GET").then((next) => {
        if (live && isView(next)) setView(next);
      }, () => {});
      setNow(Date.now());
    };
    read();
    const timer = window.setInterval(read, 2000);
    return () => {
      live = false;
      window.clearInterval(timer);
      if (pairingRef.current) void call("/api/remote/pairing", {}, "DELETE").catch(() => {});
    };
  }, [call]);

  // The host ends the pairing once a phone used the code, or when it expired. A tunnel turning on or off changes
  // its links, so the shown QR codes go and Pair a phone makes current ones.
  const shown =
    pairing && view?.pairing?.code === pairing.code && view.pairing.urls.join(" ") === pairing.urls.join(" ") && pairing.expiresAt > now ? pairing : null;

  async function pair() {
    setBusy(true);
    try {
      const next = await call("/api/remote/pairing", {});
      if (!isPairing(next)) throw new Error("Request failed");
      setPairing(next);
      setView((current) => (current ? { ...current, pairing: { code: next.code, urls: next.urls, expiresAt: next.expiresAt } } : current));
      setNow(Date.now());
      setError("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  function stopPairing() {
    setPairing(null);
    void call("/api/remote/pairing", {}, "DELETE").catch(() => {});
  }

  if (!view) {
    return (
      <div data-testid="remote-settings">
        {error ? <p className="sheet-error">{error}</p> : <p className="setup-status">Reading remote access…</p>}
      </div>
    );
  }

  const domainValue = domain ?? view.domain;
  const canSave = !busy && (Boolean(authtoken.trim()) || domainValue !== view.domain);
  const on = view.ngrok.tunnel.state === "on" || view.local.tunnel.state === "on";

  function toggle(kind: RemoteKind, enabled: boolean) {
    void run(() => call("/api/remote/enabled", { kind, enabled }));
  }

  const shownView = view;
  function head(kind: RemoteKind, title: string, disabled: boolean) {
    const line = tunnelLine(shownView[kind].tunnel, kind === "ngrok" && !shownView.hasAuthtoken ? "Add your ngrok authtoken to turn it on" : "Off");
    return (
      <>
        <header className="provider-head">
          <h3>{title}</h3>
          <label className="provider-switch">
            <input
              type="checkbox"
              role="switch"
              checked={shownView[kind].enabled}
              disabled={disabled}
              data-testid={`remote-enabled-${kind}`}
              onChange={(event) => toggle(kind, event.target.checked)}
            />
            {shownView[kind].enabled ? "On" : "Off"}
          </label>
        </header>
        <p className="provider-state" data-tone={line.tone} data-testid={`remote-state-${kind}`}>
          <span className="provider-dot" aria-hidden="true" />
          <span className="remote-line">{line.text}</span>
        </p>
      </>
    );
  }

  return (
    <div data-testid="remote-settings">
      <p className="sheet-copy">Open X Bench from your phone through an ngrok tunnel from anywhere, or on this Mac's Wi-Fi. Both can run at once. The agents, files and chats stay on this Mac. Only devices you pair here get in.</p>
      <section className={view.ngrok.enabled ? "provider-block" : "provider-block is-off"}>
        {head("ngrok", "ngrok", busy || (!view.ngrok.enabled && !view.hasAuthtoken))}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              const next = await call("/api/remote/settings", { authtoken, domain: domainValue });
              setAuthtoken("");
              setDomain(null);
              return next;
            });
          }}
        >
          <label className="sheet-field">
            Authtoken
            <input
              type="password"
              value={authtoken}
              onChange={(event) => setAuthtoken(event.target.value)}
              placeholder={view.hasAuthtoken ? "Stored token stays if this is empty" : "From dashboard.ngrok.com"}
              spellCheck={false}
              autoComplete="off"
              data-testid="remote-authtoken"
            />
          </label>
          <label className="sheet-field">
            Domain
            <input
              value={domainValue}
              onChange={(event) => setDomain(event.target.value)}
              placeholder="Empty uses your account's dev domain"
              spellCheck={false}
              autoComplete="off"
              data-testid="remote-domain"
            />
            <span className="provider-hint">A change applies the next time ngrok turns on.</span>
          </label>
          <div className="sheet-actions provider-actions">
            <button type="submit" className="device-recheck" disabled={!canSave}>Save</button>
          </div>
        </form>
      </section>
      <section className={view.local.enabled ? "provider-block" : "provider-block is-off"}>
        {head("local", "Local network", busy)}
        <p className="provider-note">
          For a phone on the same Wi-Fi. It needs this Mac's certificate once: show it in Finder, AirDrop it to the iPhone, install it in Settings, General, VPN &amp; Device Management, then turn it on in Settings, General, About, Certificate Trust Settings.
        </p>
        <div className="sheet-actions provider-actions">
          <button type="button" className="device-recheck remote-certificate" disabled={busy} onClick={() => void run(() => call("/api/remote/certificate", {}))} data-testid="remote-certificate">
            Show certificate in Finder
          </button>
        </div>
      </section>
      <section className="provider-block">
        <header className="provider-head">
          <h3>Paired devices</h3>
        </header>
        {shown ? (
          <div className="remote-pairing" data-testid="remote-pairing">
            {shown.qrs.map((qr, index) => (
              <figure key={shown.urls[index]}>
                <img className="remote-qr" alt="QR code to pair a phone" src={`data:image/svg+xml;utf8,${encodeURIComponent(qr)}`} />
                <figcaption>{new URL(shown.urls[index] ?? "").host}</figcaption>
              </figure>
            ))}
            <div>
              <p className="provider-note">Scan a code with the phone's camera, or open its address with /pair and type the code.</p>
              <code className="remote-code">{shown.code}</code>
              <p className="provider-hint">Works once, for {Math.max(0, Math.ceil((shown.expiresAt - now) / 1000))} more seconds.</p>
              <button type="button" className="device-recheck" onClick={stopPairing}>Cancel</button>
            </div>
          </div>
        ) : (
          <button type="button" className="primary remote-pair" disabled={busy || !on} onClick={() => void pair()} data-testid="remote-pair">
            Pair a phone
          </button>
        )}
        {view.devices.length ? (
          <ul className="remote-devices">
            {view.devices.map((device) => (
              <li key={device.id} data-testid={`remote-device-${device.id}`}>
                <span>
                  <strong>{device.name}</strong>
                  <small>Paired {when(device.pairedAt)} · last used {when(device.lastUsed)}</small>
                </span>
                <button type="button" className="device-recheck" disabled={busy} onClick={() => void run(() => call(`/api/remote/devices/${device.id}`, {}, "DELETE"))}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="provider-note">No device is paired yet.</p>
        )}
      </section>
      {error ? <p className="sheet-error">{error}</p> : null}
    </div>
  );
}
