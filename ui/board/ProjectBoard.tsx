import { Fragment, useEffect, useRef, useState } from "react";
import type { DragEvent, FormEvent } from "react";
import type { SakStatus } from "../../server/board/sak/sakClient.ts";
import type { SidebarSession, TicketLinks } from "../../server/snapshot.ts";
import type { ComposerCatalog } from "../../server/snapshot.ts";
import { BoardSite, type BoardSitePage, type BoardSiteRequest } from "./BoardSite.tsx";
import { ThreadSheet } from "./ThreadSheet.tsx";
import type { DraftPicks } from "../chat/composer/draftConfig.ts";
import type { WorktreePlan } from "../folder/draftWorktree.ts";
import { LabelPicker } from "./LabelPicker.tsx";
import { LabelSheet } from "./LabelSheet.tsx";
import { Avatar, TicketDetail, TicketSkeleton } from "./TicketDetail.tsx";
import { AlertIcon, CalendarIcon, CheckIcon, ChecklistIcon, ChevronIcon, CommentIcon, LinkIcon, PlusIcon, SubtasksIcon, TypeIcon } from "./boardIcons.tsx";
import {
  boardView,
  canDo,
  cardBadge,
  checked,
  columnFor,
  columnTone,
  counted,
  cssValue,
  isDetailTask,
  isRecord,
  keyOf,
  LIST_COLORS,
  messageOf,
  neededFields,
  nodeOf,
  parentOf,
  people,
  sameId,
  sourceName,
  taskDetail,
  taskStatus,
  textOf,
  ticketName,
  UNREADABLE_BOARD,
  type BoardCall,
  type BoardColumn,
  type BoardLabel,
  type BoardTask,
  type DetailTask,
  type BoardView,
  type BoardPerson,
  type MoveField,
  type TaskDetail,
} from "./boardData.ts";
import { threadCount } from "./ticketStatus.ts";
import { useDismiss } from "./useDismiss.ts";
import { watchGit } from "../git/gitWatch.ts";
import {
  dropIndex,
  dueState,
  hideCollapsed,
  nestCards,
  nextCard,
  personCounts,
  personMatch,
  placeAmong,
  placeInOrder,
  reorderTasks,
} from "./ticketView.ts";
import { leaveRef } from "../leaveRef.ts";
import { usePresence } from "../usePresence.ts";

interface CardMenu {
  id: unknown;
  x: number;
  y: number;
}

interface DropSpot {
  column: unknown;
  index: number;
}

interface Asking {
  task: BoardTask;
  status: unknown;
  order?: string[];
  fields: MoveField[];
  values: Record<string, string>;
}

function isSakStatus(value: unknown): value is Pick<SakStatus, "baseUrl"> {
  return isRecord(value) && typeof value.baseUrl === "string";
}

function isPainted(value: unknown): value is { column: BoardColumn } {
  return isRecord(value) && isRecord(value.column);
}

function isCreated(value: unknown): value is { task: BoardTask; refused?: unknown } {
  return isRecord(value) && isRecord(value.task);
}

const DRAG_TYPE = "application/x-board-task";
const EXPANDED_KEY = "x-bench-ticket-expanded";

const PERSON_KEY = "x-bench-board-person:";

function readExpanded(): boolean {
  try {
    return localStorage.getItem(EXPANDED_KEY) === "1";
  } catch {
    return false;
  }
}

// name labels the saved pick while that person has no ticket on the board.
function readPerson(boardKey: string): BoardPerson | null {
  try {
    return people([JSON.parse(localStorage.getItem(PERSON_KEY + boardKey) ?? "null")])[0] ?? null;
  } catch {
    return null;
  }
}

function statusKey(value: unknown): unknown {
  return value === null || value === undefined ? "unset" : value;
}

function labelChoices(labels: BoardLabel[]): { title: unknown; color: unknown }[] {
  const seen = new Map<unknown, unknown>();
  for (const label of labels || []) {
    if (!label?.title || seen.has(label.title)) continue;
    seen.set(label.title, label.color || "");
  }
  return [...seen.entries()].map(([title, color]) => ({ title, color }));
}

function toggleValue<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

export interface BoardLink {
  url: string;
  source: string;
  signedIn: boolean;
}

export interface ProjectBoardProps {
  cwd: string;
  taskId?: unknown;
  // Every chat in the sidebar, the Chat tab's and each project's.
  chats: SidebarSession[];
  call: BoardCall;
  onOpenSession: (sessionId: string) => void;
  catalog: ComposerCatalog;
  picks: DraftPicks;
  onPick: (id: string, value: string) => void;
  worktree: WorktreePlan;
  onWorktree: (on: boolean) => void;
  onLink?: (link: BoardLink | null) => void;
  // A board task's id as the board sent it, or null.
  onSelect?: (taskId: unknown) => void;
  refreshKey?: unknown;
  working?: string[] | null;
  tickets?: TicketLinks | null;
  sitePage?: BoardSitePage | null;
  onOpenSite?: (request: BoardSiteRequest) => void;
  onCloseSite?: () => void;
}

export function ProjectBoard({ cwd, taskId, chats, call, onOpenSession, catalog, picks, onPick, worktree, onWorktree, onLink, onSelect, refreshKey, working = [], tickets = null, sitePage = null, onOpenSite, onCloseSite }: ProjectBoardProps) {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [board, setBoard] = useState<BoardView | null>(null);
  const [failure, setFailure] = useState("");
  const [address, setAddress] = useState("");
  const [selected, setSelected] = useState<unknown>(taskId);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [spot, setSpot] = useState<DropSpot | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [poll, setPoll] = useState(0);
  const [menu, setMenu] = useState<CardMenu | null>(null);
  const [colorFor, setColorFor] = useState<unknown>(null);
  const [adding, setAdding] = useState<{ column: unknown } | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [newLabels, setNewLabels] = useState<BoardLabel[]>([]);
  const [labelSheet, setLabelSheet] = useState<{ taskId: unknown } | null>(null);
  const [addError, setAddError] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  // Moves a source refused, by ticket id, shown on the card until dismissed or moved again.
  const [refusals, setRefusals] = useState<Record<string, string>>({});
  const [asking, setAsking] = useState<Asking | null>(null);
  const [deleting, setDeleting] = useState<{ task: BoardTask; error: string; busy: boolean } | null>(null);
  const [threadFor, setThreadFor] = useState<BoardTask | null>(null);
  const loaded = useRef(false);
  const activity = useRef<unknown>("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState<unknown[]>([]);
  const [labelFilter, setLabelFilter] = useState<unknown[]>([]);
  const [hideEmpty, setHideEmpty] = useState(false);
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [picked, setPicked] = useState<{ boardKey: string; person: BoardPerson | null } | null>(null);
  const [quickMenu, setQuickMenu] = useState<"person" | "type" | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  // Parents whose sub-tasks show under them. Sub-tasks start collapsed.
  const [openParents, setOpenParents] = useState<ReadonlySet<string>>(() => new Set());
  const [expanded, setExpanded] = useState(readExpanded);
  const closeDetail = useRef<() => void>(() => {});
  // The ticket whose detail failed to load, which closes its pane.
  const [missing, setMissing] = useState<unknown>(null);
  // The pane opens on a skeleton until the detail comes, and stays mounted while it slides out.
  const ticketOpen = Boolean(selected) && !sameId(missing, selected);
  const ticketPresence = usePresence(ticketOpen, window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 350);
  const lastDetail = useRef(detail);
  if (ticketOpen) lastDetail.current = detail;
  const pane = ticketOpen ? detail : lastDetail.current;
  const paneLoading = ticketOpen && Boolean(pane?.task) && !sameId(pane?.task?.id, selected);

  useDismiss(quickMenu !== null, "[data-quick-menu]", () => setQuickMenu(null));
  useDismiss(filtersOpen, ".board-bar", () => setFiltersOpen(false));
  useDismiss(colorFor !== null, "[data-color-menu]", () => setColorFor(null));

  // Esc closes the open ticket, unless it belongs to a field, a menu or a dialog that is open.
  useEffect(() => {
    if (!selected) return undefined;
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable='true']")) return;
      if (document.querySelector(".sheet-scrim, .ticket-menu, .board-menu, .board-filter-panel, .column-toolbar.is-open, .board-site")) return;
      closeDetail.current();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), 200);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    if (!menu) return undefined;
    function close(event?: Event) {
      if (event instanceof MouseEvent && event.button === 2) return;
      setMenu(null);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") close();
    }
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
    };
  }, [menu]);

  const scrolledTask = useRef<unknown>(null);
  useEffect(() => {
    setSelected(taskId ?? null);
  }, [taskId]);

  useEffect(() => {
    if (!taskId || selected !== taskId || !board || scrolledTask.current === taskId) return;
    const card = document.querySelector(".board-card.is-selected");
    if (!card) return;
    scrolledTask.current = taskId;
    card.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [taskId, selected, board]);

  // A write through this host reloads the board through refreshKey, so polling only picks up edits made elsewhere.
  const local = canDo(board, "local");
  useEffect(() => watchGit(() => setPoll((value) => value + 1), local ? 10_000 : 60_000, 60_000), [local, cwd]);

  useEffect(() => {
    loaded.current = false;
    activity.current = "";
  }, [cwd, query]);

  useEffect(() => {
    function onFocus() {
      setPoll((value) => value + 1);
    }
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  useEffect(() => {
    let cancel = false;
    if (!loaded.current) setFailure("");
    const params = new URLSearchParams({ cwd });
    if (query) params.set("search", query);
    if (activity.current) params.set("activity", String(activity.current));
    call(`/api/board/board?${params}`, null, "GET", { quiet: true })
      .then((data) => {
        if (cancel) return;
        if (isRecord(data) && data.unchanged) {
          loaded.current = true;
          activity.current = data.activity || activity.current;
          return;
        }
        const view = boardView(data);
        // The catch shows this on the first load and keeps the last board on a later poll.
        if (!view) throw new Error(UNREADABLE_BOARD);
        loaded.current = true;
        activity.current = view.activity || "";
        setBoard(view);
        onLink?.(typeof view.url === "string" && view.url ? { url: view.url, source: sourceName(view), signedIn: canDo(view, "signedInPages") } : null);
      })
      .catch(async (error: unknown) => {
        if (cancel || loaded.current) return;
        setBoard(null);
        setFailure(messageOf(error));
        // Only a failed SAK request points at the SAK address.
        if (/trello|jira/i.test(messageOf(error)) || messageOf(error) === UNREADABLE_BOARD) {
          setAddress("");
          return;
        }
        try {
          const status = await call("/api/sak/status", null, "GET", { quiet: true });
          if (!cancel) setAddress((isSakStatus(status) && status.baseUrl) || "");
        } catch {
          if (!cancel) setAddress("");
        }
      });
    return () => {
      cancel = true;
    };
  }, [cwd, query, refreshKey, reload, poll, call, onLink]);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return undefined;
    }
    let cancel = false;
    call(`/api/board/tasks/${selected}`, null, "GET", { quiet: true })
      .then((data) => {
        if (cancel) return;
        const next = taskDetail(data);
        setDetail(next);
        if (!next?.task) setMissing(selected);
      })
      .catch(() => {
        if (cancel) return;
        setDetail(null);
        setMissing(selected);
      });
    return () => {
      cancel = true;
    };
  }, [selected, refreshKey, reload, poll, call]);

  function dismissRefusal(id: unknown) {
    setRefusals((current) => {
      if (!(String(id) in current)) return current;
      const next = { ...current };
      delete next[String(id)];
      return next;
    });
  }

  // Moves the ticket to the column, and to its place in order when one is given. A source that
  // asks for fields first opens the form for them; any other refusal shows on the card.
  async function move(task: BoardTask, status: unknown, order?: string[], fields?: Record<string, string>): Promise<void> {
    if (taskStatus(task) === status && !order) return;
    const id = String(task.id);
    const before = board?.tasks.find((item) => sameId(item.id, task.id));
    setBoard((value) => {
      if (!value) return value;
      const tasks = value.tasks.map((item) => {
        if (!sameId(item.id, task.id)) return item;
        const attributes: Record<string, unknown> = { ...item.attributes };
        if (status === null) delete attributes.status;
        else attributes.status = status;
        return { ...item, attributes };
      });
      return { ...value, tasks: order ? reorderTasks(tasks, (item) => String(item.id), id, order) : tasks };
    });
    dismissRefusal(id);
    try {
      const result = await call("/api/board/move", { taskId: task.id, status, cwd, ...(order ? { order } : {}), ...(fields ? { fields } : {}) }, "POST", { silent: true });
      if (isRecord(result) && isDetailTask(result.task)) {
        const moved = result.task;
        setBoard((value) => value && ({ ...value, tasks: value.tasks.map((item) => (sameId(item.id, moved.id) ? { ...item, ...moved } : item)) }));
      }
    } catch (error) {
      // Put the card back; the reload brings back its place in the column.
      setBoard((value) => value && before ? { ...value, tasks: value.tasks.map((item) => (sameId(item.id, task.id) ? before : item)) } : value);
      const needs = neededFields(error);
      if (needs.length) setAsking({ task, status, order, fields: needs, values: {} });
      else setRefusals((current) => ({ ...current, [id]: messageOf(error) || "The move was refused" }));
      setReload((value) => value + 1);
    }
  }

  async function paintColumn(column: BoardColumn, color: string | null) {
    const saved = checked(await call("/api/board/lists", { cwd, listId: column.value, color }), isPainted);
    setBoard((current) => current && ({
      ...current,
      columns: current.columns.map((item) => (
        item.value === column.value ? { ...item, color: saved.column.color, colorName: saved.column.colorName } : item
      )),
    }));
    setColorFor(null);
  }

  function choose(id: unknown) {
    setMissing(null);
    setSelected(id);
    onSelect?.(id);
  }

  function focusCard(id: string | null) {
    if (id === null) return;
    setFocusId(id);
    document.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(id)}"]`)?.focus();
  }

  function closeTicket() {
    const id = selected;
    choose(null);
    if (id !== null && id !== undefined) focusCard(String(id));
  }

  // Another ticket may have opened while the call ran; its detail stays.
  async function reloadDetail(taskId: unknown) {
    const next = taskDetail(await call(`/api/board/tasks/${String(taskId)}`, null, "GET"));
    setDetail((current) => (sameId(current?.task?.id, taskId) ? next : current));
  }
  // Esc takes an expanded ticket back to the side first.
  closeDetail.current = () => (expanded ? expand(false) : closeTicket());

  function pickPerson(boardKey: string, next: BoardPerson | null) {
    setPicked({ boardKey, person: next });
    setQuickMenu(null);
    try {
      if (next) localStorage.setItem(PERSON_KEY + boardKey, JSON.stringify(next));
      else localStorage.removeItem(PERSON_KEY + boardKey);
    } catch {
      // Without storage the choice lasts until the page reloads.
    }
  }

  function expand(next: boolean) {
    setExpanded(next);
    try {
      localStorage.setItem(EXPANDED_KEY, next ? "1" : "0");
    } catch {
      // Without storage the choice lasts until the page reloads.
    }
  }

  function forgetTask(taskId: unknown) {
    setBoard((current) => current && ({
      ...current,
      tasks: current.tasks.filter((item) => !sameId(item.id, taskId)),
    }));
    setSelected((current: unknown) => (sameId(current, taskId) ? null : current));
    if (sameId(selected, taskId)) onSelect?.(null);
    setDetail((current) => (sameId(current?.task?.id, taskId) ? null : current));
    setMenu(null);
  }

  // A save answers with the ticket as the source stores it, without the fields the detail read adds.
  function savedTask(task: DetailTask) {
    setDetail((current) => (current?.task && sameId(current.task.id, task.id) ? { ...current, task: { ...current.task, ...task } } : current));
    setBoard((current) => current && { ...current, tasks: current.tasks.map((item) => (sameId(item.id, task.id) ? { ...item, ...task } : item)) });
  }

  function forgetLabel(label: BoardLabel) {
    const others = (labels: BoardLabel[] | null | undefined) => (labels || []).filter((item) => !sameId(item.id, label.id));
    setBoard((current) => current && { ...current, labels: others(current.labels), tasks: current.tasks.map((task) => ({ ...task, labels: others(task.labels) })) });
    setDetail((current) => (current?.task ? { ...current, task: { ...current.task, labels: others(current.task.labels) } } : current));
    setLabelFilter((list) => list.filter((title) => title !== label.title));
    setNewLabels(others);
  }

  async function removeTask() {
    if (!deleting) return;
    setDeleting({ ...deleting, busy: true, error: "" });
    try {
      await call(`/api/board/tasks/${deleting.task.id}`, null, "DELETE", { silent: true });
      forgetTask(deleting.task.id);
      setDeleting(null);
    } catch (error) {
      setDeleting({ ...deleting, busy: false, error: messageOf(error) });
    }
  }

  async function addTicket(event: FormEvent<HTMLFormElement>, column: BoardColumn) {
    event.preventDefault();
    const title = newTitle.trim();
    if (!title || addBusy) return;
    setAddError("");
    setAddBusy(true);
    try {
      const labels = newLabels.length ? { labels: newLabels.map((label) => label.id) } : {};
      const created = checked(await call("/api/board/tasks", { cwd, title, status: column.value, ...labels }, "POST", { silent: true }), isCreated);
      // The reload a write pushes may have brought the ticket already, and under a search only it knows whether the ticket matches.
      if (!query) setBoard((current) => current && (current.tasks.some((item) => sameId(item.id, created.task.id)) ? current : { ...current, tasks: [...current.tasks, created.task] }));
      const refused = created.refused;
      if (typeof refused === "string") setRefusals((current) => ({ ...current, [String(created.task.id)]: refused }));
      setNewTitle("");
      setNewLabels([]);
    } catch (error) {
      setAddError(messageOf(error));
    } finally {
      setAddBusy(false);
    }
  }

  function openAdding(column: BoardColumn) {
    setAdding({ column: column.value });
    setAddError("");
  }

  function closeAdding() {
    setAdding(null);
    setNewTitle("");
    setNewLabels([]);
    setAddError("");
  }

  function dragOver(event: DragEvent<HTMLElement>, column: BoardColumn) {
    if (!dragging) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const cards = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-card-id]")]
      .filter((card) => card.dataset.cardId !== dragging);
    const index = dropIndex(cards.map((card) => {
      const rect = card.getBoundingClientRect();
      return rect.top + rect.height / 2;
    }), event.clientY);
    setSpot((current) => (current && current.column === column.value && current.index === index ? current : { column: column.value, index }));
  }

  // shown is the column's cards that show; whole is every card the column holds, in order.
  function drop(event: DragEvent<HTMLElement>, column: BoardColumn, shown: string[], whole: string[]) {
    event.preventDefault();
    const id = event.dataTransfer.getData(DRAG_TYPE) || dragging;
    const index = spot && spot.column === column.value ? spot.index : shown.length;
    setSpot(null);
    setDragging(null);
    const task = board?.tasks?.find((item) => String(item.id) === id);
    if (!task || !id) return;
    const unmoved = taskStatus(task) === column.value && placeInOrder(shown, id, index).join("\n") === shown.join("\n");
    if (!unmoved) move(task, column.value, placeAmong(whole, shown, id, index));
  }

  if (failure) {
    return (
      <div className="board board-missing" data-testid="board">
        <p>{failure}</p>
        {address ? <p className="board-address">{address}</p> : null}
      </div>
    );
  }

  if (!board) return <BoardSkeleton />;

  const choices = labelChoices([
    ...(board.labels || []),
    ...(board.tasks || []).flatMap((task) => task.labels || []),
  ]);
  const statusOn = new Set(statusFilter);
  const labelOn = new Set(labelFilter);
  const me = typeof board.me === "string" && board.me ? board.me : null;
  const assigned = (task: BoardTask) => people(task.assignees).map((item) => item.id);
  // Every filter but the person one, so the person menu can count what each pick would show.
  const filtered = (board.tasks || []).filter((task) => {
    const key = statusKey(taskStatus(task));
    if (statusOn.size && !statusOn.has(key)) return false;
    if (labelOn.size && !(task.labels || []).some((label) => labelOn.has(label.title))) return false;
    return !typeFilter || typeKey(task) === typeFilter;
  });
  // The board's own address names it, so folders bound to the same board share the pick.
  const boardKey = textOf(board.url) || cwd;
  const person = picked?.boardKey === boardKey ? picked.person : readPerson(boardKey);
  const personId = canDo(board, "assignees") ? person?.id ?? null : null;
  const shown = filtered.filter((task) => personMatch(assigned(task), personId, me));
  const lanes = board.columns.filter((column) => {
    const key = statusKey(column.value);
    if (statusOn.size && !statusOn.has(key)) return false;
    if (!hideEmpty) return true;
    return shown.some((task) => statusKey(taskStatus(task)) === key);
  });
  const filterCount = statusFilter.length + labelFilter.length + (hideEmpty ? 1 : 0);
  // The ticket the detail shows, as the board has it now; the detail can still show the last one
  // while a newly picked one loads.
  const detailTask = detail?.task ? board.tasks.find((item) => sameId(item.id, detail.task?.id)) ?? detail.task : null;
  const now = new Date();
  const nestedIn = (tasks: BoardTask[], column: BoardColumn) => {
    const inColumn = tasks.filter((task) => taskStatus(task) === column.value);
    const byId = new Map(inColumn.map((task) => [String(task.id), task]));
    return nestCards(inColumn.map((task) => ({ id: String(task.id), parent: parentOf(task) }))).flatMap((card) => {
      const task = byId.get(card.id);
      return task ? [{ ...card, task }] : [];
    });
  };
  const lanesCards = lanes.map((column) => hideCollapsed(nestedIn(shown, column), openParents));
  const grid = lanesCards.map((cards) => cards.map((card) => card.id));
  const parentBadge = (task: BoardTask) => {
    const parent = parentOf(task);
    const found = parent === null ? undefined : board.tasks.find((item) => String(item.id) === parent);
    return found ? cardBadge(board, found) : parent === null ? null : cardBadge(board, { id: parent });
  };
  const visible = grid.flat();
  const tabStop = [focusId, selected === null || selected === undefined ? null : String(selected)].find((id) => id !== null && visible.includes(id)) ?? visible[0] ?? null;
  const everyone = boardPeople(board);
  const types = boardTypes(board);
  const counts = personCounts(filtered.map(assigned));
  const myself = everyone.find((item) => item.id === me);
  const others = everyone.filter((item) => item.id !== me);
  if (person && person.id !== "me" && person.id !== "none" && !others.some((item) => item.id === person.id)) others.push(person);

  return (
    <div className="board" data-testid="board">
      <div className="board-bar">
        <div className="board-toolbar">
          <label className="board-search">
            <SearchIcon />
            <input
              value={search}
              placeholder="Search"
              aria-label="Search tickets"
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <button
            type="button"
            className={filtersOpen || filterCount ? "board-filter is-on" : "board-filter"}
            aria-expanded={filtersOpen}
            onClick={() => setFiltersOpen((open) => !open)}
          >
            Filter{filterCount ? ` · ${filterCount}` : ""}
          </button>
          {canDo(board, "assignees") && (everyone.length || person) ? (
            <QuickMenu
              label="Person"
              value={personId}
              open={quickMenu === "person"}
              find="Find a person"
              options={[
                { value: null, label: "Everyone", count: filtered.length },
                ...(me || personId === "me" ? [{ value: "me", label: "Me", hint: myself?.name, person: myself, count: me ? counts.get(me) ?? 0 : 0 }] : []),
                { value: "none", label: "Unassigned", person: null, count: counts.get("none") ?? 0 },
                ...others.map((item, index) => ({ value: item.id, label: item.name, person: item, count: counts.get(item.id) ?? 0, rule: index === 0 })),
              ]}
              onToggle={() => setQuickMenu((current) => (current === "person" ? null : "person"))}
              onPick={(value, label) => pickPerson(boardKey, value === null ? null : { id: value, name: label })}
            />
          ) : null}
          {canDo(board, "types") && (types.length > 1 || typeFilter) ? (
            <QuickMenu
              label="Type"
              value={typeFilter}
              open={quickMenu === "type"}
              options={[{ value: null, label: "Any type" }, ...types.map((type) => ({ value: type.value, label: type.value, type: type.icon }))]}
              onToggle={() => setQuickMenu((current) => (current === "type" ? null : "type"))}
              onPick={(value) => {
                setTypeFilter(value);
                setQuickMenu(null);
              }}
            />
          ) : null}
          {statusFilter.map((key) => (
            <button key={keyOf(key)} type="button" className="board-chip" onClick={() => setStatusFilter((list) => toggleValue(list, key))}>
              {nodeOf(key)}
              <span aria-hidden="true">×</span>
            </button>
          ))}
          {labelFilter.map((title) => (
            <button key={keyOf(title)} type="button" className="board-chip" onClick={() => setLabelFilter((list) => toggleValue(list, title))}>
              {nodeOf(title)}
              <span aria-hidden="true">×</span>
            </button>
          ))}
          <span className="board-spacer" />
          <span className="board-count">{shown.length === 1 ? "1 ticket" : `${shown.length} tickets`}</span>
        </div>
        {filtersOpen ? (
          <div ref={leaveRef} className="board-filter-panel" role="dialog" aria-label="Filters">
            <section>
              <h3>Status</h3>
              <div className="board-filter-options">
                {board.columns.map((column) => {
                  const key = statusKey(column.value);
                  return (
                    <label key={keyOf(key)}>
                      <input
                        type="checkbox"
                        checked={statusFilter.includes(key)}
                        onChange={() => setStatusFilter((list) => toggleValue(list, key))}
                      />
                      <i style={{ background: columnTone(column) }} />
                      {nodeOf(column.title)}
                    </label>
                  );
                })}
              </div>
            </section>
            <section>
              <h3>Label</h3>
              {choices.length ? (
                <div className="board-filter-options">
                  {choices.map((label) => (
                    <label key={keyOf(label.title)}>
                      <input
                        type="checkbox"
                        checked={labelFilter.includes(label.title)}
                        onChange={() => setLabelFilter((list) => toggleValue(list, label.title))}
                      />
                      <i style={{ background: cssValue(label.color || "var(--faint)") }} />
                      {nodeOf(label.title)}
                    </label>
                  ))}
                </div>
              ) : <p className="board-quiet">No labels on this project.</p>}
              {canDo(board, "labels") ? (
                <button
                  type="button"
                  className="text-button board-filter-manage"
                  onClick={() => {
                    setFiltersOpen(false);
                    setLabelSheet({ taskId: null });
                  }}
                >
                  Manage labels…
                </button>
              ) : null}
            </section>
            <div className="board-filter-foot">
              <label>
                <input type="checkbox" checked={hideEmpty} onChange={(event) => setHideEmpty(event.target.checked)} />
                Hide empty columns
              </label>
              <button
                type="button"
                className="text-button"
                disabled={!filterCount}
                onClick={() => {
                  setStatusFilter([]);
                  setLabelFilter([]);
                  setHideEmpty(false);
                }}
              >
                Clear
              </button>
            </div>
          </div>
        ) : null}
      </div>
      {board.truncated ? <p className="board-note">{`Showing the first ${board.tasks.length} tickets.`}</p> : null}
      <div className="board-frame">
        <div className="board-columns">
          {lanes.map((column, lane) => {
            const nested = lanesCards[lane] ?? [];
            const cards = nested.map((card) => card.task);
            // Collapsed sub-tasks count too.
            const count = shown.filter((task) => taskStatus(task) === column.value).length;
            const cardIds = nested.map((card) => card.id);
            const others = cardIds.filter((id) => id !== dragging);
            const line = spot && spot.column === column.value ? spot.index : -1;
            const open = adding !== null && adding.column === column.value;
            let place = 0;
            return (
              <section
                key={keyOf(statusKey(column.value))}
                className={line >= 0 ? "board-column is-over" : "board-column"}
                data-testid={`column-${String(statusKey(column.value))}`}
                onDragOver={(event) => dragOver(event, column)}
                onDragLeave={(event) => {
                  if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
                  setSpot((current) => (current?.column === column.value ? null : current));
                }}
                onDrop={(event) => drop(event, column, cardIds, nestedIn(board.tasks, column).map((card) => card.id))}
              >
                <header data-color-menu={canDo(board, "columnColors") ? "header" : undefined}>
                  <h3>
                    {canDo(board, "columnColors") ? (
                      <button
                        type="button"
                        className={colorFor === column.value ? "column-swatch is-open" : "column-swatch"}
                        style={{ background: columnTone(column) }}
                        aria-label={`Color for ${String(column.title)}`}
                        aria-expanded={colorFor === column.value}
                        onClick={() => setColorFor((current: unknown) => (current === column.value ? null : column.value))}
                      />
                    ) : (
                      <i style={{ background: columnTone(column) }} />
                    )}
                    {nodeOf(column.title)}
                    <span className="board-column-count">{count}</span>
                  </h3>
                  <button
                    type="button"
                    className="icon board-column-add"
                    aria-label={`Add a ticket to ${String(column.title)}`}
                    onClick={() => openAdding(column)}
                  >
                    <PlusIcon />
                  </button>
                </header>
                {canDo(board, "columnColors") ? (
                  <div
                    className={colorFor === column.value ? "column-toolbar is-open" : "column-toolbar"}
                    data-color-menu={colorFor === column.value ? "palette" : undefined}
                    inert={colorFor === column.value ? undefined : ("" as unknown as boolean)}
                  >
                    <div className="column-toolbar-clip">
                      <div className="column-palette" role="listbox" aria-label={`Colors for ${String(column.title)}`}>
                        {LIST_COLORS.map(([name, hex]) => (
                          <button
                            key={name}
                            type="button"
                            role="option"
                            aria-label={name}
                            aria-selected={column.colorName === name}
                            className={column.colorName === name ? "is-picked" : ""}
                            style={{ background: hex }}
                            onClick={() => paintColumn(column, name)}
                          />
                        ))}
                        <button
                          type="button"
                          role="option"
                          aria-label="No color"
                          aria-selected={!column.colorName}
                          className={!column.colorName ? "is-none is-picked" : "is-none"}
                          onClick={() => paintColumn(column, null)}
                        />
                      </div>
                    </div>
                  </div>
                ) : null}
                <div className="board-cards">
                  {cards.length === 0 && line < 0 && !open ? <p className="board-empty">No tickets</p> : null}
                  {nested.map(({ task, id, depth, children, parentAway }) => {
                    const ghost = id === dragging;
                    const before = !ghost && place === line;
                    if (!ghost) place += 1;
                    return (
                      <div
                        key={id}
                        className={depth ? "board-slot is-child" : "board-slot"}
                        style={depth ? { "--depth": Math.min(depth, 3) } : undefined}
                      >
                        {before ? <div className="board-drop" aria-hidden="true" /> : null}
                        <Card
                          board={board}
                          task={task}
                          now={now}
                          selected={sameId(selected, task.id)}
                          tabStop={id === tabStop}
                          parent={parentAway ? parentBadge(task) : null}
                          subtasksOpen={children ? openParents.has(id) : null}
                          onToggleSubtasks={() => setOpenParents((current) => {
                            const next = new Set(current);
                            if (!next.delete(id)) next.add(id);
                            return next;
                          })}
                          ghost={ghost}
                          running={cardRunning(task, tickets, working)}
                          threads={threadCount(task.id, tickets)}
                          markUnassigned={canDo(board, "assignees") && everyone.length > 0}
                          refusal={refusals[id]}
                          onDismiss={() => dismissRefusal(id)}
                          onOpen={() => choose(task.id)}
                          onFocus={() => setFocusId(id)}
                          onArrow={(key) => focusCard(nextCard(grid, id, key))}
                          onDragStart={(event) => {
                            event.dataTransfer.setData(DRAG_TYPE, id);
                            event.dataTransfer.effectAllowed = "move";
                            setDragging(id);
                          }}
                          onDragEnd={() => {
                            setDragging(null);
                            setSpot(null);
                          }}
                          onMenu={(x, y) => {
                            choose(task.id);
                            setMenu({ id: task.id, x, y });
                          }}
                        />
                      </div>
                    );
                  })}
                  {line >= 0 && line >= others.length ? <div className="board-drop" aria-hidden="true" /> : null}
                  {open ? (
                    <form className="board-adding" onSubmit={(event) => addTicket(event, column)}>
                      <textarea
                        aria-label={`New ticket in ${String(column.title)}`}
                        value={newTitle}
                        rows={2}
                        maxLength={200}
                        placeholder="Ticket title"
                        readOnly={addBusy}
                        autoFocus
                        onChange={(event) => setNewTitle(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") closeAdding();
                          if (event.key === "Enter" && !event.shiftKey) {
                            event.preventDefault();
                            event.currentTarget.form?.requestSubmit();
                          }
                        }}
                        onBlur={(event) => {
                          if (!newTitle.trim() && !(event.relatedTarget instanceof Node && event.currentTarget.form?.contains(event.relatedTarget))) closeAdding();
                        }}
                      />
                      {canDo(board, "labels") ? (
                        <div className="board-pills">
                          {newLabels.map((label) => (
                            <button
                              key={keyOf(label.id)}
                              type="button"
                              className="board-pill is-removable"
                              style={label.color ? { "--pill": cssValue(label.color) } : undefined}
                              title={`Remove ${String(label.title)}`}
                              onClick={() => setNewLabels((list) => list.filter((item) => !sameId(item.id, label.id)))}
                            >
                              {nodeOf(label.title)}
                              <span aria-hidden="true">×</span>
                            </button>
                          ))}
                          <LabelPicker
                            labels={(board.labels || []).filter((label) => label.title)}
                            picked={new Set(newLabels.map((label) => String(label.id)))}
                            disabled={addBusy}
                            onToggle={(label, on) => setNewLabels((list) => (on ? [...list, label] : list.filter((item) => !sameId(item.id, label.id))))}
                            onManage={() => setLabelSheet({ taskId: null })}
                          />
                        </div>
                      ) : null}
                      <span className="board-adding-hint">Enter adds · Esc cancels</span>
                      {addError ? <span className="board-adding-error">{addError}</span> : null}
                    </form>
                  ) : null}
                </div>
                {open ? null : (
                  <button
                    type="button"
                    className="text-button board-add"
                    onClick={() => openAdding(column)}
                  >
                    <PlusIcon />
                    Add ticket
                  </button>
                )}
              </section>
            );
          })}
        </div>
        {/* While another ticket loads, the last one stays in place, dimmed and out of reach. */}
        {ticketPresence.mounted ? (
          <div
            className={[expanded ? "ticket-overlay" : "ticket-dock", !ticketOpen ? "is-leaving" : paneLoading ? "is-loading" : ""].filter(Boolean).join(" ")}
            inert={!ticketOpen || paneLoading}
            onPointerDown={(event) => {
              if (expanded && event.target === event.currentTarget) expand(false);
            }}
          >
            {pane?.task ? <TicketDetail
              key={String(pane.task.id)}
              expanded={expanded}
              onExpand={() => expand(!expanded)}
              detail={pane}
              board={board}
              cwd={cwd}
              chats={chats}
              call={call}
              working={working || []}
              onChanged={savedTask}
              onManageLabels={() => setLabelSheet({ taskId: pane.task.id })}
              onReload={() => setReload((value) => value + 1)}
              onOpenSession={onOpenSession}
              onThread={() => setThreadFor(detailTask ?? pane.task)}
              onMove={(status, needs) => {
                const task = detailTask ?? pane.task;
                if (needs.length) setAsking({ task, status, fields: needs, values: {} });
                else move(task, status);
              }}
              onDelete={() => setDeleting({ task: detailTask ?? pane.task, error: "", busy: false })}
              onClose={closeTicket}
              onOpenTicket={(id) => choose(id)}
              onOpenSource={canDo(board, "signedInPages") && onOpenSite ? (url) => onOpenSite({ taskId: pane.task.id, href: url, source: sourceName(board), title: ticketName(board, pane.task) }) : undefined}
              onUnlink={async (sessionId) => {
                await call("/api/board/links", { sessionId, taskId: pane.task.id }, "DELETE");
                await reloadDetail(pane.task.id);
              }}
              onLink={async (sessionId) => {
                await call("/api/board/links", { cwd, sessionId, taskId: pane.task.id }, "POST", { silent: true });
                await reloadDetail(pane.task.id);
              }}
            /> : <TicketSkeleton onClose={closeTicket} />}
          </div>
        ) : null}
      </div>
      {menu && canDo(board, "deletes") ? (
        <div
          ref={leaveRef}
          className="board-menu"
          role="menu"
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            className="danger"
            onClick={() => {
              const task = board?.tasks?.find((item) => sameId(item.id, menu.id));
              setMenu(null);
              if (task) setDeleting({ task, error: "", busy: false });
            }}
          >
            {canDo(board, "archives") ? "Archive card" : "Delete ticket"}
          </button>
        </div>
      ) : null}
      {asking ? (
        <MoveFieldsSheet
          board={board}
          asking={asking}
          onChange={setAsking}
          onCancel={() => setAsking(null)}
          onMove={async () => {
            const current = asking;
            setAsking(null);
            await move(current.task, current.status, current.order, current.values);
          }}
        />
      ) : null}
      {labelSheet ? (
        <LabelSheet
          board={board}
          cwd={cwd}
          call={call}
          taskId={labelSheet.taskId}
          onAdded={(label, task) => {
            setBoard((current) => current && { ...current, labels: [...(current.labels || []).filter((item) => !sameId(item.id, label.id)), label] });
            if (task) savedTask(task);
          }}
          onDeleted={forgetLabel}
          onClose={() => setLabelSheet(null)}
        />
      ) : null}
      {deleting ? (
        <div
          className="sheet-scrim"
          onClick={() => !deleting.busy && setDeleting(null)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !deleting.busy) setDeleting(null);
          }}
        >
          <div className="sheet is-small" role="alertdialog" aria-labelledby="board-delete-title" onClick={(event) => event.stopPropagation()}>
            <h2 id="board-delete-title">
              {canDo(board, "archives") ? `Archive card ${cardBadge(board, deleting.task)}?` : `Delete ${cardBadge(board, deleting.task)}?`}
            </h2>
            <p className="sheet-copy">
              {canDo(board, "archives")
                ? `${sourceName(board)} keeps archived cards. You can restore it there.`
                : `This removes the ticket from ${sourceName(board)}, with its comments. It can't be undone.`}
            </p>
            {deleting.error ? <p className="sheet-error">{deleting.error}</p> : null}
            <div className="sheet-actions">
              <button type="button" className="text-button" disabled={deleting.busy} onClick={() => setDeleting(null)}>Cancel</button>
              <button type="button" className="danger-fill" data-testid="confirm-delete" disabled={deleting.busy} autoFocus onClick={removeTask}>
                {canDo(board, "archives") ? "Archive" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {threadFor ? (
        <ThreadSheet
          cwd={cwd}
          taskId={threadFor.id}
          title={ticketName(board, threadFor)}
          call={call}
          catalog={catalog}
          picks={picks}
          onPick={onPick}
          worktree={worktree}
          onWorktree={onWorktree}
          onStarted={() => {
            setThreadFor(null);
          }}
          onCancel={() => setThreadFor(null)}
        />
      ) : null}
      {sitePage && onCloseSite ? <BoardSite page={sitePage} onBack={onCloseSite} /> : null}
    </div>
  );
}

interface CardProps {
  board: BoardView;
  task: BoardTask;
  now: Date;
  selected: boolean;
  tabStop: boolean;
  parent: string | null;
  // Whether the sub-tasks under this card show, or null when none sit under it in this column.
  subtasksOpen: boolean | null;
  onToggleSubtasks: () => void;
  ghost: boolean;
  running: boolean;
  threads: number;
  markUnassigned: boolean;
  refusal: string | undefined;
  onDismiss: () => void;
  onOpen: () => void;
  onFocus: () => void;
  onArrow: (key: string) => void;
  onDragStart: (event: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  onMenu: (x: number, y: number) => void;
}

function Card({ board, task, now, selected, tabStop, parent, subtasksOpen, onToggleSubtasks, ghost, running, threads, markUnassigned, refusal, onDismiss, onOpen, onFocus, onArrow, onDragStart, onDragEnd, onMenu }: CardProps) {
  const type = canDo(board, "types") ? textOf(task.type) : "";
  const due = canDo(board, "dueDates") ? dueState(textOf(task.due) || null, task.dueDone === true, now) : null;
  const comments = typeof task.commentCount === "number" && task.commentCount > 0 ? task.commentCount : 0;
  const subtasks = counted(task.subtaskCount);
  const assignees = canDo(board, "assignees") ? people(task.assignees) : [];
  const checks = counted(task.checkCount);
  const foot = due || comments || subtasks || checks || assignees.length || markUnassigned;
  return (
    <article
      className={["board-card", selected ? "is-selected" : "", running ? "is-running" : "", ghost ? "is-ghost" : "", refusal ? "is-refused" : ""].filter(Boolean).join(" ")}
      data-testid="ticket-card"
      data-card-id={String(task.id)}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      tabIndex={tabStop ? 0 : -1}
      aria-current={selected ? "true" : undefined}
      onClick={onOpen}
      onFocus={onFocus}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        } else if (event.key.startsWith("Arrow")) {
          event.preventDefault();
          onArrow(event.key);
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu(event.clientX, event.clientY);
      }}
    >
      <span className="board-key">
        <span>
          {type ? <TypeIcon type={type} /> : null}
          {nodeOf(cardBadge(board, task))}
          {parent ? <span className="board-parent" title={`Sub-task of ${parent}`}>{`↳ ${parent}`}</span> : null}
        </span>
        <span className="board-key-end">
          {running ? <i className="board-run" aria-label="Running" /> : null}
          {threads > 0 ? <ThreadMark count={threads} /> : null}
        </span>
      </span>
      <strong>{nodeOf(task.title)}</strong>
      {task.labels?.length ? (
        <span className="board-pills">
          {task.labels.map((label) => (
            <span
              key={keyOf(label.id || label.title)}
              className="board-pill"
              style={label.color ? { "--pill": cssValue(label.color) } : undefined}
            >
              {nodeOf(label.title)}
            </span>
          ))}
        </span>
      ) : null}
      {foot ? (
        <span className="board-card-foot">
          {due ? (
            <span className={due.late ? "is-late" : undefined} title={due.late ? due.lateLabel : "Due"}>
              <CalendarIcon />
              {due.label}
            </span>
          ) : null}
          {comments ? (
            <span title={comments === 1 ? "1 comment" : `${comments} comments`}>
              <CommentIcon />
              {comments}
            </span>
          ) : null}
          {subtasks && subtasksOpen !== null ? (
            <button
              type="button"
              className={subtasksOpen ? "board-subtasks is-open" : "board-subtasks"}
              aria-expanded={subtasksOpen}
              title={subtasksOpen ? "Hide sub-tasks" : "Show sub-tasks"}
              onClick={(event) => {
                event.stopPropagation();
                onToggleSubtasks();
              }}
            >
              <SubtasksIcon />
              {`${subtasks.done}/${subtasks.total}`}
              <ChevronIcon />
            </button>
          ) : subtasks ? (
            <span title="Sub-tasks done">
              <SubtasksIcon />
              {`${subtasks.done}/${subtasks.total}`}
            </span>
          ) : null}
          {checks ? (
            <span className={checks.done === checks.total ? "is-complete" : undefined} title="Checklist items done">
              <ChecklistIcon />
              {`${checks.done}/${checks.total}`}
            </span>
          ) : null}
          {assignees.length ? (
            <span className="board-card-people">
              {assignees.slice(0, 3).map((person) => <Avatar key={person.id} person={person} size="sm" />)}
            </span>
          ) : markUnassigned ? (
            <span className="board-card-people"><PersonMark person={null} /></span>
          ) : null}
        </span>
      ) : null}
      {refusal ? (
        <span className="board-refusal" role="alert">
          <AlertIcon />
          <span>{refusal}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={(event) => {
              event.stopPropagation();
              onDismiss();
            }}
          >
            ×
          </button>
        </span>
      ) : null}
    </article>
  );
}

// person null marks the unassigned; rule draws a line above the option.
interface QuickOption {
  value: string | null;
  label: string;
  hint?: string | undefined;
  person?: BoardPerson | null | undefined;
  type?: string;
  count?: number;
  rule?: boolean;
}

interface QuickMenuProps {
  label: string;
  value: string | null;
  open: boolean;
  options: QuickOption[];
  // The search field's placeholder. Without it the menu has no search field.
  find?: string;
  onToggle: () => void;
  onPick: (value: string | null, label: string) => void;
}

function QuickMenu({ label, value, open, options, find, onToggle, onPick }: QuickMenuProps) {
  const [text, setText] = useState("");
  const picked = value === null ? undefined : options.find((option) => option.value === value) ?? { value, label: value };
  const needle = text.trim().toLowerCase();
  const listed = needle ? options.filter((option) => `${option.label} ${option.hint ?? ""}`.toLowerCase().includes(needle)) : options;
  const pick = (option: QuickOption) => {
    setText("");
    onPick(option.value, option.label);
  };
  return (
    <span className="ticket-anchor" data-quick-menu>
      <button
        type="button"
        className={picked ? "board-filter is-on" : "board-filter"}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setText("");
          onToggle();
        }}
      >
        {picked && "person" in picked ? <PersonMark person={picked.person} /> : null}
        {picked ? ("person" in picked ? picked.label : `${label}: ${picked.label}`) : label}
        <ChevronIcon />
      </button>
      {open ? (
        <div ref={leaveRef} className="ticket-menu quick-menu" role="menu" aria-label={label}>
          {find ? (
            <label className="quick-menu-find">
              <SearchIcon />
              <input
                value={text}
                placeholder={find}
                aria-label={find}
                autoFocus
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  const first = listed[0];
                  if (event.key === "Enter" && first) pick(first);
                }}
              />
            </label>
          ) : null}
          <div className="quick-menu-list">
            {listed.map((option) => (
              <Fragment key={option.value ?? "any"}>
                {option.rule && !needle ? <hr /> : null}
                <button type="button" role="menuitemradio" aria-checked={option.value === value} onClick={() => pick(option)}>
                  {"person" in option ? <PersonMark person={option.person} /> : null}
                  {option.type ? <TypeIcon type={option.type} /> : null}
                  {option.label}
                  {option.hint ? <span className="quick-menu-hint">{option.hint}</span> : null}
                  {option.count === undefined ? null : <span className="quick-menu-count">{option.count}</span>}
                  {option.value === value ? <span className="ticket-menu-check"><CheckIcon /></span> : null}
                </button>
              </Fragment>
            ))}
            {listed.length ? null : <p className="ticket-menu-note">No one matches</p>}
          </div>
        </div>
      ) : null}
    </span>
  );
}

function PersonMark({ person }: { person: BoardPerson | null | undefined }) {
  if (person === null) return <span className="ticket-avatar is-sm is-unassigned" title="Unassigned" />;
  return person ? <Avatar person={person} size="sm" /> : null;
}

function boardPeople(board: BoardView): BoardPerson[] {
  const found = new Map<string, BoardPerson>();
  for (const task of board.tasks) for (const person of people(task.assignees)) found.set(person.id, person);
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// A ticket's type for the filter: the source's own name, since several of them share one icon type (a Jira Epic is a "task").
function typeKey(task: BoardTask): string {
  return textOf(task.typeName) || textOf(task.type);
}

function boardTypes(board: BoardView): { value: string; icon: string }[] {
  const found = new Map<string, string>();
  for (const task of board.tasks) {
    const type = typeKey(task);
    if (type && !found.has(type)) found.set(type, textOf(task.type));
  }
  return [...found.entries()].map(([value, icon]) => ({ value, icon }));
}

interface MoveFieldsSheetProps {
  board: BoardView;
  asking: Asking;
  onChange: (asking: Asking) => void;
  onCancel: () => void;
  onMove: () => void;
}

function MoveFieldsSheet({ board, asking, onChange, onCancel, onMove }: MoveFieldsSheetProps) {
  const column = columnFor(board.columns, asking.status);
  const ready = asking.fields.every((field) => asking.values[field.id]?.trim());
  const single = asking.fields.length === 1 ? asking.fields[0] : undefined;
  return (
    <div
      className="sheet-scrim"
      onClick={onCancel}
      onKeyDown={(event) => {
        if (event.key === "Escape") onCancel();
      }}
    >
      <form
        className="sheet is-small"
        role="dialog"
        aria-labelledby="board-move-title"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) onMove();
        }}
      >
        <h2 id="board-move-title">{`Move to ${String(column?.title ?? asking.status)}`}</h2>
        <p className="sheet-copy">{`${sourceName(board)} needs ${single ? `a ${single.name.toLowerCase()}` : asking.fields.map((field) => field.name).join(" and ")} for this move.`}</p>
        {asking.fields.map((field, index) => (
          <label key={field.id} className="sheet-field">
            {single ? null : field.name}
            <textarea
              rows={3}
              aria-label={field.name}
              placeholder={single ? `Add a ${field.name.toLowerCase()}…` : undefined}
              value={asking.values[field.id] ?? ""}
              autoFocus={index === 0}
              onChange={(event) => onChange({ ...asking, values: { ...asking.values, [field.id]: event.target.value } })}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
            />
          </label>
        ))}
        <div className="sheet-actions">
          <button type="button" className="text-button" onClick={onCancel}>Cancel</button>
          <button type="submit" className="primary" disabled={!ready}>Move</button>
        </div>
      </form>
    </div>
  );
}

// Per stand-in column, each card's title width in percent.
const SKELETON_COLUMNS = [[88, 64, 92, 56], [76, 90, 60], [84, 70, 94, 66, 52], [72, 58]];

function BoardSkeleton() {
  return (
    <div className="board board-loading" data-testid="board" role="status" aria-label="Loading board">
      <div className="board-toolbar" aria-hidden="true">
        <span className="skeleton-line board-skeleton-field" style={{ width: 220 }} />
        <span className="skeleton-line board-skeleton-field" style={{ width: 64 }} />
      </div>
      <div className="board-columns" aria-hidden="true">
        {SKELETON_COLUMNS.map((cards, column) => (
          <section className="board-column" key={column}>
            <header>
              <span className="skeleton-line" style={{ width: "38%" }} />
            </header>
            <div className="board-cards">
              {cards.map((width, card) => (
                <div className="board-card" key={card}>
                  <span className="skeleton-line" style={{ width: "22%" }} />
                  <span className="skeleton-line" style={{ width: `${width}%` }} />
                  {width > 80 ? <span className="skeleton-line" style={{ width: `${width - 40}%` }} /> : null}
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function ThreadMark({ count }: { count: number }) {
  const label = count === 1 ? "1 chat" : `${count} chats`;
  return (
    <span className="board-link" role="img" aria-label={label} title={label} data-testid="ticket-threads">
      <LinkIcon />
      <span>{count}</span>
    </span>
  );
}

function cardRunning(task: BoardTask, tickets: TicketLinks | null, working: string[] | null) {
  const live = new Set(working || []);
  if (!live.size) return false;
  for (const [sessionId, links] of Object.entries(tickets?.bySession || {})) {
    if (!live.has(sessionId)) continue;
    if ((links || []).some((link) => sameId(link.taskId, task.id))) return true;
  }
  return false;
}

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <circle cx="6" cy="6" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M9.2 9.2 12 12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
