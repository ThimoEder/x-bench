import { z } from "zod";
import { fields, isRecord } from "../../bridge/lenient.ts";
import { loadDurable, saveDurable } from "../jsonFile.ts";
import { canonicalCwd } from "../chat/sessions.ts";
import { ticketId, type TicketId } from "./ticketId.ts";
import { clip } from "./boardText.ts";
import { providerOf, sourceOf, type BoardBinding } from "./sources.ts";
import type { TicketLink, TicketLinks } from "../snapshot.ts";
import { statusKey } from "../../ui/board/ticketStatus.ts";

export { ticketId };

// A chat linked to a ticket.
export interface SessionTicketLink {
  sessionId: string;
  taskId: TicketId;
  projectId: number;
  title: string;
  reference: number | null;
  status: string | null;
  // The ticket moved from Review to Done, and the chat has not answered the offer to archive it yet.
  cleanup?: true;
}

// tickets.json after normalizing. Bindings are keyed by canonical folder.
export interface TicketsState {
  bindings: Record<string, BoardBinding>;
  links: SessionTicketLink[];
}

// Everything below is clipped, coerced or checked with ticketId, so the values stay unknown.
const StoredTickets = fields({
  bindings: z.unknown().optional(),
  links: z.unknown().optional(),
});

const StoredBinding = fields({ provider: z.unknown().optional() });

const StoredLink = fields({
  sessionId: z.unknown().optional(),
  taskId: z.unknown().optional(),
  projectId: z.unknown().optional(),
  title: z.unknown().optional(),
  reference: z.unknown().optional(),
  status: z.unknown().optional(),
  cleanup: z.unknown().optional(),
});

// A ticket, as a board source or the page hands it over.
const TaskInput = fields({
  id: z.unknown().optional(),
  taskId: z.unknown().optional(),
  project_id: z.unknown().optional(),
  projectId: z.unknown().optional(),
  title: z.unknown().optional(),
  reference: z.unknown().optional(),
  linkStatus: z.unknown().optional(),
  attributes: fields({ status: z.unknown().optional() }),
  status: z.unknown().optional(),
});

type TaskInput = z.output<typeof TaskInput>;

export function emptyTickets(): TicketsState {
  return { bindings: {}, links: [] };
}

export function readTickets(file: string): TicketsState {
  return loadDurable(file, parseStoredTickets, emptyTickets());
}

export function writeTickets(state: unknown, file: string): TicketsState {
  saveDurable(file, `${JSON.stringify(normalizeTickets(state), null, 2)}\n`, parseStoredTickets);
  return readTickets(file);
}

// A tickets file is an object. Anything else, including a cut-off file, is unreadable.
function parseStoredTickets(value: unknown): TicketsState | null {
  if (!isRecord(value)) return null;
  try {
    return normalizeTickets(value);
  } catch {
    return null;
  }
}

export function bindingFor(state: unknown, cwd: unknown): BoardBinding | null {
  if (!cwd) return null;
  return normalizeTickets(state).bindings[canonicalCwd(String(cwd))] || null;
}

// The folder whose binding applies to folder: its own, otherwise the one of the checkout home(folder) names.
export function boundFolder(state: unknown, folder: string, home?: (folder: string) => string): string {
  if (bindingFor(state, folder)) return folder;
  const checkout = home?.(folder) || "";
  return checkout && bindingFor(state, checkout) ? checkout : "";
}

export function sameTicket(left: unknown, right: unknown): boolean {
  const a = ticketId(left);
  const b = ticketId(right);
  return a !== null && b !== null && String(a) === String(b);
}

// Binds the folder to a board, given as tickets.json stores it. A malformed one leaves the state as it is.
export function bindBoard(state: unknown, cwd: unknown, input: unknown): TicketsState {
  const key = canonicalCwd(String(cwd || ""));
  const binding = normalizeBinding(input);
  const current = normalizeTickets(state);
  if (!key || !binding) return current;
  return { bindings: { ...current.bindings, [key]: binding }, links: current.links };
}

export function unbindProject(state: unknown, cwd: unknown): TicketsState {
  const key = canonicalCwd(String(cwd || ""));
  const current = normalizeTickets(state);
  if (!current.bindings[key]) return current;
  const bindings = { ...current.bindings };
  delete bindings[key];
  return { bindings, links: current.links };
}

export function linkTicket(state: unknown, { sessionId, task: input }: { sessionId: unknown; task: unknown }): TicketsState {
  const task = TaskInput.parse(input);
  const id = String(sessionId || "");
  const taskId = ticketId(task.id ?? task.taskId);
  const current = normalizeTickets(state);
  if (!id || taskId === null) return current;
  const next: SessionTicketLink = {
    sessionId: id,
    taskId,
    projectId: Number(task.project_id ?? task.projectId) || 0,
    title: clip(task.title, 200),
    reference: referenceOf(task.reference),
    status: taskStatus(task),
  };
  const index = current.links.findIndex((link) => link.sessionId === id && link.taskId === taskId);
  const links = [...current.links];
  if (index >= 0) links[index] = next;
  else links.push(next);
  return { bindings: current.bindings, links };
}

export function dropTaskLinks(state: unknown, taskId: unknown): TicketsState {
  const task = ticketId(taskId);
  const current = normalizeTickets(state);
  if (task === null || !current.links.some((link) => sameTicket(link.taskId, task))) return current;
  return { bindings: current.bindings, links: current.links.filter((link) => !sameTicket(link.taskId, task)) };
}

export function unlinkTicket(state: unknown, sessionId: unknown, taskId: unknown): TicketsState {
  const id = String(sessionId || "");
  const task = ticketId(taskId);
  const current = normalizeTickets(state);
  return {
    bindings: current.bindings,
    links: current.links.filter((link) => !(link.sessionId === id && sameTicket(link.taskId, task))),
  };
}

export function linksForTask(state: unknown, taskId: unknown): SessionTicketLink[] {
  return normalizeTickets(state).links.filter((link) => sameTicket(link.taskId, taskId));
}

export function answerCleanup(state: unknown, sessionId: unknown): TicketsState {
  const id = String(sessionId || "");
  const current = normalizeTickets(state);
  if (!current.links.some((link) => link.sessionId === id && link.cleanup)) return current;
  const links = current.links.map((link) => {
    if (link.sessionId !== id) return link;
    const { cleanup: _answered, ...rest } = link;
    return rest;
  });
  return { bindings: current.bindings, links };
}

export function dropSessionLinks(state: unknown, sessionId: unknown): TicketsState {
  const id = String(sessionId || "");
  const current = normalizeTickets(state);
  if (!id || !current.links.some((link) => link.sessionId === id)) return current;
  return { bindings: current.bindings, links: current.links.filter((link) => link.sessionId !== id) };
}

export function refreshLinkText(state: unknown, tasks: Iterable<unknown> | null | undefined): TicketsState {
  const current = normalizeTickets(state);
  const byId = new Map<string, TaskInput>();
  for (const item of tasks || []) {
    const task = TaskInput.parse(item);
    const id = ticketId(task.id);
    if (id !== null) byId.set(String(id), task);
  }
  let changed = false;
  const links = current.links.map((link) => {
    const task = byId.get(String(link.taskId));
    if (!task) return link;
    const title = clip(task.title, 200);
    const reference = referenceOf(task.reference);
    const status = taskStatus(task);
    if (title === link.title && reference === link.reference && status === link.status) return link;
    changed = true;
    const { cleanup, ...rest } = link;
    const done = statusKey(status) === "done" && (cleanup || statusKey(link.status) === "review");
    return { ...rest, title, reference, status, ...(done ? { cleanup: true as const } : {}) };
  });
  return changed ? { bindings: current.bindings, links } : current;
}

export function presentTickets(state: unknown): TicketLinks {
  const current = normalizeTickets(state);
  const bySession: Record<string, TicketLink[]> = {};
  for (const link of current.links) {
    const row = bySession[link.sessionId] || [];
    row.push({
      taskId: link.taskId,
      projectId: link.projectId,
      title: link.title,
      reference: link.reference,
      status: link.status,
      ...(link.cleanup ? { cleanup: true as const } : {}),
    });
    bySession[link.sessionId] = row;
  }
  return { boards: Object.keys(current.bindings), bySession };
}

function taskStatus(task: TaskInput): string | null {
  const value = task.linkStatus ?? task.attributes.status ?? task.status;
  if (value === null || value === undefined || value === "") return null;
  return clip(value, 40);
}

function referenceOf(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function normalizeBinding(input: unknown): BoardBinding | null {
  return sourceOf(providerOf(StoredBinding.parse(input).provider)).binding(input);
}

// Folders and indexes of a bound object or list. Anything else has no bindings.
function entriesOf(value: unknown): [string, unknown][] {
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value);
}

// Links have to be a list. Any other value is dropped, and the bindings stay.
function linkItems(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizeTickets(raw: unknown): TicketsState {
  const source = StoredTickets.parse(raw);
  const bindings: Record<string, BoardBinding> = {};
  for (const [folder, project] of entriesOf(source.bindings)) {
    const cwd = canonicalCwd(String(folder || ""));
    if (!cwd || bindings[cwd]) continue;
    const binding = normalizeBinding(project);
    if (binding) bindings[cwd] = binding;
  }
  const links: SessionTicketLink[] = [];
  const seen = new Set<string>();
  for (const item of linkItems(source.links)) {
    const link = StoredLink.parse(item);
    const sessionId = String(link.sessionId || "");
    const taskId = ticketId(link.taskId);
    const key = `${sessionId}\0${taskId}`;
    if (!sessionId || taskId === null || seen.has(key)) continue;
    seen.add(key);
    links.push({
      sessionId,
      taskId,
      projectId: Number(link.projectId) || 0,
      title: clip(link.title, 200),
      reference: referenceOf(link.reference),
      status: taskStatus(TaskInput.parse({ attributes: { status: link.status } })),
      ...(link.cleanup === true ? { cleanup: true as const } : {}),
    });
  }
  return { bindings, links };
}
