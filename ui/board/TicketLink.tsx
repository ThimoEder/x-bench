import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";
import { isIssueKey } from "../../server/board/ticketId.ts";
import type { TicketId } from "../../server/board/ticketId.ts";
import { TypeIcon } from "./boardIcons.tsx";
import { canDo, cardBadge, columnColor, columnFor, counted, cssValue, isRecord, keyOf, linkedList, nodeOf, sameId, taskStatus, textOf } from "./boardData.ts";
import type { BoardColumn, BoardTask, BoardView } from "./boardData.ts";
import { linkedChats, useBoardTicket } from "./boardCache.ts";
import type { BoardTicket } from "./boardCache.ts";
import { relativeTime } from "./ticketView.ts";

interface TicketLinkProps {
  href: string;
  cwd: string;
  taskId: TicketId;
  children: ReactNode;
}

// A link to a ticket on a board: a ring in the color of the ticket's column, and the ticket on hover or
// keyboard focus. A ticket the board cannot read leaves a plain link. A bare address or #<id> reads as the board's badge.
export function TicketLink({ href, cwd, taskId, children }: TicketLinkProps) {
  const ticket = useBoardTicket(cwd, taskId);
  const anchor = useRef<HTMLAnchorElement>(null);
  const timer = useRef(0);
  const [open, setOpen] = useState(false);
  const bare = children === href || (typeof children === "string" && children.toLowerCase() === `#${String(taskId)}`.toLowerCase());
  const text = bare ? badgeOf(ticket, taskId) : children;

  function show(next: boolean, delay = 0) {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(next), delay);
  }

  useEffect(() => () => window.clearTimeout(timer.current), []);

  useEffect(() => {
    if (!open) return;
    // Handled, so the board's Esc leaves the ticket open under the card.
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  if (ticket.state === "failed") {
    return (
      <a href={href} target="_blank" rel="noreferrer">
        {text}
      </a>
    );
  }
  return (
    <>
      <a
        ref={anchor}
        href={href}
        target="_blank"
        rel="noreferrer"
        className={ticket.state === "gone" ? "ticket-link is-gone" : "ticket-link"}
        onMouseEnter={() => show(true, 300)}
        onMouseLeave={() => show(false)}
        onFocus={(event) => {
          if (event.currentTarget.matches(":focus-visible")) show(true);
        }}
        onBlur={() => show(false)}
        onClick={() => show(false)}
      >
        <Ring ticket={ticket} />
        {text}
      </a>
      {open ? createPortal(<TicketCard anchor={anchor} ticket={ticket} taskId={taskId} />, document.body) : null}
    </>
  );
}

function badgeOf(ticket: BoardTicket, taskId: TicketId): string {
  if (ticket.state === "ready" && ticket.board) return cardBadge(ticket.board, ticket.task);
  return isIssueKey(taskId) ? taskId : `#${String(taskId)}`;
}

function columnOf(board: BoardView | null, task: BoardTask): BoardColumn | undefined {
  return board ? columnFor(board.columns, taskStatus(task)) : undefined;
}

// A dot inside a ring, both in the color of the ticket's column. A column without a color gets a dotted ring.
function Ring({ ticket, size = 14 }: { ticket: BoardTicket; size?: number }) {
  const color = ticket.state === "ready" ? columnColor(columnOf(ticket.board, ticket.task)) : null;
  const dotted = ticket.state === "ready" && color === null;
  return (
    <svg
      className={`ticket-ring is-${dotted ? "plain" : ticket.state}`}
      style={color === null ? undefined : { color: String(color) }}
      width={size}
      height={size}
      viewBox="0 0 14 14"
      aria-hidden="true"
    >
      {dotted ? (
        <circle cx="7" cy="7" r="5.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeDasharray="0.01 2.65" />
      ) : (
        <circle cx="7" cy="7" r="5.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      )}
      {ticket.state === "gone" ? <path d="M3.3 10.7l7.4-7.4" stroke="currentColor" strokeWidth="1.4" /> : null}
      {ticket.state === "ready" && !dotted ? <circle cx="7" cy="7" r="2.8" fill="currentColor" /> : null}
      {ticket.state === "loading" ? <circle cx="7" cy="7" r="2.8" fill="currentColor" /> : null}
    </svg>
  );
}

interface Place {
  left: number;
  top: number;
  side: "below" | "above";
  arrow: number;
}

// Fixed to the window, below the link or above it when the window has no room below.
function TicketCard({ anchor, ticket, taskId }: { anchor: RefObject<HTMLAnchorElement | null>; ticket: BoardTicket; taskId: TicketId }) {
  const card = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<Place | null>(null);

  useLayoutEffect(() => {
    function measure() {
      const link = anchor.current?.getBoundingClientRect();
      const box = card.current;
      if (!link || !box) return;
      const width = box.offsetWidth;
      const height = box.offsetHeight;
      const left = Math.min(Math.max(8, link.left - 8), window.innerWidth - width - 8);
      const below = link.bottom + 10 + height <= window.innerHeight - 8;
      const arrow = Math.min(Math.max(12, link.left + Math.min(link.width / 2, 22) - left - 6), width - 24);
      setPlace({ left, top: below ? link.bottom + 10 : link.top - 10 - height, side: below ? "below" : "above", arrow });
    }
    measure();
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [anchor, ticket]);

  return (
    <div
      ref={card}
      className="ticket-hover"
      role="tooltip"
      data-testid="ticket-hover"
      data-side={place?.side}
      style={place ? { left: place.left, top: place.top, "--arrow-x": `${place.arrow}px` } : { visibility: "hidden" }}
    >
      <CardBody ticket={ticket} taskId={taskId} />
    </div>
  );
}

function CardBody({ ticket, taskId }: { ticket: BoardTicket; taskId: TicketId }) {
  if (ticket.state === "loading") {
    return (
      <>
        <span className="ticket-hover-id">{badgeOf(ticket, taskId)}</span>
        <span className="ticket-hover-skeleton" />
        <span className="ticket-hover-skeleton" />
        <span className="ticket-hover-skeleton is-short" />
      </>
    );
  }
  if (ticket.state !== "ready") {
    return (
      <>
        <span className="ticket-hover-id">{badgeOf(ticket, taskId)}</span>
        <p className="ticket-hover-text">This ticket isn't on the board anymore.</p>
      </>
    );
  }
  const { board, task } = ticket;
  const column = columnOf(board, task);
  const flow = (board?.columns ?? []).filter((item) => item.value !== null && item.value !== undefined);
  const at = column ? flow.indexOf(column) : -1;
  const type = board && canDo(board, "types") ? textOf(task.type) : "";
  const description = textOf(task.description).replace(/\s+/g, " ").trim();
  const subtasks = counted(task.subtaskCount);
  const related = relationsOf(board, task).slice(0, 3);
  const chats = linkedChats(task.id);
  const updated = relativeTime(textOf(task.updated_at) || textOf(task.updated) || null, new Date());
  const badge = (id: unknown) => (board ? cardBadge(board, { id, reference: null }) : `#${String(id)}`);
  return (
    <>
      <span className="ticket-hover-head">
        <span className="ticket-hover-id">{badgeOf(ticket, taskId)}</span>
        {column ? (
          <span className="ticket-hover-column">
            <Ring ticket={ticket} size={11} />
            {nodeOf(column.title)}
          </span>
        ) : null}
        {type ? (
          <span className="ticket-hover-type">
            <TypeIcon type={type} size={12} />
            {textOf(task.typeName) || type}
          </span>
        ) : null}
      </span>
      <strong className="ticket-hover-title">{nodeOf(task.title)}</strong>
      <p className={description ? "ticket-hover-text" : "ticket-hover-text is-empty"}>{description || "No description"}</p>
      {task.labels?.length ? (
        <span className="board-pills">
          {task.labels.map((label) => (
            <span key={keyOf(label.id || label.title)} className="board-pill" style={label.color ? { "--pill": cssValue(label.color) } : undefined}>
              {nodeOf(label.title)}
            </span>
          ))}
        </span>
      ) : null}
      <dl className="ticket-hover-facts">
        {column && at >= 0 ? (
          <>
            <dt>Column</dt>
            <dd>
              <span className="ticket-hover-name">{nodeOf(column.title)}</span>
              {` · ${at + 1} of ${flow.length}`}
              <span className="ticket-hover-flow">
                {flow.map((item, index) => (
                  <i
                    key={keyOf(item.value)}
                    className={index < at ? "is-past" : undefined}
                    style={index === at ? { background: cssValue(columnColor(item) ?? "var(--text)") } : undefined}
                  />
                ))}
              </span>
            </dd>
          </>
        ) : null}
        {subtasks ? (
          <>
            <dt>Sub-tasks</dt>
            <dd>
              {`${subtasks.done} of ${subtasks.total} done`}
              <span className="ticket-hover-progress">
                <i style={{ width: `${(100 * subtasks.done) / subtasks.total}%` }} />
              </span>
            </dd>
          </>
        ) : null}
        {related.map((item) => (
          <Fragment key={`${item.kind} ${String(item.id)}`}>
            <dt>{item.kind || "Linked"}</dt>
            <dd>{`${badge(item.id)} ${item.title}`}</dd>
          </Fragment>
        ))}
        {chats[0] ? (
          <>
            <dt>Chat</dt>
            <dd>{`${chats[0].title}${chats[0].running ? " · running" : ""}${chats.length > 1 ? ` +${chats.length - 1}` : ""}`}</dd>
          </>
        ) : null}
      </dl>
      {updated ? <span className="ticket-hover-foot">{`Updated ${updated}`}</span> : null}
    </>
  );
}

// A ticket's relations: titled ones as the source sends them, or bare ids named from the board.
function relationsOf(board: BoardView | null, task: BoardTask): { id: unknown; kind: string; title: string }[] {
  const titled = linkedList(task.related);
  if (titled.length) return titled;
  if (!Array.isArray(task.relations)) return [];
  return task.relations.flatMap((item: unknown) => {
    if (!isRecord(item) || item.task_id === undefined || item.task_id === null) return [];
    const other = board?.tasks.find((each) => sameId(each.id, item.task_id));
    return [{ id: item.task_id, kind: textOf(item.kind).replace(/_/g, " "), title: textOf(other?.title) }];
  });
}
