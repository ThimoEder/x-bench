import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { OpenSession, TicketLink, TicketLinks } from "../../server/snapshot.ts";
import { MarkdownView } from "../chat/markdown/MarkdownView.tsx";
import type { ApiCall } from "../launchToken.ts";
import { useBoardColumns } from "./boardCache.ts";
import { columnColor, columnFor, moveList, type BoardMove } from "./boardData.ts";
import { statusTone } from "./ticketStatus.ts";

export interface TicketChipsProps {
  session: Pick<OpenSession, "id" | "cwd">;
  tickets?: Partial<TicketLinks> | null;
  onOpen?: (cwd: string, taskId: TicketLink["taskId"]) => void;
  // Reads a ticket's description and moves it between columns. Without it the card shows neither.
  call?: ApiCall;
}

export function TicketChips({ session, tickets, onOpen, call }: TicketChipsProps) {
  const rows = tickets?.bySession?.[session?.id] || [];
  if (!session || !rows.length) return null;
  return (
    <span className="ticket-chips">
      {rows.map((link) => (
        <TicketChip key={link.taskId} link={link} cwd={session.cwd} onOpen={onOpen} call={call} />
      ))}
    </span>
  );
}

// The ticket's number as its board shows it, or null for a ticket whose only id is a long hex string.
export function ticketNumber(link: Pick<TicketLink, "taskId" | "reference">): string | null {
  if (link.reference != null) return `#${link.reference}`;
  if (typeof link.taskId === "number" || /^\d+$/.test(String(link.taskId))) return `#${link.taskId}`;
  return null;
}

interface TicketChipProps {
  link: TicketLink;
  cwd: string;
  onOpen?: TicketChipsProps["onOpen"];
  call?: ApiCall;
}

function TicketChip({ link, cwd, onOpen, call }: TicketChipProps) {
  const [open, setOpen] = useState(false);
  const [moved, setMoved] = useState<BoardMove | null>(null);
  // One move at a time, so a failed move falls back to the status the board last confirmed.
  const [moving, setMoving] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const status = moved?.title ?? (link.status || "unset");
  const columns = useBoardColumns(cwd);
  // The column's color on the board, or the one its name stands for until the board loads.
  const tone = (name: string) => {
    const color = columnColor(columnFor(columns, name)) ?? statusTone(name);
    return color === undefined ? undefined : String(color);
  };
  // The color the host kept with the link is the one the sidebar shows. A move on its way has none yet.
  const color = (moved ? undefined : link.color) || tone(status) || "var(--soft)";
  const number = ticketNumber(link);

  useEffect(() => {
    setMoved(null);
  }, [link.status]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={number ? "ticket-chip ticket-number" : "ticket-chip"}
        data-testid="ticket-chip"
        title={link.title || status}
        aria-label={link.title ? `${number ? `${number}, ` : ""}${status}: ${link.title}` : status}
        aria-haspopup="dialog"
        aria-expanded={open}
        style={{ "--ticket-status": color }}
        onClick={() => setOpen((value) => !value)}
      >
        {number || status}
      </button>
      {open ? (
        <TicketCard
          anchor={buttonRef}
          link={link}
          cwd={cwd}
          number={number}
          pressed={moved ? moveKey(moved) : HERE}
          color={color}
          tone={tone}
          call={call}
          onClose={() => setOpen(false)}
          onOpen={onOpen ? () => {
            setOpen(false);
            onOpen(cwd, link.taskId);
          } : undefined}
          moving={moving}
          onMove={call ? async (next) => {
            if (moving) return;
            const before = moved;
            setMoving(true);
            setMoved(next);
            try {
              await call("/api/board/move", { taskId: link.taskId, status: next.status, cwd });
            } catch {
              setMoved(before);
            } finally {
              setMoving(false);
            }
          } : undefined}
        />
      ) : null}
    </>
  );
}

interface TicketCardProps {
  anchor: React.RefObject<HTMLButtonElement | null>;
  link: TicketLink;
  cwd: string;
  number: string | null;
  // The key of the row that shows as the ticket's column: the confirmed one, or the move on its way.
  pressed: string;
  color: string;
  tone: (status: string) => string | undefined;
  call?: ApiCall;
  onClose: () => void;
  onOpen?: () => void;
  onMove?: (move: BoardMove) => void;
  moving?: boolean;
}

function TicketCard({ anchor, link, cwd, number, pressed, color, tone, call, onClose, onOpen, onMove, moving = false }: TicketCardProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [description, setDescription] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  const [long, setLong] = useState(false);
  const textRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!call) return undefined;
    let cancel = false;
    call(`/api/board/tasks/${encodeURIComponent(String(link.taskId))}`, {}, "GET", { quiet: true, silent: true })
      .then((data) => {
        const task = isRecord(data) && isRecord(data.task) ? data.task : null;
        if (!cancel) setDescription(typeof task?.description === "string" ? task.description.trim() : "");
      })
      .catch(() => {
        if (!cancel) setDescription("");
      });
    return () => {
      cancel = true;
    };
  }, [call, link.taskId]);

  // The columns the board allows from the status it last confirmed.
  const [moves, setMoves] = useState<BoardMove[]>([]);
  const movable = Boolean(onMove);
  useEffect(() => {
    if (!call || !movable) return undefined;
    let cancel = false;
    call(`/api/board/tasks/${encodeURIComponent(String(link.taskId))}/moves?cwd=${encodeURIComponent(cwd)}`, {}, "GET", { quiet: true, silent: true })
      .then((data) => {
        if (!cancel) setMoves(moveList(data).filter((move) => move.status !== null && move.title));
      })
      .catch(() => {
        if (!cancel) setMoves([]);
      });
    return () => {
      cancel = true;
    };
  }, [call, movable, link.taskId, link.status, cwd]);
  const here = link.status || "unset";
  const choices: BoardMove[] = [{ status: null, title: here, needs: [] }, ...moves];

  useLayoutEffect(() => {
    const text = textRef.current;
    if (text && !full) setLong(text.scrollHeight > text.clientHeight + 1);
  }, [description, full]);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    const trigger = anchor.current;
    if (!panel || !trigger) return undefined;
    const place = () => {
      const rect = trigger.getBoundingClientRect();
      const width = Math.min(340, window.innerWidth - 16);
      const left = Math.max(8, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 8));
      panel.style.top = `${rect.bottom + 8}px`;
      panel.style.left = `${left}px`;
      panel.style.width = `${width}px`;
      panel.style.transformOrigin = `${rect.left + rect.width / 2 - left}px top`;
      panel.classList.add("placed");
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor]);

  useEffect(() => {
    function onPointer(event: PointerEvent) {
      const target = event.target as Node | null;
      if (anchor.current?.contains(target) || panelRef.current?.contains(target)) return;
      onClose();
    }
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      onClose();
      anchor.current?.focus();
    }
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [anchor, onClose]);

  const heading = (
    <>
      {number ? <span className="ticket-card-number">{number}</span> : null}
      <span className="ticket-card-title">{link.title || "Untitled ticket"}</span>
    </>
  );

  return createPortal(
    <div ref={panelRef} className="ticket-card" role="dialog" aria-label={link.title || "Ticket"} data-testid="ticket-card" style={{ "--ticket-status": color }}>
      {onOpen ? (
        <button type="button" className="ticket-card-head is-link" title="Open on the board" onClick={onOpen}>
          {heading}
          <OpenIcon />
        </button>
      ) : (
        <div className="ticket-card-head">{heading}</div>
      )}
      {description ? (
        <>
          <div ref={textRef} className={full ? "ticket-card-text full" : "ticket-card-text"}>
            <MarkdownView text={description} />
          </div>
          {long || full ? (
            <button type="button" className="ticket-card-more" onClick={() => setFull((value) => !value)}>
              {full ? "Show less" : "Show more"}
            </button>
          ) : null}
        </>
      ) : null}
      {onMove ? (
        <ul className="ticket-card-statuses" aria-label="Status">
          {choices.map((move) => (
            <li key={moveKey(move)}>
              <button
                type="button"
                aria-pressed={moveKey(move) === pressed}
                disabled={moving}
                title={move.needs.length ? `Fill in ${move.needs.map((field) => field.name).join(", ")} on the board` : undefined}
                style={{ "--status": tone(move.title) }}
                onClick={() => {
                  if (move.status === null) return;
                  if (move.needs.length) onOpen?.();
                  else onMove(move);
                }}
              >
                <span className="ticket-card-dot" aria-hidden="true" />
                <span className="ticket-card-status">{move.title}</span>
                {moveKey(move) === pressed ? <span aria-hidden="true">✓</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>,
    document.body,
  );
}

// The confirmed column is the row without a status. Two columns can share a title, so a move is known by its status.
const HERE = "here";

function moveKey(move: BoardMove): string {
  return move.status === null ? HERE : `to:${String(move.status)}`;
}

function OpenIcon() {
  return (
    <svg className="ticket-card-open" width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M4.5 2.5h5v5M9.5 2.5 3 9" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
