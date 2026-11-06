import { useEffect, useRef, useState } from "react";
import type * as React from "react";
import type { BrowserView as BrowserState } from "../../server/snapshot.ts";
import { desktopBridge, isWebUrl, paneCall, usePaneBounds } from "./browserPane.ts";

export interface BrowserViewProps {
  browser: BrowserState;
  // The chat whose tabs the pane shows, and the name of its agent.
  sessionId: string;
  agent?: string;
  // The Browser tab is showing in an open dock.
  visible: boolean;
}

export function BrowserView({ browser, sessionId, agent = "the agent", visible }: BrowserViewProps) {
  const bridge = desktopBridge();
  const slot = useRef<HTMLDivElement | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const tabs = browser.tabs.filter((tab) => tab.owner === sessionId);
  const currentId = browser.active[sessionId];
  const active = tabs.find((tab) => tab.id === currentId) ?? null;
  const [address, setAddress] = useState(active?.url ?? "");
  const [editing, setEditing] = useState(false);
  const [newTab, setNewTab] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!editing) setAddress(active?.url ?? "");
  }, [active?.url, active?.id, editing]);

  usePaneBounds(slot, sessionId, Boolean(bridge && visible && browser.available && active));

  async function act(path: string, body: Record<string, unknown>) {
    setError(await paneCall(path, body));
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const url = address.trim();
    if (!url) return;
    setEditing(false);
    input.current?.blur();
    if (!bridge || !browser.available) {
      const target = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
      if (isWebUrl(target)) window.open(target, "_blank", "noopener");
      return;
    }
    act("/api/browser/open", { url, sessionId, newTab });
    setNewTab(false);
  }

  function startTab() {
    setNewTab(true);
    setEditing(true);
    setAddress("");
    input.current?.focus();
  }

  const canAct = Boolean(bridge && browser.available && active);
  return (
    <section className="browser-view" data-testid="browser-view">
      <form className="browser-bar" onSubmit={submit}>
        <button type="button" className="icon" aria-label="Back" disabled={!canAct || !active?.canGoBack} onClick={() => active && act("/api/browser/tab", { op: "back", tab: active.id })}>
          <ArrowIcon flip />
        </button>
        <button type="button" className="icon" aria-label="Forward" disabled={!canAct || !active?.canGoForward} onClick={() => active && act("/api/browser/tab", { op: "forward", tab: active.id })}>
          <ArrowIcon />
        </button>
        <button
          type="button"
          className="icon"
          aria-label={active?.loading ? "Stop" : "Reload"}
          disabled={!canAct}
          onClick={() => active && act("/api/browser/tab", { op: active.loading ? "stop" : "reload", tab: active.id })}
        >
          {active?.loading ? <StopIcon /> : <ReloadIcon />}
        </button>
        <input
          ref={input}
          className="browser-address"
          aria-label="Address"
          placeholder={newTab ? "Address for a new tab" : "Enter an address"}
          value={address}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onFocus={(event) => {
            setEditing(true);
            event.currentTarget.select();
          }}
          onBlur={() => {
            setEditing(false);
            setNewTab(false);
          }}
          onChange={(event) => setAddress(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            setAddress(active?.url ?? "");
            event.currentTarget.blur();
          }}
        />
        <button
          type="button"
          className="icon"
          aria-label="Open in your browser"
          title="Open in your browser"
          disabled={!active || !isWebUrl(active.url)}
          onClick={() => active && window.open(active.url, "_blank", "noopener")}
        >
          <OutIcon />
        </button>
      </form>
      {tabs.length ? (
        <div className="browser-tabs" role="tablist" aria-label="Browser tabs">
          {tabs.map((tab) => (
            <div key={tab.id} className={tab.id === currentId ? "browser-tab active" : "browser-tab"} role="presentation">
              <button
                type="button"
                role="tab"
                aria-selected={tab.id === currentId}
                className="browser-tab-name"
                title={tab.url}
                onClick={() => act("/api/browser/tab", { op: "switch", tab: tab.id })}
              >
                {tab.loading ? <span className="browser-tab-spin" aria-hidden="true" /> : null}
                {tab.title || hostName(tab.url) || "New tab"}
              </button>
              <button type="button" className="browser-tab-close" aria-label={`Close ${tab.title || "tab"}`} onClick={() => act("/api/browser/tab", { op: "close", tab: tab.id })}>
                ×
              </button>
            </div>
          ))}
          <button type="button" className="browser-tab-new" aria-label="New tab" onClick={startTab} disabled={!bridge || !browser.available}>
            +
          </button>
        </div>
      ) : null}
      {error ? <p className="browser-error" role="alert">{error}</p> : null}
      <div className="browser-slot" ref={slot}>
        {!bridge ? (
          <BrowserEmpty title="The browser runs in the app" text={`Open the X Bench app to browse with ${agent} here. In this tab, an address opens in a new window.`} />
        ) : !browser.available ? (
          <BrowserEmpty title="Connecting to the browser" text="The browser pane is starting." busy />
        ) : !active ? (
          <BrowserEmpty title="Browse with X Bench" text={`Type an address or ask ${agent} to open a site. ${capitalized(agent)} can read, click and type.`} />
        ) : null}
      </div>
    </section>
  );
}

function BrowserEmpty({ title, text, busy = false }: { title: string; text: string; busy?: boolean }) {
  return (
    <div className="browser-empty" data-testid="browser-empty" aria-busy={busy || undefined}>
      <GlobeIcon />
      <p className="browser-empty-title">{title}</p>
      <p className="browser-empty-text">{text}</p>
    </div>
  );
}

function capitalized(name: string): string {
  return name ? `${name.charAt(0).toUpperCase()}${name.slice(1)}` : name;
}

function GlobeIcon() {
  return (
    <svg className="browser-empty-icon" width="40" height="40" viewBox="0 0 24 24" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="9" />
        <path d="M3.5 9h17M3.5 15h17" />
        <path d="M12 3c2.4 2.5 3.6 5.5 3.6 9s-1.2 6.5-3.6 9c-2.4-2.5-3.6-5.5-3.6-9S9.6 5.5 12 3Z" />
      </g>
    </svg>
  );
}

function hostName(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function ArrowIcon({ flip = false }: { flip?: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" style={flip ? { transform: "scaleX(-1)" } : undefined}>
      <path d="M3.5 8h9M9 4.5 12.5 8 9 11.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ReloadIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M12.5 8a4.5 4.5 0 1 1-1.3-3.2M12.5 3v2.6H9.9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4.5 4.5 11.5 11.5M11.5 4.5 4.5 11.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function OutIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M9 3.5h3.5V7M12.5 3.5 7.5 8.5M11 9.5v3H3.5V5h3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
