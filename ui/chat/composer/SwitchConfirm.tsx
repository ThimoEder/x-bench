import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { SwitchPreview } from "../../../server/chat/switchChat.ts";
import { ProviderMark } from "../messages/providerMark.tsx";
import type { SwitchChoice } from "./switchModels.ts";
import type { SessionCall } from "../Transcript.tsx";
import { formatTokens } from "../messages/Wrinkle.tsx";
import { leaveRef } from "../../leaveRef.ts";

export interface SwitchConfirmProps {
  choice: SwitchChoice;
  // The chat's provider now.
  fromLabel: string;
  act: SessionCall;
  onClose: () => void;
}

function isPreview(value: unknown): value is SwitchPreview {
  return typeof value === "object" && value !== null && typeof (value as SwitchPreview).tokens === "number";
}

// Says what moving the chat to another provider does, every time, before it happens.
export function SwitchConfirm({ choice, fromLabel, act, onClose }: SwitchConfirmProps) {
  const [preview, setPreview] = useState<SwitchPreview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // The arrow's menu, which offers the handoff the main button does not: a summary or plain text.
  const [more, setMore] = useState(false);
  const go = useRef<HTMLButtonElement | null>(null);
  const body = { provider: choice.provider, model: choice.model };

  const loadPreview = useEffectEvent(() => {
    let live = true;
    act("/api/switch/preview", body, "POST", { silent: true })
      .then((data) => {
        if (live && isPreview(data)) setPreview(data);
      })
      .catch((reason: unknown) => {
        if (live) setError(reason instanceof Error ? reason.message : "The switch could not be prepared.");
      });
    return () => {
      live = false;
    };
  });
  // The choice is fixed for the dialog's life.
  useEffect(() => loadPreview(), []);

  useEffect(() => {
    if (preview) go.current?.focus();
  }, [preview]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && !busy) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  // The host answers at once and moves the chat in the background, where the transcript shows its progress.
  async function confirm(handoff?: "summary" | "text") {
    setBusy(true);
    setError("");
    setMore(false);
    try {
      await act("/api/switch", handoff ? { ...body, handoff } : body, "POST", { silent: true });
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The switch failed.");
      setBusy(false);
    }
  }

  const to = choice.label;
  const long = Boolean(preview && preview.tokens > preview.cap);
  const share = preview ? Math.min(100, Math.round((preview.tokens / preview.cap) * 100)) : 0;
  // The way the main button goes, and the other way behind its arrow.
  const other = preview?.summarize ? "text" : "summary";
  return (
    <div className="switch-scrim" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <div className="switch-confirm" role="dialog" aria-modal="true" aria-labelledby="switch-title" data-testid="switch-confirm">
        <h3 id="switch-title">
          <ProviderMark provider={choice.provider} />
          Continue this chat on {choice.name}?
        </h3>
        {!preview && !error ? <p className="switch-note">Checking what {to} would read…</p> : null}
        {preview ? (
          <>
            <ul>
              {preview.summarize ? (
                <li>
                  <b>This chat is too long to pass on whole.</b> {fromLabel} writes a summary first, and {to} reads it with the last two exchanges.
                </li>
              ) : long ? (
                <li>
                  <b>{preview.blocked}, so {to} reads this chat as text:</b> the newest part that fits, about {formatTokens(preview.textTokens)} tokens.
                </li>
              ) : null}
              {preview.resumes ? (
                <li>
                  <b>{to} picks up its earlier session</b> of this chat, with its own history and tool results, and reads what happened since{preview.summarize ? " as that summary" : " as text"}.
                </li>
              ) : long ? null : (
                <li>
                  <b>{to} reads this chat as text:</b> your messages, the replies, and one line per tool call.
                </li>
              )}
              <li>Tool results, permissions and the files {fromLabel} read stay with {fromLabel}.</li>
              <li>Everything so far stays on screen above a line.</li>
              {preview.resumes ? <li>If {to} no longer has that session, it starts a new one and reads the whole chat that way.</li> : null}
            </ul>
            <div className={long ? "switch-cost over" : "switch-cost"}>
              <span>{formatTokens(preview.tokens)} tokens</span>
              <span className="switch-meter" aria-hidden="true">
                <i style={{ width: `${share}%` }} />
              </span>
              <span>{long ? `over ${formatTokens(preview.cap)}` : `of ${formatTokens(preview.cap)}`}</span>
            </div>
          </>
        ) : null}
        {error ? (
          <p className="switch-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="switch-actions">
          <button type="button" className="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <div className="switch-split">
            <button type="button" className="primary" ref={go} onClick={() => void confirm()} disabled={busy || !preview}>
              {preview?.summarize ? "Summarize and continue" : `Continue on ${to}`}
            </button>
            {preview ? (
              <button
                type="button"
                className="primary switch-more"
                aria-label="More ways to continue"
                aria-haspopup="menu"
                aria-expanded={more}
                disabled={busy}
                onClick={() => setMore((open) => !open)}
              >
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                  <path d="M2.2 3.8 5 6.4 7.8 3.8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            ) : null}
            {more && preview ? (
              <div ref={leaveRef} className="switch-menu" role="menu">
                {other === "summary" ? (
                  <button type="button" role="menuitem" data-testid="switch-summarize" onClick={() => void confirm("summary")}>
                    <b>{preview.blocked ? "Summarize first anyway" : "Summarize first"}</b>
                    <span>
                      {fromLabel} writes a summary that keeps what it learned from files and tools, then {to} reads it. Takes a moment and one more turn on {fromLabel}.
                    </span>
                  </button>
                ) : (
                  <button type="button" role="menuitem" data-testid="switch-text" onClick={() => void confirm("text")}>
                    <b>Skip the summary</b>
                    <span>
                      {to} reads the newest part of this chat as text, about {formatTokens(preview.textTokens)} tokens. No turn on {fromLabel}, for when its plan is used up.
                    </span>
                  </button>
                )}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
