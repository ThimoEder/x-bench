import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { FormEvent, PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import type { BtwAnswer } from "../../server/chat/btw.ts";
import { MarkdownView } from "./markdown/MarkdownView.tsx";
import { BTW_PLACE_KEY, mergeBtwEntries, readBtwPlace, viewportSize } from "./btw.ts";
import { apiFetch } from "../launchToken.ts";
import type { BtwItem, BtwPlace } from "./btw.ts";

export interface BtwWindowProps {
  sessionId: string;
  cwd?: string;
  ready: boolean;
  question?: string | null;
  seed: number;
  onClose: () => void;
}

export function BtwWindow({ sessionId, cwd, ready, question, seed, onClose }: BtwWindowProps) {
  const rootRef = useRef<HTMLElement | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const placeRef = useRef<BtwPlace | null>(null);
  const [place, setPlace] = useState(() => readBtwPlace(storedPlace(), viewportSize()));
  const [entries, setEntries] = useState<BtwItem[]>([]);
  const [draft, setDraft] = useState("");
  const [asking, setAsking] = useState(false);
  const askedSeed = useRef(0);
  const askingRef = useRef(false);
  const viewEpoch = useRef(0);
  placeRef.current = place;

  useEffect(() => {
    if (!ready) return undefined;
    const epoch = viewEpoch.current;
    let gone = false;
    apiFetch(`/api/btw?sessionId=${encodeURIComponent(sessionId)}`)
      .then((response) => (response.ok ? response.json() : { entries: [] }))
      .then((data: unknown) => {
        if (gone || epoch !== viewEpoch.current) return;
        setEntries((current) => mergeBtwEntries(savedEntries(data), current));
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [sessionId, ready]);

  const askSeeded = useEffectEvent(() => {
    if (!question || askedSeed.current === seed) {
      inputRef.current?.focus();
      return;
    }
    askedSeed.current = seed;
    void ask(question);
  });
  useEffect(() => askSeeded(), [seed]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries, asking]);

  useEffect(() => {
    function onResize() {
      setPlace((current) => {
        const next = readBtwPlace(JSON.stringify(current), viewportSize());
        placeRef.current = next;
        return next;
      });
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  async function ask(text: string) {
    const trimmed = text.trim();
    if (!trimmed || askingRef.current) return;
    const epoch = viewEpoch.current;
    const localId = `local-${Date.now()}`;
    askingRef.current = true;
    setAsking(true);
    setEntries((current) => [...current, { id: localId, question: trimmed, answer: "", pending: true }]);
    try {
      const response = await apiFetch("/api/btw", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, question: trimmed }),
      });
      const data = btwReply(await response.json().catch(() => ({})));
      if (epoch !== viewEpoch.current) return;
      if (!response.ok) throw new Error(data.error || "Side question failed");
      setEntries((current) =>
        current.map((entry) =>
          entry.id === localId ? { ...entry, id: data.id || localId, answer: data.answer || "", pending: false } : entry,
        ),
      );
      const fresh = await apiFetch(`/api/btw?sessionId=${encodeURIComponent(sessionId)}`);
      if (epoch !== viewEpoch.current) return;
      if (fresh.ok) {
        const saved: unknown = await fresh.json();
        setEntries((current) => mergeBtwEntries(savedEntries(saved), current));
      }
    } catch (error) {
      if (epoch !== viewEpoch.current) return;
      setEntries((current) =>
        current.map((entry) =>
          entry.id === localId ? { ...entry, pending: false, error: (error instanceof Error && error.message) || "Side question failed" } : entry,
        ),
      );
    } finally {
      if (epoch === viewEpoch.current) {
        askingRef.current = false;
        setAsking(false);
        inputRef.current?.focus();
      }
    }
  }

  async function clearAside() {
    viewEpoch.current += 1;
    askingRef.current = false;
    setAsking(false);
    setEntries([]);
    setDraft("");
    if (!ready) return;
    try {
      const response = await apiFetch(`/api/btw?sessionId=${encodeURIComponent(sessionId)}`, { method: "DELETE", headers: { "content-type": "application/json" } });
      const data = btwReply(await response.json().catch(() => ({})));
      if (!response.ok) throw new Error(data.error || "Couldn't clear the side chat");
    } catch (error) {
      setEntries([{ id: "clear-error", question: "", answer: "", error: (error instanceof Error && error.message) || "Couldn't clear the side chat" }]);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft;
    setDraft("");
    void ask(text);
  }

  function onDragStart(event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0 || (event.target as Element).closest("button")) return;
    event.preventDefault();
    const origin = placeRef.current!;
    const startX = event.clientX;
    const startY = event.clientY;
    function move(ev: PointerEvent) {
      const next = readBtwPlace(
        JSON.stringify({ ...origin, x: origin.x + ev.clientX - startX, y: origin.y + ev.clientY - startY }),
        viewportSize(),
      );
      placeRef.current = next;
      setPlace(next);
    }
    function up() {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      storePlace(placeRef.current);
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function rememberSize() {
    const el = rootRef.current;
    if (!el) return;
    const next = readBtwPlace(
      JSON.stringify({ ...placeRef.current, width: el.offsetWidth, height: el.offsetHeight }),
      viewportSize(),
    );
    placeRef.current = next;
    setPlace(next);
    storePlace(next);
  }

  const panel = (
    <section
      ref={rootRef}
      className="aside"
      data-testid="btw-window"
      role="dialog"
      aria-label="By the way"
      style={{ left: place.x, top: place.y, width: place.width, height: place.height }}
      onPointerUp={rememberSize}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="aside-bar" onPointerDown={onDragStart}>
        <div>
          <div className="aside-title">By the way</div>
          <div className="aside-note">Off this thread</div>
        </div>
        <div className="aside-actions">
          <button
            type="button"
            className="text-button aside-clear"
            aria-label="Clear side chat"
            disabled={asking || (entries.length === 0 && !draft)}
            onClick={() => void clearAside()}
          >
            Clear
          </button>
          <button type="button" className="icon" aria-label="Close side chat" onClick={onClose}>
            ×
          </button>
        </div>
      </header>
      <div className="aside-log" ref={logRef}>
        {!ready ? <p className="aside-empty">Start this chat first.</p> : null}
        {ready && entries.length === 0 ? (
          <p className="aside-empty">Ask about this thread. The answer stays in this window.</p>
        ) : null}
        {entries.map((entry) => (
          <article key={entry.id} className="aside-exchange" data-testid="btw-exchange">
            {entry.question ? <p className="aside-ask">{entry.question}</p> : null}
            {entry.pending ? <p className="aside-pending">Answering…</p> : null}
            {entry.error ? <p className="aside-error">{entry.error}</p> : null}
            {!entry.pending && !entry.error ? (
              entry.answer ? (
                <MarkdownView className="aside-answer" text={entry.answer} cwd={cwd} />
              ) : (
                <p className="aside-pending">No answer.</p>
              )
            ) : null}
          </article>
        ))}
      </div>
      <form onSubmit={onSubmit}>
        <textarea
          ref={inputRef}
          aria-label="Side question"
          placeholder={ready ? "Ask a side question" : "Start this chat first"}
          rows={2}
          value={draft}
          disabled={!ready || asking}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <button className="primary" type="submit" disabled={!ready || asking || !draft.trim()}>
          Ask
        </button>
      </form>
    </section>
  );

  return createPortal(panel, document.body);
}

function storedPlace(): string | null {
  try {
    return localStorage.getItem(BTW_PLACE_KEY);
  } catch {
    return null;
  }
}

function storePlace(place: BtwPlace | null) {
  try {
    localStorage.setItem(BTW_PLACE_KEY, JSON.stringify(place));
  } catch {
    // The window still works if the browser refuses storage.
  }
}

// The entries of a GET /api/btw reply ({ entries: BtwEntry[] }).
function savedEntries(value: unknown): unknown {
  return isRecord(value) ? value.entries || [] : [];
}

// A /api/btw reply: a BtwAnswer, or { error } when the host refused.
function btwReply(value: unknown): Partial<Pick<BtwAnswer, "answer">> & { id?: string; error?: string } {
  if (!isRecord(value)) return {};
  return {
    id: typeof value.id === "string" ? value.id : undefined,
    answer: typeof value.answer === "string" ? value.answer : undefined,
    error: typeof value.error === "string" ? value.error : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
