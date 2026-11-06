import { useEffect, useRef, useState } from "react";
import { useCloseOutside } from "../useCloseOutside.ts";
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import type { TaskSuggestion } from "../../server/snapshot.ts";
import type { TaskStart } from "../../server/board/taskStart.ts";
import type { ApiCall } from "../launchToken.ts";
import type { SessionCall } from "../chat/Transcript.tsx";
import { ticketDescription } from "./suggestedTask.ts";
import { leaveRef } from "../leaveRef.ts";

export interface TaskCardsProps {
  suggestions: TaskSuggestion[];
  // The bound folder a ticket goes to, or null when the chat's folder has no board.
  board: string | null;
  // False on the Chat tab, where a task can only start as a plain chat.
  git?: boolean;
  call: ApiCall;
  act: SessionCall;
  // Starts the task in a chat of its own. When it resolves, the card leaves.
  onStart?: (suggestion: TaskSuggestion, where: TaskStart) => Promise<unknown> | void;
}

interface CardState {
  busy?: string;
  error?: string;
  ticketed?: boolean;
  promptOpen?: boolean;
}

// The split button's other choices. The main part starts in a new worktree.
const OTHER_STARTS: { where: TaskStart; label: string }[] = [
  { where: "branch", label: "Branch from latest main" },
  { where: "folder", label: "Start in current folder" },
];

// The cards lying behind the front one in the stack, how far each peeks out above it in pixels, and how much
// smaller each one further back is.
const MAX_BEHIND = 2;
const EDGE_STEP = 8;
const EDGE_SHRINK = 0.035;

// How long the older cards take to slide out from behind the newest or back, and the step between them.
const STACK_MS = 220;
const STAGGER_MS = 35;

// How far a pointer moves sideways before a card follows it, in pixels.
const SWIPE_START = 6;

const BUSY: Record<TaskStart, string> = {
  worktree: "Creating worktree…",
  branch: "Creating branch…",
  folder: "Starting…",
};

export function swipeOutcome(dx: number, width: number): "dismiss" | "back" {
  return Math.abs(dx) >= Math.min(120, width / 3) ? "dismiss" : "back";
}

// The host's list plus the cards drawn last time that keep says are still on their way out, each back at its place.
export function withKept<T extends { id: string }>(current: readonly T[], previous: readonly T[], keep: (id: string) => boolean): T[] {
  const out = [...current];
  previous.forEach((item, index) => {
    if (keep(item.id) && !out.some((other) => other.id === item.id)) out.splice(Math.min(index, out.length), 0, item);
  });
  return out;
}

// Follow-up tasks the agent suggested, stacked with the newest on top. Show all fans the older ones out above it,
// oldest first.
export function TaskCards({ suggestions: given, board, git = true, call, act, onStart }: TaskCardsProps) {
  // closing: the older cards are sliding back behind the newest one, before the stack closes.
  const [chosenView, setView] = useState<"stacked" | "open" | "closing">("stacked");
  const [cards, setCards] = useState<Record<string, CardState>>({});
  // Cards floating out sideways: -1 left, 1 right.
  const [leaving, setLeaving] = useState<Record<string, number>>({});
  // Cards whose way out is over, hidden until the host drops them too.
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const closing = useRef<ReturnType<typeof setTimeout> | null>(null);
  const section = useRef<HTMLElement | null>(null);
  const rows = useRef(new Map<string, HTMLLIElement>());
  // The cards drawn last time, so a card that is starting or floating out stays drawn after the host dropped it.
  const drawn = useRef<TaskSuggestion[]>([]);
  // The stack's collapse after its last card left, which holds it closed until the stack goes.
  const held = useRef<Animation | null>(null);

  const suggestions = withKept(given, drawn.current, (id) => id in leaving || Boolean(cards[id]?.busy)).filter((item) => !gone.has(item.id));
  drawn.current = suggestions;
  const view = suggestions.length < 2 ? "stacked" : chosenView;
  // goAway reads this after its delay, so it sees the cards as they are by then.
  const latest = useRef({ suggestions, view, leaving });
  latest.current = { suggestions, view, leaving };

  useEffect(() => {
    if (suggestions.length < 2) setView("stacked");
  }, [suggestions.length]);

  useEffect(() => () => clearTimeout(closing.current ?? undefined), []);

  useEffect(() => {
    setGone((current) => {
      const kept = [...current].filter((id) => given.some((item) => item.id === id));
      return kept.length === current.size ? current : new Set(kept);
    });
  }, [given]);

  // A card that shows up while the stack is held closed opens it again.
  useEffect(() => {
    if (held.current && suggestions.some((item) => !(item.id in leaving))) {
      held.current.cancel();
      held.current = null;
    }
  });

  function toggle() {
    clearTimeout(closing.current ?? undefined);
    if (view !== "open") {
      setView("open");
      return;
    }
    setView("closing");
    closing.current = setTimeout(() => setView("stacked"), STACK_MS);
  }

  function patch(id: string, next: CardState) {
    setCards((current) => ({ ...current, [id]: { ...current[id], ...next } }));
  }

  async function run(suggestion: TaskSuggestion, label: string, work: () => Promise<unknown>, failed: (error: unknown) => string) {
    patch(suggestion.id, { busy: label, error: undefined });
    try {
      await work();
    } catch (error) {
      patch(suggestion.id, { error: failed(error) });
    } finally {
      patch(suggestion.id, { busy: undefined });
    }
  }

  function reason(error: unknown, fallback: string) {
    return (error instanceof Error && error.message) || fallback;
  }

  // The card floats out and its space closes before the dismiss is sent, so the snapshot never removes it
  // mid-flight. A dismiss that fails brings the card back.
  async function goAway(suggestion: TaskSuggestion, direction: number, send: boolean) {
    setLeaving((current) => ({ ...current, [suggestion.id]: direction }));
    let collapse: Animation | null = null;
    try {
      await new Promise((resolve) => {
        setTimeout(resolve, STACK_MS);
      });
      const now = latest.current;
      const others = now.suggestions.some((item) => item.id !== suggestion.id && !(item.id in now.leaving));
      const closes = !others ? section.current : now.view === "open" ? rows.current.get(suggestion.id) : undefined;
      if (closes) {
        collapse = shut(closes);
        await collapse?.finished;
        if (closes === section.current) held.current = collapse;
      }
      if (send) await act("/api/suggestions/dismiss", { id: suggestion.id });
      setGone((current) => new Set(current).add(suggestion.id));
    } catch (error) {
      collapse?.cancel();
      if (held.current === collapse) held.current = null;
      throw error;
    } finally {
      setLeaving((current) => {
        const next = { ...current };
        delete next[suggestion.id];
        return next;
      });
    }
  }

  function start(suggestion: TaskSuggestion, where: TaskStart) {
    return run(
      suggestion,
      BUSY[where],
      async () => {
        await onStart?.(suggestion, where);
        await goAway(suggestion, 1, false).catch(() => {});
      },
      (error) => reason(error, "Couldn't start it"),
    );
  }

  function createTicket(suggestion: TaskSuggestion) {
    if (!board) return;
    let filed = false;
    return run(
      suggestion,
      "Creating ticket…",
      async () => {
        await call("/api/board/tasks", { cwd: board, title: suggestion.title, description: ticketDescription(suggestion) });
        filed = true;
        patch(suggestion.id, { ticketed: true });
        await goAway(suggestion, 1, true);
      },
      (error) =>
        filed ? `The ticket is on the board, but the card could not go: ${reason(error, "try Dismiss")}` : reason(error, "Couldn't create the ticket"),
    );
  }

  function dismiss(suggestion: TaskSuggestion, direction = 1) {
    return run(suggestion, "Dismissing…", () => goAway(suggestion, direction, true), (error) => reason(error, "Couldn't dismiss it"));
  }

  if (!suggestions.length) return null;
  const stacked = suggestions.length > 1 && view === "stacked";
  const behind = stacked ? Math.min(suggestions.length - 1, MAX_BEHIND) : 0;
  const shown = stacked ? suggestions.slice(-1 - behind) : suggestions;
  return (
    <section ref={section} className={`task-stack ${view}`} aria-label="Suggested tasks" data-testid="task-cards">
      {suggestions.length > 1 ? (
        <button type="button" className="task-stack-toggle" aria-expanded={view === "open"} onClick={toggle}>
          {suggestions.length} suggested tasks <span aria-hidden="true">·</span> {view === "open" ? "Show less" : "Show all"}
          <svg className="task-stack-chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M2 6.5 5 3.5 8 6.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      ) : null}
      <div className="task-stack-cards" style={{ paddingTop: behind * EDGE_STEP }}>
        <ul className="task-cards">
          {shown.map((suggestion, index) => {
            const state = cards[suggestion.id] ?? {};
            const working = state.busy;
            return (
              <SwipeCard
                key={suggestion.id}
                disabled={Boolean(working)}
                leaving={leaving[suggestion.id] ?? 0}
                onSwipe={(direction) => dismiss(suggestion, direction)}
                attach={(element) => {
                  if (element) rows.current.set(suggestion.id, element);
                  else rows.current.delete(suggestion.id);
                }}
                stacked={stacked}
                fromBack={shown.length - 1 - index}
                onOpen={() => setView("open")}
              >
                <p className="task-card-title">{suggestion.title}</p>
                {suggestion.summary ? <p className="task-card-summary">{suggestion.summary}</p> : null}
                <button
                  type="button"
                  className={state.promptOpen ? "task-card-prompt open" : "task-card-prompt"}
                  aria-expanded={Boolean(state.promptOpen)}
                  title={state.promptOpen ? "Show less of the prompt" : "Show the whole prompt"}
                  onClick={() => patch(suggestion.id, { promptOpen: !state.promptOpen })}
                >
                  <span className="task-card-prompt-text">
                    <span className="task-card-prompt-label">Prompt</span> {suggestion.prompt}
                  </span>
                </button>
                {state.error ? (
                  <p className="task-card-error" role="alert">
                    {state.error}
                  </p>
                ) : null}
                <div className="task-card-actions">
                  {git ? (
                    <StartButton disabled={Boolean(working) || !onStart} label={working || null} onStart={(where) => start(suggestion, where)} />
                  ) : (
                    <button type="button" className="task-start" disabled={Boolean(working) || !onStart} onClick={() => start(suggestion, "folder")}>
                      {working || "Start chat"}
                    </button>
                  )}
                  {board && !state.ticketed ? (
                    <button type="button" disabled={Boolean(working)} onClick={() => createTicket(suggestion)}>
                      Create ticket
                    </button>
                  ) : null}
                  <button type="button" className="task-card-dismiss" disabled={Boolean(working)} aria-label={`Dismiss suggestion: ${suggestion.title}`} onClick={() => dismiss(suggestion)}>
                    Dismiss
                  </button>
                </div>
              </SwipeCard>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

interface SwipeCardProps {
  disabled: boolean;
  // -1 or 1 while the card floats out to that side before its dismiss.
  leaving: number;
  // The card was dragged far enough to one side: -1 left, 1 right.
  onSwipe: (direction: number) => void;
  attach: (element: HTMLLIElement | null) => void;
  stacked: boolean;
  // How many cards lie between this one and the newest.
  fromBack: number;
  onOpen: () => void;
  children: ReactNode;
}

// A card that is dismissed by dragging it left or right, like a notification. A drag that starts on a button, or
// one that goes too short, puts it back.
function SwipeCard({ disabled, leaving, onSwipe, attach, stacked, fromBack, onOpen, children }: SwipeCardProps) {
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ pointerId: number; startX: number; startY: number; width: number } | null>(null);
  // A card behind the front one in the stack is drawn whole, so a swipe of the front card shows it, but only its
  // top edge peeks out. A click there opens the stack.
  const depth = stacked ? fromBack : 0;
  // In the open list an older card slides out from behind the newest one: fromBack card heights lower, a step
  // later, and underneath the cards nearer the newest.
  const fanning = !stacked && fromBack > 0;

  function onPointerDown(event: ReactPointerEvent<HTMLLIElement>) {
    if (disabled || leaving || depth || event.button !== 0) return;
    if ((event.target as Element).closest("button, a, input, textarea, [role=menu]")) return;
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, width: event.currentTarget.offsetWidth };
  }

  function onPointerMove(event: ReactPointerEvent<HTMLLIElement>) {
    const start = drag.current;
    if (!start || start.pointerId !== event.pointerId) return;
    const dx = event.clientX - start.startX;
    if (!dragging) {
      // A mostly vertical move is a scroll or a text selection.
      if (Math.abs(event.clientY - start.startY) > Math.abs(dx)) {
        if (Math.abs(event.clientY - start.startY) > SWIPE_START) drag.current = null;
        return;
      }
      if (Math.abs(dx) < SWIPE_START) return;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      setDragging(true);
    }
    setOffset(dx);
  }

  function onPointerUp(event: ReactPointerEvent<HTMLLIElement>) {
    const start = drag.current;
    drag.current = null;
    if (!start || start.pointerId !== event.pointerId || !dragging) return;
    const dx = event.clientX - start.startX;
    setDragging(false);
    setOffset(0);
    if (swipeOutcome(dx, start.width) === "dismiss") onSwipe(Math.sign(dx) || 1);
  }

  function onPointerCancel() {
    drag.current = null;
    setDragging(false);
    setOffset(0);
  }

  return (
    <li
      ref={attach}
      className={["task-card", fanning ? "fanning" : "", depth ? "behind" : ""].filter(Boolean).join(" ")}
      aria-hidden={depth ? true : undefined}
      onClick={depth ? onOpen : undefined}
      data-testid="task-card"
      data-swipe={dragging ? "drag" : leaving ? "out" : "rest"}
      style={{
        "--card-z": 10 - Math.min(fromBack, 9),
        ...(fanning ? { "--fan-steps": fromBack, animationDelay: `${(fromBack - 1) * STAGGER_MS}ms` } : {}),
        ...motion(depth, leaving, offset, drag.current?.width || 1),
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      {/* inert on the content, not the card, so a click on the card behind still opens the stack. */}
      <div className="task-card-body" inert={depth ? true : undefined}>
        {children}
      </div>
    </li>
  );
}

function motion(depth: number, leaving: number, offset: number, width: number): CSSProperties {
  // A card behind stays opaque, so the one behind it never shows through. Its content is dimmed instead (styles.css).
  if (depth) return { transform: `translateY(-${depth * EDGE_STEP}px) scale(${1 - depth * EDGE_SHRINK})` };
  // Floating out goes on from where the drag let go, since the transition starts from the drag's transform.
  if (leaving) return { transform: `translateX(calc(${leaving} * (100% + 2.5rem)))`, opacity: 0 };
  if (offset) return { transform: `translateX(${offset}px)`, opacity: Math.max(0.2, 1 - Math.abs(offset) / width) };
  return {};
}

// Closes the space an element takes, down to nothing, and holds it closed until the element is removed. Cancel
// opens it again. null where there is no animation (reduced motion, or a test DOM).
function shut(element: HTMLElement): Animation | null {
  if (typeof element.animate !== "function" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return null;
  const style = getComputedStyle(element);
  return element.animate(
    [
      { height: `${element.offsetHeight}px`, marginTop: style.marginTop, marginBottom: style.marginBottom, overflow: "hidden" },
      // A card in the open list also takes back the gap above it, which is the .task-cards gap in styles.css.
      { height: "0px", marginTop: element.previousElementSibling ? "-0.35rem" : "0px", marginBottom: "0px", overflow: "hidden" },
    ],
    { duration: STACK_MS, easing: "cubic-bezier(0.4, 0, 0.2, 1)", fill: "forwards" },
  );
}

interface StartButtonProps {
  disabled: boolean;
  // Shown instead of the button text while a start runs.
  label: string | null;
  onStart: (where: TaskStart) => void;
}

// A split button: the main part starts in a new worktree, the arrow opens the other ways to start.
function StartButton({ disabled, label, onStart }: StartButtonProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);

  useCloseOutside(open, root, () => setOpen(false));

  function choose(where: TaskStart) {
    setOpen(false);
    onStart(where);
  }

  return (
    <div className="split-button" ref={root}>
      <button type="button" className="split-main" disabled={disabled} onClick={() => choose("worktree")}>
        {label || "Start in worktree"}
      </button>
      <button
        type="button"
        className="split-toggle"
        disabled={disabled}
        aria-label="More ways to start"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open ? (
        <div ref={leaveRef} className="session-menu split-menu" role="menu">
          {OTHER_STARTS.map((item) => (
            <button key={item.where} type="button" role="menuitem" onClick={() => choose(item.where)}>
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
