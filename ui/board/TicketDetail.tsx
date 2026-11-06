import { useEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import type { SidebarSession } from "../../server/snapshot.ts";
import { MarkdownView } from "../chat/markdown/MarkdownView.tsx";
import {
  AlertIcon,
  BackIcon,
  CalendarIcon,
  ChatIcon,
  CheckIcon,
  ChevronIcon,
  CommentIcon,
  EditIcon,
  ExpandIcon,
  ExternalIcon,
  LockIcon,
  MoreIcon,
  PlusIcon,
  PriorityIcon,
  ReloadIcon,
  TypeIcon,
} from "./boardIcons.tsx";
import { ChecklistSection, saveQueue } from "./Checklist.tsx";
import {
  assigneeLabel,
  canDo,
  cardBadge,
  checked,
  checklistsOf,
  columnFor,
  columnTone,
  isRecord,
  moveList,
  isSavedTask,
  keyOf,
  linkedList,
  messageOf,
  nodeOf,
  people,
  sameId,
  sourceName,
  statusOf,
  taskStatus,
  textOf,
  transitions,
  cssValue,
  type BoardCall,
  type BoardColumn,
  type TicketComment,
  type BoardLabel,
  type BoardView,
  type DetailTask,
  type Linked,
  type OpenDetail,
  type BoardMove,
  type BoardPerson,
  type MoveField,
} from "./boardData.ts";
import { avatarTone, dueState, exactTime, initials, relativeTime } from "./ticketView.ts";
import { LabelPicker } from "./LabelPicker.tsx";
import { useDismiss } from "./useDismiss.ts";
import { leaveRef } from "../leaveRef.ts";
import { useTicketProse, type TicketProse } from "./useTicketProse.ts";

type TextField = "title" | "description" | "note";

export interface TicketDetailProps {
  detail: OpenDetail;
  board: BoardView;
  cwd: string;
  // Every chat in the sidebar, the Chat tab's and each project's.
  chats: SidebarSession[];
  call: BoardCall;
  working: string[];
  onChanged: (task: DetailTask) => void;
  onReload: () => void;
  onManageLabels: () => void;
  onOpenSession: (sessionId: string) => void;
  onThread: () => void;
  onUnlink: (sessionId: string) => Promise<void>;
  onLink: (sessionId: string) => Promise<void>;
  // Moves the ticket. needs are the fields the move asks for; the board collects them first.
  onMove: (status: unknown, needs: MoveField[]) => void;
  onDelete: () => void;
  onClose: () => void;
  onOpenTicket: (taskId: unknown) => void;
  onOpenSource?: (url: string) => void;
  expanded: boolean;
  onExpand: () => void;
}

const close = (
  <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

// Per stand-in description line, its width in percent.
const SKELETON_LINES = [94, 86, 97, 72, 90, 58];

// Stands in for a ticket while its detail loads, in the same frame, so the pane opens at once.
export function TicketSkeleton({ onClose }: { onClose: () => void }) {
  return (
    <aside className="ticket-detail ticket-loading" data-testid="ticket-skeleton" role="status" aria-label="Loading ticket">
      <div className="ticket-back">
        <button type="button" className="text-button" onClick={onClose}>
          <BackIcon />
          Board
        </button>
        <button type="button" className="icon" aria-label="Close" onClick={onClose}>{close}</button>
      </div>
      <header className="ticket-head">
        <div className="ticket-crumbs">
          <span className="skeleton-line" style={{ width: 84 }} />
          <span className="ticket-crumb-end">
            <button type="button" className="icon ticket-close" aria-label="Close" onClick={onClose}>{close}</button>
          </span>
        </div>
        <span className="skeleton-line ticket-skeleton-title" style={{ width: "74%" }} />
        <span className="skeleton-line ticket-skeleton-title" style={{ width: "46%" }} />
        <div className="ticket-meta">
          <span className="skeleton-line ticket-skeleton-chip" style={{ width: 96 }} />
        </div>
      </header>
      <div className="ticket-scroll" aria-hidden="true">
        <div className="ticket-body">
          <div className="ticket-main">
            <div className="ticket-skeleton-lines">
              <span className="skeleton-line" style={{ width: 88 }} />
              {SKELETON_LINES.map((width, index) => <span key={index} className="skeleton-line" style={{ width: `${width}%` }} />)}
            </div>
          </div>
          <div className="ticket-side">
            {[64, 52, 72].map((width, index) => (
              <div key={index} className="ticket-skeleton-lines">
                <span className="skeleton-line" style={{ width: 56 }} />
                <span className="skeleton-line" style={{ width: `${width}%` }} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </aside>
  );
}

export function TicketDetail({
  detail,
  board,
  cwd,
  chats,
  call,
  working,
  onChanged,
  onReload,
  onOpenSession,
  onThread,
  onUnlink,
  onLink,
  onMove,
  onDelete,
  onClose,
  onOpenTicket,
  onOpenSource,
  onManageLabels,
  expanded,
  onExpand,
}: TicketDetailProps) {
  const task = detail.task;
  const source = sourceName(board);
  const now = new Date();
  const [editing, setEditing] = useState<TextField | null>(null);
  const [draft, setDraft] = useState("");
  const [baseRevision, setBaseRevision] = useState<unknown>(task.revision);
  const [changed, setChanged] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [menu, setMenu] = useState<"status" | "more" | null>(null);
  const [moves, setMoves] = useState<BoardMove[] | null>(null);
  const [comments, setComments] = useState<TicketComment[]>(detail.comments || []);
  const [commentsFrom, setCommentsFrom] = useState(detail.comments);
  const prose = useTicketProse(task.id, [textOf(task.description), textOf(task.note), ...comments.map((item) => textOf(item.body))], call, canDo(board, "embedsByName"));
  const [comment, setComment] = useState("");
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkId, setLinkId] = useState("");
  const [linkError, setLinkError] = useState("");
  const dropped = useRef(false);
  const savedTimer = useRef(0);
  // The running save: its field, and the revision it saves (undefined when it fails).
  const saving = useRef<{ field: TextField; revision: Promise<unknown> } | null>(null);
  // Fields stay read-only while they save, so no newer draft is closed under a save.
  const [savingFields, setSavingFields] = useState<TextField[]>([]);
  const [checklistQueue] = useState(saveQueue);

  if (editing && !changed && !Object.is(baseRevision, task.revision)) setChanged(true);
  if (commentsFrom !== detail.comments) {
    setCommentsFrom(detail.comments);
    setComments(detail.comments || []);
  }

  useEffect(() => () => window.clearTimeout(savedTimer.current), []);

  useDismiss(menu !== null, "[data-ticket-menu]", () => setMenu(null));

  function flashSaved() {
    setSaved(true);
    window.clearTimeout(savedTimer.current);
    savedTimer.current = window.setTimeout(() => setSaved(false), 2000);
  }

  function startEdit(field: TextField) {
    dropped.current = false;
    setEditing(field);
    setDraft(textOf(task[field]));
    setBaseRevision(task.revision);
    setChanged(false);
    setError("");
  }

  function dropEdit() {
    dropped.current = true;
    setEditing(null);
    setChanged(false);
  }

  function reload() {
    dropEdit();
    onReload();
  }

  async function saveEdit() {
    if (dropped.current || !editing || saving.current?.field === editing) return;
    const field = editing;
    const value = field === "title" ? draft.trim().replace(/\s+/g, " ") : draft;
    if (field === "title" && !value) {
      dropEdit();
      return;
    }
    const before = field === "title" ? textOf(task.title).trim().replace(/\s+/g, " ") : textOf(task[field]);
    if (value === before) {
      setEditing(null);
      return;
    }
    // A save of another field may still run: this one goes after it, on the revision it saved.
    const earlier = saving.current?.revision;
    let settle: (revision: unknown) => void = () => {};
    const mine = { field, revision: new Promise<unknown>((resolve) => { settle = resolve; }) };
    saving.current = mine;
    setSavingFields((current) => [...current, field]);
    let savedRevision: unknown;
    setBusy(true);
    setError("");
    try {
      const revision = (earlier && (await earlier)) ?? baseRevision;
      const body = { revision, [field]: field === "title" ? value : value.trim() ? value : null };
      const result = checked(await call(`/api/board/tasks/${task.id}`, body, "PATCH", { silent: true }), isSavedTask);
      savedRevision = result.task.revision;
      // Another field may have opened while this one saved; it stays open, on the saved revision.
      setEditing((current) => (current === field ? null : current));
      setBaseRevision(result.task.revision);
      setChanged(false);
      flashSaved();
      onChanged(result.task);
    } catch (failure) {
      if (statusOf(failure) === 409) {
        setChanged(true);
        onReload();
      } else {
        setError(messageOf(failure));
      }
    } finally {
      settle(savedRevision);
      setSavingFields((current) => current.filter((other) => other !== field));
      if (saving.current === mine) {
        saving.current = null;
        setBusy(false);
      }
    }
  }

  function onFieldKey(event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      dropEdit();
      return;
    }
    const send = editing === "title" ? event.key === "Enter" : event.key === "Enter" && (event.metaKey || event.ctrlKey);
    if (send) {
      event.preventDefault();
      event.currentTarget.blur();
    }
  }

  async function openStatus() {
    if (menu === "status") {
      setMenu(null);
      return;
    }
    setMenu("status");
    setMoves(null);
    try {
      const data = await call(`/api/board/tasks/${task.id}/moves?cwd=${encodeURIComponent(cwd)}`, null, "GET", { silent: true, quiet: true });
      setMoves(moveList(data));
    } catch (failure) {
      setMoves([]);
      setError(messageOf(failure));
    }
  }

  async function addComment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = comment.trim();
    if (!body || busy) return;
    setBusy(true);
    setError("");
    try {
      const created = checked(await call(`/api/board/tasks/${task.id}/comments`, { body }, "POST", { silent: true }), isRecord);
      setComments((current) => (current.some((other) => sameId(other.id, created.id)) ? current : [...current, created]));
      setComment("");
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  }

  async function editComment(item: TicketComment, text: string) {
    const edited = checked(await call(`/api/board/tasks/${task.id}/comments/${String(item.id)}`, { body: text }, "PATCH", { silent: true }), isRecord);
    setComments((current) => current.map((other) => (sameId(other.id, item.id) ? edited : other)));
  }

  async function deleteComment(item: TicketComment) {
    await call(`/api/board/tasks/${task.id}/comments/${String(item.id)}`, null, "DELETE", { silent: true });
    setComments((current) => current.filter((other) => !sameId(other.id, item.id)));
  }

  function closeLink() {
    setLinkOpen(false);
    setLinkId("");
    setLinkError("");
  }

  async function linkChat() {
    const sessionId = linkId.trim();
    if (!sessionId || busy) return;
    if (threads.some((link) => link.sessionId === sessionId)) {
      setLinkError("This chat is already linked.");
      return;
    }
    if (!chats.some((chat) => chat.id === sessionId)) {
      setLinkError("No chat has this session id.");
      return;
    }
    setBusy(true);
    setLinkError("");
    try {
      await onLink(sessionId);
      closeLink();
    } catch (failure) {
      setLinkError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  }

  async function changeLabel(label: BoardLabel, attach: boolean) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = checked(await call(`/api/board/tasks/${task.id}/labels/${encodeURIComponent(String(label.id))}`, attach ? {} : null, attach ? "PUT" : "DELETE", { silent: true }), isSavedTask);
      onChanged(result.task);
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  }

  async function copy(text: string) {
    setMenu(null);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      setError("Couldn't copy");
    }
  }

  const status = taskStatus(task);
  const column = columnFor(board.columns, status);
  const badge = cardBadge(board, task);
  const url = textOf(task.url);
  const type = textOf(task.type);
  const typeName = textOf(task.typeName);
  const canLabel = canDo(board, "labels");
  const attached = new Set((task.labels || []).map((label) => String(label.id)));
  const subtasks = linkedList(task.subtasks);
  const related = linkedList(task.related);
  const doneSubtasks = subtasks.filter((item) => item.done).length;
  const assignees = people(task.assignees);
  const due = dueState(textOf(task.due) || null, task.dueDone === true, now);
  const threads = detail.links || [];
  const live = new Set(working);
  const created = textOf(task.created) || textOf(task.created_at);
  const me = typeof board.me === "string" ? board.me : null;
  const myself = me ? board.tasks.flatMap((item) => people(item.assignees)).find((person) => person.id === me) ?? null : null;
  const updated = textOf(task.updated) || textOf(task.updated_at);

  return (
    <aside className="ticket-detail" data-testid="ticket-detail">
      <div className="ticket-back">
        <button type="button" className="text-button" onClick={onClose}>
          <BackIcon />
          Board
        </button>
        <button type="button" className="icon" aria-label="Close" onClick={onClose}>{close}</button>
      </div>
      <header className="ticket-head">
        <div className="ticket-crumbs">
          {type ? <TypeIcon type={type} /> : null}
          <span className="ticket-key">{badge}</span>
          {typeName ? <span className="ticket-type">· {typeName}</span> : null}
          <span className="ticket-crumb-end">
            {url ? (
              <a
                className="text-button ticket-open"
                href={url}
                target="_blank"
                rel="noreferrer"
                onClick={(event) => {
                  if (!onOpenSource) return;
                  event.preventDefault();
                  onOpenSource(url);
                }}
              >
                <ExternalIcon />
                <span><span className="ticket-open-long">Open in </span>{source}</span>
              </a>
            ) : null}
            <button
              type="button"
              className="icon ticket-expand"
              aria-label={expanded ? "Back to the side" : "Expand"}
              title={expanded ? "Back to the side" : "Expand"}
              aria-pressed={expanded}
              onClick={onExpand}
            >
              <ExpandIcon inward={expanded} />
            </button>
            <span className="ticket-anchor" data-ticket-menu="more">
              <button type="button" className="icon" aria-label="More" aria-haspopup="menu" aria-expanded={menu === "more"} onClick={() => setMenu((open) => (open === "more" ? null : "more"))}>
                <MoreIcon />
              </button>
              {menu === "more" ? (
                <div ref={leaveRef} className="ticket-menu is-right" role="menu">
                  {url ? <button type="button" role="menuitem" onClick={() => copy(url)}>Copy link</button> : null}
                  <button type="button" role="menuitem" onClick={() => copy(badge)}>Copy key</button>
                  {canDo(board, "deletes") ? (
                    <>
                      <hr />
                      <button
                        type="button"
                        role="menuitem"
                        className="danger"
                        data-testid="delete-ticket"
                        onClick={() => {
                          setMenu(null);
                          onDelete();
                        }}
                      >
                        {canDo(board, "archives") ? "Archive card" : "Delete ticket"}
                      </button>
                    </>
                  ) : null}
                </div>
              ) : null}
            </span>
            <button type="button" className="icon ticket-close" aria-label="Close" onClick={onClose}>{close}</button>
          </span>
        </div>
        {editing === "title" ? (
          <input
            className="ticket-title is-editing"
            aria-label="Title"
            value={draft}
            maxLength={200}
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
            readOnly={savingFields.includes("title")}
            onKeyDown={onFieldKey}
            onBlur={saveEdit}
          />
        ) : (
          <h2 className="ticket-title">
            <button type="button" title="Edit the title" onClick={() => startEdit("title")}>{nodeOf(task.title)}</button>
          </h2>
        )}
        <div className="ticket-meta">
          <span className="ticket-anchor" data-ticket-menu="status">
            <button
              type="button"
              className="ticket-status"
              style={{ "--tone": columnTone(column) }}
              aria-haspopup="menu"
              aria-expanded={menu === "status"}
              data-testid="ticket-status"
              onClick={openStatus}
            >
              <i style={{ background: columnTone(column) }} />
              {nodeOf(column?.title ?? "No status")}
              <ChevronIcon />
            </button>
            {menu === "status" ? (
              <StatusMenu
                board={board}
                status={status}
                moves={moves}
                onPick={(choice) => {
                  setMenu(null);
                  onMove(choice.status, choice.needs);
                }}
              />
            ) : null}
          </span>
          {saved ? (
            <span className="ticket-saved">
              <CheckIcon />
              Saved
            </span>
          ) : null}
        </div>
      </header>
      <div className="ticket-scroll">
        {changed ? (
          <div className="ticket-changed" role="status">
            <ReloadIcon />
            <span>
              This ticket changed in {source} while it was open. <em>Your edit stays until you reload.</em>
            </span>
            <button type="button" className="text-button" onMouseDown={(event) => event.preventDefault()} onClick={reload}>
              Reload
            </button>
          </div>
        ) : null}
        {error ? (
          <p className="ticket-error">
            <AlertIcon />
            {error}
          </p>
        ) : null}
        <div className="ticket-body">
          <div className="ticket-main">
            <TextSection
              title="Description"
              field="description"
              value={textOf(task.description)}
              prose={prose}
              empty="Add a description"
              editing={editing}
              draft={draft}
              rows={10}
              onStart={startEdit}
              onDraft={setDraft}
              onKey={onFieldKey}
              savingFields={savingFields}
              onSave={saveEdit}
            />
            {canDo(board, "notes") ? (
              <TextSection
                title="Note"
                field="note"
                value={textOf(task.note)}
                prose={prose}
                empty="Add a note"
                editing={editing}
                draft={draft}
                rows={4}
                quiet
                onStart={startEdit}
                onDraft={setDraft}
                onKey={onFieldKey}
                savingFields={savingFields}
                onSave={saveEdit}
              />
            ) : null}
            {related.length ? (
              <section>
                <h3 className="ticket-h">Linked tickets</h3>
                <div className="ticket-rows">
                  {related.map((item) => (
                    <LinkedRow key={`${item.kind}-${String(item.id)}`} board={board} item={item} onOpen={onOpenTicket} />
                  ))}
                </div>
              </section>
            ) : null}
            {canDo(board, "subtasks") && subtasks.length ? (
              <section>
                <h3 className="ticket-h">
                  Sub-tasks
                  <span className="ticket-count">{`${doneSubtasks} of ${subtasks.length} done`}</span>
                  <span className="ticket-progress" aria-hidden="true">
                    <i style={{ width: `${Math.round((doneSubtasks / subtasks.length) * 100)}%` }} />
                  </span>
                </h3>
                <div className="ticket-rows">
                  {subtasks.map((item) => (
                    <LinkedRow key={String(item.id)} board={board} item={item} subtask onOpen={onOpenTicket} />
                  ))}
                </div>
              </section>
            ) : null}
            {canDo(board, "checklists")
              ? checklistsOf(task.checklists).map((list) => (
                  <ChecklistSection key={list.id} taskId={task.id} list={list} call={call} queue={checklistQueue} onChanged={(next) => onChanged(next)} onError={setError} />
                ))
              : null}
            <section>
              <h3 className="ticket-h">
                Comments
                <span className="ticket-count">{comments.length}</span>
              </h3>
              <div className="ticket-comments">
                {comments.map((item) => (
                  <CommentRow
                    key={keyOf(item.id)}
                    item={item}
                    prose={prose}
                    now={now}
                    editable={canDo(board, "commentEdits") && item.mine === true}
                    onEdit={(text) => editComment(item, text)}
                    onDelete={() => deleteComment(item)}
                  />
                ))}
                <form className="ticket-composer" onSubmit={addComment}>
                  <Avatar person={myself} size="lg" />
                  <div className="ticket-composer-box">
                    <textarea
                      aria-label="Comment"
                      value={comment}
                      rows={comment.includes("\n") ? 4 : 1}
                      placeholder="Add a comment…"
                      onChange={(event) => setComment(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                          event.preventDefault();
                          event.currentTarget.form?.requestSubmit();
                        }
                      }}
                    />
                    <button type="submit" className="primary" disabled={busy || !comment.trim()}>Comment</button>
                  </div>
                </form>
              </div>
            </section>
          </div>
          <div className="ticket-side">
            {canDo(board, "assignees") ? (
              <div className="ticket-field">
                <h3 className="ticket-h">{assigneeLabel(board)}</h3>
                <People list={assignees} />
              </div>
            ) : null}
            {canDo(board, "priority") ? (
              <div className="ticket-field">
                <h3 className="ticket-h">Priority</h3>
                <div className="ticket-value">
                  {textOf(task.priority) ? <PriorityIcon name={textOf(task.priority)} /> : null}
                  {textOf(task.priority) || <span className="ticket-quiet">None</span>}
                </div>
              </div>
            ) : null}
            {canDo(board, "dueDates") ? (
              <div className="ticket-field">
                <h3 className="ticket-h">Due date</h3>
                <div className={due?.late ? "ticket-value is-late" : "ticket-value"} title={exactTime(textOf(task.due))}>
                  <CalendarIcon size={14} />
                  {due ? `${due.label}${due.late ? ` · ${due.lateLabel}` : ""}` : <span className="ticket-quiet">None</span>}
                </div>
              </div>
            ) : null}
            <div className="ticket-field is-wide">
              <h3 className="ticket-h">Labels</h3>
              <div className="board-pills">
                {(task.labels || []).map((label) => (canLabel ? (
                  <button
                    key={keyOf(label.id)}
                    type="button"
                    className="board-pill is-removable"
                    style={label.color ? { "--pill": cssValue(label.color) } : undefined}
                    title={`Remove ${String(label.title)}`}
                    disabled={busy}
                    onClick={() => changeLabel(label, false)}
                  >
                    {nodeOf(label.title)}
                    <span aria-hidden="true">×</span>
                  </button>
                ) : (
                  <span key={keyOf(label.id)} className="board-pill" style={label.color ? { "--pill": cssValue(label.color) } : undefined}>
                    {nodeOf(label.title)}
                  </span>
                )))}
                {canLabel ? (
                  <LabelPicker
                    labels={(board.labels || []).filter((label) => label.title)}
                    picked={attached}
                    disabled={busy}
                    onToggle={changeLabel}
                    onManage={onManageLabels}
                  />
                ) : null}
                {!canLabel && !task.labels?.length ? <span className="ticket-quiet">None</span> : null}
              </div>
              {!canLabel ? (
                <span className="ticket-hint">
                  <LockIcon />
                  Change labels in {source}
                </span>
              ) : null}
            </div>
            <div className="ticket-field is-wide">
              <h3 className="ticket-h">
                Chats
                <span className="ticket-count">{threads.length}</span>
                <button
                  type="button"
                  className={`text-button ticket-link-add${linkOpen ? " is-on" : ""}`}
                  title="Link a chat by its session id"
                  aria-label="Link a chat by its session id"
                  aria-expanded={linkOpen}
                  onClick={() => (linkOpen ? closeLink() : setLinkOpen(true))}
                >
                  <PlusIcon />
                </button>
              </h3>
              {linkOpen ? (
                <form
                  className="ticket-link-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    linkChat();
                  }}
                >
                  <div className="ticket-link-line">
                    <input
                      aria-label="Session id"
                      className={linkError ? "is-bad" : undefined}
                      value={linkId}
                      placeholder="Session id"
                      maxLength={80}
                      autoFocus
                      spellCheck={false}
                      onChange={(event) => {
                        setLinkId(event.target.value);
                        setLinkError("");
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") closeLink();
                      }}
                    />
                    <button type="submit" className="primary" disabled={busy || !linkId.trim()}>Link</button>
                  </div>
                  {linkError ? (
                    <p className="ticket-link-alert" role="alert">
                      <AlertIcon />
                      {linkError}
                    </p>
                  ) : (
                    <p className="ticket-hint">Paste the chat's session id</p>
                  )}
                </form>
              ) : null}
              <div className="ticket-rows ticket-chats">
                {threads.map((link) => (
                  <div key={link.sessionId} className="ticket-row">
                    <button type="button" className="ticket-row-main" onClick={() => onOpenSession(link.sessionId)}>
                      <ChatIcon />
                      <span className="ticket-row-title">{chats.find((chat) => chat.id === link.sessionId)?.title || "Chat"}</span>
                      {live.has(link.sessionId) ? <i className="board-run" aria-label="Running" /> : null}
                    </button>
                    <button type="button" className="text-button ticket-unlink" onClick={() => { onUnlink(link.sessionId).catch(() => {}); }}>
                      Unlink
                    </button>
                  </div>
                ))}
              </div>
              <button type="button" className="primary ticket-new-chat" data-testid="new-thread" disabled={busy} onClick={onThread}>
                <PlusIcon />
                New chat
              </button>
            </div>
            {created || updated ? (
              <p className="ticket-stamp is-wide">
                {created ? <span title={exactTime(created)}>{`Created ${relativeTime(created, now)}`}</span> : null}
                {created && updated ? " · " : null}
                {updated ? <span title={exactTime(updated)}>{`Updated ${relativeTime(updated, now)}`}</span> : null}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </aside>
  );
}

interface StatusMenuProps {
  board: BoardView;
  status: unknown;
  // The moves the source allows from here, or null while they load.
  moves: BoardMove[] | null;
  onPick: (choice: BoardMove) => void;
}

function StatusMenu({ board, status, moves, onPick }: StatusMenuProps) {
  const flow = transitions(board);
  const here = columnFor(board.columns, status);
  const choices = board.columns.flatMap<{ column: BoardColumn; choice: BoardMove | null }>((column) => {
    if (column.value === status) return [{ column, choice: null }];
    const choice = (moves || []).find((move) => move.status === column.value);
    return choice ? [{ column, choice }] : [];
  });
  return (
    <div ref={leaveRef} className="ticket-menu is-status" role="menu" aria-label="Move to">
      {flow ? <p className="ticket-menu-note">{`Moves ${sourceName(board)} allows from ${String(here?.title ?? "here")}`}</p> : null}
      {moves === null ? <p className="ticket-menu-note">Loading…</p> : null}
      {choices.map(({ column, choice }) => (
        <button
          key={keyOf(column.value === null ? "unset" : column.value)}
          type="button"
          role="menuitem"
          className={choice ? "" : "is-current"}
          disabled={!choice}
          onClick={() => choice && onPick(choice)}
        >
          <i style={{ background: columnTone(column) }} />
          {nodeOf(column.title)}
          {choice ? null : <span className="ticket-menu-check"><CheckIcon /></span>}
        </button>
      ))}
      {flow && moves !== null && choices.length < 2 ? <p className="ticket-menu-note">No moves from here</p> : null}
    </div>
  );
}

interface TextSectionProps {
  title: string;
  field: TextField;
  value: string;
  prose: TicketProse;
  empty: string;
  editing: TextField | null;
  draft: string;
  rows: number;
  quiet?: boolean;
  savingFields: TextField[];
  onStart: (field: TextField) => void;
  onDraft: (value: string) => void;
  onKey: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onSave: () => void;
}

function TextSection({ title, field, value, prose, empty, editing, draft, rows, quiet, savingFields, onStart, onDraft, onKey, onSave }: TextSectionProps) {
  const open = editing === field;
  return (
    <section>
      <h3 className="ticket-h">
        {title}
        {open ? (
          <button type="button" className="text-button" onMouseDown={(event) => event.preventDefault()} onClick={onSave}>Done</button>
        ) : (
          <button type="button" className="text-button" onClick={() => onStart(field)}>
            <EditIcon />
            Edit
          </button>
        )}
      </h3>
      {open ? (
        <div className="ticket-editor">
          <textarea aria-label={title} value={draft} rows={rows} autoFocus readOnly={savingFields.includes(field)} onChange={(event) => onDraft(event.target.value)} onKeyDown={onKey} onBlur={onSave} />
          <p className="ticket-hint">
            <span>Markdown</span>
            <span>Saves when you leave the field</span>
            <span>Esc drops the edit</span>
          </p>
        </div>
      ) : value ? (
        <div className={quiet ? "ticket-notebox" : undefined}>
          <MarkdownView className="ticket-prose" text={prose.text(value)} imageSrc={prose.imageSrc} imagePending={prose.imagePending} videoSrc={prose.videoSrc} />
        </div>
      ) : (
        <button type="button" className="ticket-empty" onClick={() => onStart(field)}>{empty}</button>
      )}
    </section>
  );
}

function LinkedRow({ board, item, subtask, onOpen }: { board: BoardView; item: Linked; subtask?: boolean; onOpen: (taskId: unknown) => void }) {
  const column = columnFor(board.columns, item.status);
  const key = cardBadge(board, { id: item.id });
  const tone = column ? columnTone(column) : item.done ? "var(--status-done)" : "var(--status-open)";
  return (
    <button type="button" className="ticket-row" onClick={() => onOpen(item.id)}>
      {subtask ? (canDo(board, "types") ? <TypeIcon type="subtask" /> : null) : <span className="ticket-rel">{item.kind}</span>}
      <span className="ticket-row-key">{key}</span>
      <span className="ticket-row-title">{item.title}</span>
      {item.status !== null ? (
        <span className="ticket-state" style={{ "--tone": tone }}>{nodeOf(column?.title ?? item.status)}</span>
      ) : null}
    </button>
  );
}

export function Avatar({ person, size = "md" }: { person: BoardPerson | null; size?: "sm" | "md" | "lg" }) {
  if (!person) {
    return (
      <span className={`ticket-avatar is-${size} is-none`} aria-hidden="true">
        <CommentIcon size={11} />
      </span>
    );
  }
  return (
    <span className={`ticket-avatar is-${size}`} style={{ "--hue": avatarTone(person.name) }} title={person.name}>
      {initials(person.name)}
    </span>
  );
}

function People({ list }: { list: BoardPerson[] }) {
  if (!list.length) return <div className="ticket-value"><span className="ticket-quiet">Unassigned</span></div>;
  const [only] = list;
  if (list.length === 1 && only) {
    return (
      <div className="ticket-value">
        <Avatar person={only} size="md" />
        <span className="ticket-row-title">{only.name}</span>
      </div>
    );
  }
  return (
    <div className="ticket-value" title={list.map((person) => person.name).join(", ")}>
      <span className="ticket-stack">
        {list.slice(0, 4).map((person) => <Avatar key={person.id} person={person} size="md" />)}
      </span>
      <span className="ticket-row-title ticket-quiet">{list.map((person) => person.name.split(" ")[0]).join(", ")}</span>
    </div>
  );
}

interface CommentRowProps {
  item: TicketComment;
  prose: TicketProse;
  now: Date;
  editable: boolean;
  onEdit: (text: string) => Promise<void>;
  onDelete: () => Promise<void>;
}

function CommentRow({ item, prose, now, editable, onEdit, onDelete }: CommentRowProps) {
  const [mode, setMode] = useState<"read" | "edit" | "delete">("read");
  const [text, setText] = useState("");
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState(false);
  const who = people([item.author])[0] ?? null;
  const created = textOf(item.created);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setFailure("");
    try {
      await action();
      setMode("read");
    } catch (error) {
      setFailure(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ticket-comment">
      <Avatar person={who} size="lg" />
      <div className="ticket-comment-body">
        <div className="ticket-comment-head">
          {who ? <b>{who.name}</b> : null}
          {created ? <time dateTime={created} title={exactTime(created)}>{relativeTime(created, now)}</time> : null}
          {editable && mode === "read" ? (
            <span className="ticket-comment-actions">
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setText(textOf(item.body));
                  setMode("edit");
                }}
              >
                Edit
              </button>
              <button type="button" className="text-button" onClick={() => setMode("delete")}>Delete</button>
            </span>
          ) : null}
        </div>
        {mode === "edit" ? (
          <form
            className="ticket-comment-edit"
            onSubmit={(event) => {
              event.preventDefault();
              const body = text.trim();
              if (body) run(() => onEdit(body));
            }}
          >
            <textarea
              aria-label="Edit comment"
              value={text}
              rows={3}
              autoFocus
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setMode("read");
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <span className="ticket-comment-buttons">
              <button type="button" className="text-button" onClick={() => setMode("read")}>Cancel</button>
              <button type="submit" className="primary" disabled={busy || !text.trim()}>Save</button>
            </span>
          </form>
        ) : (
          <MarkdownView className="ticket-prose" text={prose.text(textOf(item.body))} imageSrc={prose.imageSrc} imagePending={prose.imagePending} videoSrc={prose.videoSrc} />
        )}
        {mode === "delete" ? (
          <div className="ticket-comment-confirm">
            <span>Delete this comment?</span>
            <button type="button" className="text-button" onClick={() => setMode("read")}>Cancel</button>
            <button type="button" className="text-button danger" disabled={busy} onClick={() => run(onDelete)}>Delete</button>
          </div>
        ) : null}
        {failure ? <p className="ticket-error">{failure}</p> : null}
      </div>
    </div>
  );
}

