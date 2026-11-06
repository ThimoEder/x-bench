import { useEffect, useState } from "react";
import type { ProviderView } from "../../server/snapshot.ts";
import { BoardSetup } from "../board/Setup.tsx";
import { ProviderSettings } from "./ProviderSettings.tsx";
import { GeneralSettings } from "./GeneralSettings.tsx";
import { DeviceSettings } from "./DeviceSettings.tsx";
import { RemoteSettings } from "./RemoteSettings.tsx";
import { remotePage } from "../launchToken.ts";
import pkg from "../../package.json" with { type: "json" };
import type { Snapshot } from "../../server/snapshot.ts";

export type SettingsTab = "general" | "providers" | "boards" | "devices" | "remote";

export interface SettingsProps {
  tab: SettingsTab;
  call: (path: string, body?: unknown, method?: string) => Promise<unknown>;
  providers: ProviderView[];
  // The sidebar's width, so the settings list sits where the sidebar was.
  navWidth: number;
  onTab: (tab: SettingsTab) => void;
  // Back to the app, which stays as it was under the page.
  onClose: () => void;
  // The settings the host publishes. Missing before the first snapshot.
  app?: Snapshot["app"];
}

const TABS: { id: SettingsTab; name: string; hint: string }[] = [
  { id: "general", name: "General", hint: "Appearance, chats and sleep" },
  { id: "providers", name: "Providers", hint: "Agents, accounts and defaults" },
  { id: "boards", name: "Boards", hint: "Ticket board connections" },
  { id: "devices", name: "Devices", hint: "Simulators and emulators" },
  { id: "remote", name: "Remote", hint: "Your phone through ngrok or Wi-Fi" },
];

// Settings cover the whole window: the list of sections where the sidebar is, the section beside it.
export function Settings({ tab, call, providers, navWidth, onTab, onClose, app }: SettingsProps) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Remote access and the simulator tools belong to the Mac, and a paired phone cannot reach them.
  const tabs = remotePage() ? TABS.filter((item) => item.id !== "remote" && item.id !== "devices") : TABS;
  const current = tabs.find((item) => item.id === tab) ?? TABS[0];
  const [pinned, setPinned] = useState(false);

  return (
    <div className="settings-page" data-testid="settings" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <nav className="settings-nav" style={{ width: navWidth }} aria-label="Settings">
        <div className="settings-nav-head">
          <button type="button" className="settings-back" data-testid="settings-back" onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path d="M8.75 2.75 4.5 7l4.25 4.25" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Back to app
          </button>
        </div>
        <h2 id="settings-title" className="settings-nav-title">Settings</h2>
        <div className="settings-tabs" role="tablist" aria-orientation="vertical" aria-label="Settings sections">
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`settings-tab-${item.id}`}
              aria-selected={tab === item.id}
              aria-controls="settings-panel"
              data-testid={`settings-tab-${item.id}`}
              onClick={() => onTab(item.id)}
            >
              <span>{item.name}</span>
              <small>{item.hint}</small>
            </button>
          ))}
        </div>
        <span className="settings-version" data-testid="settings-version">v{pkg.version}</span>
      </nav>
      <main
        className={pinned ? "settings-main is-pinned" : "settings-main"}
        onScroll={(event) => {
          // The title's sticky top is negative: it scrolls that far before it pins as the bar.
          const title = event.currentTarget.firstElementChild;
          if (title) setPinned(event.currentTarget.scrollTop > -parseFloat(getComputedStyle(title).top));
        }}
      >
        <h1 className="settings-title">{current?.name}</h1>
        <div className="settings-content" id="settings-panel" role="tabpanel" aria-labelledby={`settings-tab-${tab}`}>
          {tab === "general" ? <GeneralSettings providers={providers} call={call} {...(app ? { app } : {})} /> : tab === "providers" ? <ProviderSettings call={call} /> : tab === "devices" ? <DeviceSettings call={call} /> : tab === "remote" ? <RemoteSettings call={call} /> : <BoardSetup call={call} />}
        </div>
      </main>
    </div>
  );
}
