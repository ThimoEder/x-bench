import type { ProviderView, Snapshot } from "../../server/snapshot.ts";
import { KeepAwakeSwitch } from "./HostSettings.tsx";
import type { Colors, ThemeSetting } from "../theme.ts";
import { FOLLOW_UP_NAMES, followUpChoices, useFollowUp, type FollowUp } from "../chat/useFollowUp.ts";
import { useChatRise } from "../chat/chatRise.ts";
import { useColors, useTheme } from "../useTheme.ts";
import { SIDEBAR_PROVIDERS, useSidebarProvider, type SidebarProvider } from "../sidebar/sidebarProvider.ts";
import { QUIET_LEVELS, useDictationSetting, useQuietLevel } from "./dictationSettings.ts";
import { SpeechModelSetting } from "../voice/SpeechModel.tsx";

const THEMES: { id: ThemeSetting; name: string }[] = [
  { id: "system", name: "System" },
  { id: "light", name: "Light" },
  { id: "dark", name: "Dark" },
];

const COLORS: { id: Colors; name: string }[] = [
  { id: "studio", name: "Studio" },
  { id: "classic", name: "Classic" },
];

export function GeneralSettings({ providers, app, call }: { providers: ProviderView[]; app?: Snapshot["app"]; call?: (path: string, body: Record<string, unknown>) => Promise<unknown> }) {
  const [, chooseTheme, themeSetting] = useTheme();
  const [colors, chooseColors] = useColors();
  const [sidebarProvider, chooseSidebarProvider] = useSidebarProvider();
  const [chatRise, chooseChatRise] = useChatRise();
  const [dictation, chooseDictation] = useDictationSetting("dictation");
  const [lowerVolume, chooseLowerVolume] = useDictationSetting("lowerVolume");
  const [quietLevel, chooseQuietLevel] = useQuietLevel();
  return (
    <div data-testid="general-settings">
      <p className="sheet-copy">Preferences for this window. They apply at once.</p>
      <section className="provider-block">
        <header className="provider-head">
          <h3>Appearance</h3>
        </header>
        <label className="sheet-field provider-first-field">
          Light or dark
          <select value={themeSetting} data-testid="theme-choice" onChange={(event) => chooseTheme(event.target.value as ThemeSetting)}>
            {THEMES.map((item) => (
              <option key={item.id} value={item.id}>{item.name}</option>
            ))}
          </select>
        </label>
        <div className="sheet-field">
          Theme
          <div className="routine-switch" role="group" aria-label="Theme">
            {COLORS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={colors === item.id ? "is-picked" : undefined}
                aria-pressed={colors === item.id}
                data-testid={`colors-${item.id}`}
                onClick={() => chooseColors(item.id)}
              >
                <span className="theme-swatch" data-colors={item.id} aria-hidden="true" />
                {item.name}
              </button>
            ))}
          </div>
        </div>
        <label className="sheet-field">
          Provider in the sidebar
          <select value={sidebarProvider} data-testid="sidebar-provider-choice" onChange={(event) => chooseSidebarProvider(event.target.value as SidebarProvider)}>
            {SIDEBAR_PROVIDERS.map((item) => (
              <option key={item.id} value={item.id}>{item.name}</option>
            ))}
          </select>
        </label>
        <div className="settings-switch-row">
          Animate a chat as it opens
          <label className="provider-switch">
            <input
              type="checkbox"
              role="switch"
              aria-label="Animate a chat as it opens"
              checked={chatRise}
              data-testid="chat-rise"
              onChange={(event) => chooseChatRise(event.target.checked)}
            />
            {chatRise ? "On" : "Off"}
          </label>
        </div>
      </section>
      <section className="provider-block">
        <header className="provider-head">
          <h3>Chats</h3>
        </header>
        <p className="provider-hint provider-first-field">
          How a message sent during a turn goes. Queue waits for the turn to end. Next step reaches Claude at its next step while
          the current step runs on. Steer adds the message at once and interrupts the current step. The composer's menu changes the same choice.
        </p>
        {providers.map((provider) => (
          <FollowUpField key={provider.id} provider={provider} />
        ))}
      </section>
      <section className={dictation ? "provider-block" : "provider-block is-off"}>
        <header className="provider-head">
          <h3>Dictation</h3>
          <label className="provider-switch">
            <input type="checkbox" role="switch" aria-label="Dictation" checked={dictation} data-testid="dictation" onChange={(event) => chooseDictation(event.target.checked)} />
            {dictation ? "On" : "Off"}
          </label>
        </header>
        <p className="provider-hint provider-first-field">Hold Alt or click the mic to talk into the message box. The speech is transcribed on this Mac.</p>
        <div className="settings-switch-row">
          Lower all sound while you dictate
          <label className="provider-switch">
            <input
              type="checkbox"
              role="switch"
              aria-label="Lower all sound while you dictate"
              checked={lowerVolume}
              disabled={!dictation}
              data-testid="lower-volume"
              onChange={(event) => chooseLowerVolume(event.target.checked)}
            />
            {lowerVolume ? "On" : "Off"}
          </label>
        </div>
        <label className="settings-slider-row">
          Volume while you dictate
          <input
            type="range"
            min={QUIET_LEVELS.min}
            max={QUIET_LEVELS.max}
            step={QUIET_LEVELS.step}
            value={quietLevel}
            style={{ "--fill": `${(quietLevel / QUIET_LEVELS.max) * 100}%` }}
            disabled={!dictation || !lowerVolume}
            aria-valuetext={quietLevel ? `${quietLevel}% of your volume` : "Muted"}
            data-testid="quiet-level"
            onChange={(event) => chooseQuietLevel(Number(event.target.value))}
          />
          <output>{quietLevel ? `${quietLevel}%` : "Muted"}</output>
        </label>
        <p className="provider-hint">
          While you dictate, the Mac's volume goes down to this share of what it was, so music, videos and calls play quieter. It comes
          back when you stop.
        </p>
        <SpeechModelSetting />
      </section>
      {call && app?.desktop ? (
        <section className="provider-block" data-testid="misc-block">
          <header className="provider-head">
            <h3>Misc</h3>
          </header>
          <div className="routine-switches">
            <KeepAwakeSwitch app={app} call={call} />
          </div>
          <p className="provider-hint">Every X Bench window on this Mac shares this setting. The Routines page has the same switch.</p>
        </section>
      ) : null}
    </div>
  );
}

function FollowUpField({ provider }: { provider: ProviderView }) {
  const choices = followUpChoices(provider.capabilities);
  const [followUp, chooseFollowUp] = useFollowUp(provider.id, choices);
  return (
    <label className="sheet-field">
      Messages to {provider.label} during a turn
      <select
        value={followUp}
        data-testid={`follow-up-choice-${provider.id}`}
        disabled={choices.length < 2}
        onChange={(event) => chooseFollowUp(event.target.value as FollowUp)}
      >
        {choices.map((choice) => (
          <option key={choice} value={choice}>{FOLLOW_UP_NAMES[choice]}</option>
        ))}
      </select>
    </label>
  );
}
