import { useEffect, useState } from "react";
import type { StretchStart } from "../../../server/chat/chatRecords.ts";
import type { Switching } from "../../../server/chat/switchChat.ts";
import { apiFetch } from "../../launchToken.ts";
import { ProviderMark } from "./providerMark.tsx";

export interface WrinkleProps {
  sessionId: string;
  // The stretch this line begins: 1 for the second stretch of the chat.
  stretch: number;
  start: StretchStart | null;
  toProvider: string;
  toModel: string;
  label(provider: string): string;
}

// A wrinkled hairline: an irregular zig-zag with a few sharper folds, the same for the same stretch.
export function wrinklePath(seed: number, width = 640, height = 18): string {
  let state = seed * 7919 + 17;
  const random = () => {
    state = (state * 16807) % 2147483647;
    return state / 2147483647;
  };
  const middle = height / 2;
  let x = 0;
  let path = `M0 ${middle}`;
  while (x < width) {
    x = Math.min(width, x + 6 + random() * 16);
    const fold = random() < 0.18 ? 2.2 : 1;
    path += ` L${x.toFixed(1)} ${(middle + (random() - 0.5) * 6 * fold).toFixed(1)}`;
  }
  return path;
}

export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
}

// What the next provider got: its own session back, the chat as text, or a summary.
export function wrinkleNote(start: StretchStart, to: string, from = ""): string {
  const what = start.summarized ? "a summary" : `${formatTokens(start.tokens)} tokens`;
  const left = start.summaryFailed ? `, since ${from || "the other model"} could not summarize` : start.cut && !start.summarized ? ", oldest entries left out" : "";
  if (start.resumed) return start.tokens ? `${to} picked up its session and reads ${what} it missed${left}` : `${to} picked up its session`;
  return `${to} reads ${what} of this chat${left}`;
}

// The line in the transcript where the chat moved to another provider.
export function Wrinkle({ sessionId, stretch, start, toProvider, toModel, label }: WrinkleProps) {
  const [handoff, setHandoff] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const to = label(toProvider);

  async function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (handoff !== null) return;
    try {
      const response = await apiFetch(`/api/handoff?sessionId=${encodeURIComponent(sessionId)}&stretch=${stretch}`);
      const body = (await response.json()) as { text?: string; error?: string };
      setHandoff(body.text ?? body.error ?? "");
    } catch {
      setHandoff("The handoff could not be read.");
    }
  }

  return (
    <div className={open ? "wrinkle show-handoff" : "wrinkle"} data-testid="wrinkle" role="separator" aria-label={`Continued on ${toModel || to}`}>
      <div className="wrinkle-line">
        <svg viewBox="0 0 640 18" preserveAspectRatio="none" aria-hidden="true">
          <path d={wrinklePath(stretch)} vectorEffect="non-scaling-stroke" />
        </svg>
        <span className="wrinkle-tag">
          {start ? (
            <>
              <ProviderMark provider={start.fromProvider} />
              {start.fromModel || label(start.fromProvider)}
              <span className="wrinkle-arrow">→</span>
            </>
          ) : null}
          <ProviderMark provider={toProvider} />
          <b>{toModel || to}</b>
        </span>
      </div>
      {start ? (
        <span className="wrinkle-note">
          {wrinkleNote(start, to, label(start.fromProvider))}
          {start.tokens ? (
            <button type="button" onClick={() => void toggle()} aria-expanded={open}>
              What {to} read
            </button>
          ) : null}
        </span>
      ) : null}
      {open ? <pre className="wrinkle-handoff">{handoff ?? "Loading…"}</pre> : null}
    </div>
  );
}

export interface PendingWrinkleProps {
  switching: Switching;
  // The chat has earlier stretches, which seed the line the way the settled one will be drawn.
  stretch: number;
  label(provider: string): string;
  onCancel?: () => void;
}

function elapsed(since: number, now: number) {
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

// The line while the chat moves to another provider: a light runs along it until the new model is ready.
export function PendingWrinkle({ switching, stretch, label, onCancel }: PendingWrinkleProps) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const path = wrinklePath(stretch);
  const text = switching.summarizing
    ? `${label(switching.from)} is summarizing for ${label(switching.to)}`
    : `Opening ${switching.toModel || label(switching.to)}`;
  return (
    <div className="wrinkle is-pending" data-testid="wrinkle-pending" role="status" aria-label={text}>
      <div className="wrinkle-line">
        <svg viewBox="0 0 640 18" preserveAspectRatio="none" aria-hidden="true">
          <path d={path} vectorEffect="non-scaling-stroke" />
          <path className="wrinkle-pulse" d={path} pathLength={660} vectorEffect="non-scaling-stroke" />
        </svg>
        <span className="wrinkle-tag">
          <span className="wrinkle-breathe">
            <ProviderMark provider={switching.summarizing ? switching.from : switching.to} />
          </span>
          <span className="wrinkle-shimmer">{text}</span>
        </span>
      </div>
      <span className="wrinkle-note">
        <span className="wrinkle-timer">{elapsed(switching.startedAt, now)}</span>
        {onCancel && !switching.committing ? (
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
      </span>
    </div>
  );
}
