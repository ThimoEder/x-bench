import { useRef, useState } from "react";
import type { ProviderUsage } from "../../server/snapshot.ts";
import { ProviderMark } from "../chat/messages/providerMark.tsx";
import { CheckIcon } from "../icons.tsx";
import { leaveRef } from "../leaveRef.ts";
import { useCloseOutside } from "../useCloseOutside.ts";
import { SettingsIcon } from "./icons.tsx";
import { UsageDetails } from "./UsageRow.tsx";

interface GearMenuProps {
  // Each provider's usage, drawn as tiles above the items.
  usage?: ProviderUsage[];
  showArchived: boolean;
  onToggleArchived?: () => void;
  onOpenSetup?: () => void;
  onCheckUpdates?: () => void;
  waitingUpdate?: string | null;
  placement?: "up" | "down";
  testId?: string;
}

export function GearMenu({ usage, showArchived, onToggleArchived, onOpenSetup, onCheckUpdates, waitingUpdate, placement = "down", testId = "open-setup" }: GearMenuProps) {
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  // The tile whose details show, kept while they fold away so they shrink out whole.
  const [usageShown, setUsageShown] = useState<{ provider: string; open: boolean } | null>(null);
  const shownUsage = usage?.find((item) => item.provider === usageShown?.provider);

  useCloseOutside(menuOpen, rootRef, () => setMenuOpen(false));

  return (
    <span className={placement === "up" ? "gear-menu is-up" : "gear-menu"} ref={rootRef}>
      <button
        type="button"
        className={waitingUpdate ? "icon has-update" : "icon"}
        data-testid={testId}
        aria-label={waitingUpdate ? `Options, X Bench ${waitingUpdate} is available` : "Options"}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => {
          setMenuOpen((current) => !current);
          setUsageShown(null);
        }}
      >
        <SettingsIcon />
      </button>
      {menuOpen ? (
        <div ref={leaveRef} className="session-menu gear-menu-panel" role="menu" data-testid="options-menu">
          {usage?.length ? (
            <div className="gear-usage" data-testid="gear-usage">
              <h3>Usage</h3>
              <div className="gear-usage-tiles">
                {usage.map((item) => (
                  <button
                    type="button"
                    key={item.provider}
                    className="gear-usage-item"
                    data-level={item.percent >= 90 ? "high" : undefined}
                    aria-expanded={usageShown?.open === true && usageShown.provider === item.provider}
                    onClick={() => setUsageShown((current) => ({ provider: item.provider, open: !(current?.open && current.provider === item.provider) }))}
                  >
                    <ProviderMark provider={item.provider} />
                    <span>{item.label}</span>
                    <b>{item.percent}%</b>
                  </button>
                ))}
              </div>
              <div className="gear-usage-more" data-open={usageShown?.open ? "" : undefined}>
                <div>{shownUsage ? <UsageDetails usage={shownUsage} /> : null}</div>
              </div>
            </div>
          ) : null}
          <button
            type="button"
            role="menuitemcheckbox"
            data-testid="show-archived"
            aria-checked={showArchived ? "true" : "false"}
            onClick={() => onToggleArchived?.()}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3.5" y="4.5" width="17" height="4" rx="1.2" />
              <path d="M5 8.5v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-9M10 12.5h4" />
            </svg>
            Show archived threads
            {showArchived ? (
              <span className="option-check">
                <CheckIcon />
              </span>
            ) : null}
          </button>
          {onCheckUpdates ? (
            <button
              type="button"
              role="menuitem"
              data-testid="options-updates"
              onClick={() => {
                setMenuOpen(false);
                onCheckUpdates();
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M19 12a7 7 0 1 1-2.1-5" />
                <path d="M19 4.5V9h-4.5" />
              </svg>
              {waitingUpdate ? `Update to ${waitingUpdate}` : "Check for updates…"}
              {waitingUpdate ? <span className="update-dot menu-update-dot" aria-hidden="true" /> : null}
            </button>
          ) : null}
          <button
            type="button"
            role="menuitem"
            data-testid="options-settings"
            onClick={() => {
              setMenuOpen(false);
              onOpenSetup?.();
            }}
          >
            <SettingsIcon />
            Settings
          </button>
        </div>
      ) : null}
    </span>
  );
}
