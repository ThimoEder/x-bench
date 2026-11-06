import { z } from "zod";
import { fields, isRecord, maybe } from "../../../bridge/lenient.ts";
import {
  fileBytes,
  FILE_TIMEOUT_MS,
  neighbors,
  noChecklists,
  threadText,
  type BoardAdapter,
  type BoardCapabilities,
  type BoardColumnView,
  type BoardComment,
  type BoardFetch,
  type BoardServices,
  type BoundBoard,
  type MoveExtra,
} from "../boardAdapter.ts";
import {
  enabledConnection,
  listAllTasks,
  loopbackBase,
  readConnection,
  sakCall,
  sakError,
  sakRequest,
  sakStatus,
  saveConnection,
  spreadItems,
  type SakRequest,
} from "./sakClient.ts";
import { bindBoard, readTickets, writeTickets } from "../tickets.ts";
import type { SakBinding } from "./sakSource.ts";
import { ticketId, type TicketId } from "../ticketId.ts";

// SAK's bodies. Projects, tasks and labels go on to the page as SAK sent them; only these fields are read here.
const SakProject = fields({
  id: z.unknown().optional(),
  title: z.unknown().optional(),
});

const SakTask = fields({
  id: z.unknown().optional(),
  project_id: z.unknown().optional(),
  title: z.unknown().optional(),
  description: z.unknown().optional(),
  note: z.unknown().optional(),
  attributes: fields({ status: z.unknown().optional(), rank: z.unknown().optional() }),
  relations: maybe(z.array(z.unknown())),
});

const SakRelation = fields({
  task_id: z.unknown().optional(),
  kind: z.unknown().optional(),
});

const SakComment = fields({
  id: z.unknown().optional(),
  body: z.unknown().optional(),
  created_at: z.unknown().optional(),
});

const SakFile = fields({ id: z.unknown().optional() });

const SakLabel = fields({
  id: z.unknown().optional(),
  title: z.unknown().optional(),
});

const StatusOption = fields({
  value: z.unknown().optional(),
  position: z.unknown().optional(),
});

const AttributeDef = fields({
  name: z.unknown().optional(),
  type: z.unknown().optional(),
  options: z.unknown().optional(),
});

const AttributeDefs = maybe(z.array(AttributeDef));

export interface SakBoardView {
  provider: "sak";
  project: unknown;
  url: string | null;
  columns: BoardColumnView[];
  labels: unknown[];
  tasks: unknown[];
  truncated: boolean;
}

// A SAK task has a note, moves into any status, and has no activity stamp to load against.
export const sakCapabilities: BoardCapabilities = {
  notes: true,
  moves: "free",
  conditionalFetch: false,
  local: true,
  columnColors: false,
  labels: true,
  standaloneLabels: true,
  labelColors: true,
  labelDeletes: true,
  deletes: true,
  types: false,
  assignees: false,
  dueDates: false,
  priority: false,
  subtasks: true,
  checklists: false,
  relations: true,
  commentEdits: false,
  embedsByName: false,
  signedInPages: true,
  archives: false,
  assigneeLabel: "Assignee",
  badge: "number",
};

// The number attribute that keeps a card's place in its column. It is defined on the project
// the first time a drop asks for a place.
const RANK = "rank";
const RANK_STEP = 1024;

export function statusColumns(defs: unknown): BoardColumnView[] {
  const status = (AttributeDefs.parse(defs) || []).find((def) => def.name === "status" && def.type === "enum");
  const options = spreadItems(status?.options)
    .map((option) => StatusOption.parse(option))
    .sort((a, b) => Number(a.position || 0) - Number(b.position || 0));
  return [
    ...options.map((option) => ({ value: option.value, title: option.value === "" ? "(empty)" : option.value })),
    { value: null, title: "unset" },
  ];
}

export function sakAdapter(services: BoardServices): BoardAdapter {
  const { files, fetchOptions } = services;
  const request = sakRequest(files.connections.sak, fetchOptions);
  return {
    provider: "sak",
    label: "SAK",
    capabilities: sakCapabilities,
    open(folder, binding) {
      return binding.provider === "sak" ? sakBoard(request, services, folder, binding) : null;
    },
    claims(taskId) {
      return typeof taskId === "number";
    },
    async status() {
      return sakStatus(readConnection(files.connections.sak), fetchOptions);
    },
    async saveConnection(body) {
      const current = readConnection(files.connections.sak);
      const baseUrl = body.baseUrl ? loopbackBase(body.baseUrl) : current.baseUrl;
      if (baseUrl && body.enabled !== false && !body.token?.trim() && !current.token) await services.setUpSak?.(baseUrl);
      saveConnection(body, files.connections.sak);
      // Before the status, so turning SAK on answers with the server it started.
      await services.syncSak?.();
      return sakStatus(readConnection(files.connections.sak), fetchOptions);
    },
    boardsRoute: "projects",
    async listBoards() {
      return request("GET", "/api/projects");
    },
    async createBoard(title, description) {
      const name = clean(title, 200);
      if (!name) throw sakError(400, "Name the SAK project");
      return request("POST", "/api/projects", description === undefined ? { title: name } : { title: name, description });
    },
    async bind(folder, choice) {
      const hasId = choice.projectId !== undefined && choice.projectId !== "";
      const hasTitle = Boolean(clean(choice.title, 200));
      if (hasId === hasTitle) throw sakError(400, "Choose a SAK project or a name");
      let project;
      if (hasId) {
        const projectId = Number(choice.projectId);
        if (!Number.isInteger(projectId) || projectId <= 0) throw sakError(400, "Choose a SAK project");
        project = await request("GET", `/api/projects/${projectId}`);
      } else {
        project = await request("POST", "/api/projects", { title: clean(choice.title, 200) });
      }
      const read = SakProject.parse(project);
      if (!read.id) throw sakError(502, "SAK did not return a project");
      writeTickets(bindBoard(readTickets(files.tickets), folder, projectBinding(project)), files.tickets);
      return { projectId: Number(read.id), title: read.title || "" };
    },
    async moveTicket(taskId, status, _cwd, extra) {
      let moved;
      if (status === null) {
        const current = await request("GET", `/api/tasks/${taskId}`);
        const unset = (SakTask.parse(current).attributes.status ?? null) === null;
        moved = unset ? current : await request("DELETE", `/api/tasks/${taskId}/attributes/status`);
      } else {
        const value = clean(status, 200);
        if (!value) throw sakError(400, "Choose a column");
        moved = await request("PUT", `/api/tasks/${taskId}/attributes/status`, { value });
      }
      try {
        return (await placeTask(request, moved, taskId, extra)) ?? moved;
      } catch {
        // The ticket moved; only its place in the column did not stick.
        return moved;
      }
    },
    async moves(taskId) {
      const task = SakTask.parse(await request("GET", `/api/tasks/${taskId}`));
      const columns = statusColumns(await request("GET", `/api/projects/${Number(task.project_id)}/attributes`));
      const current = task.attributes.status ?? null;
      return columns.filter((column) => column.value !== current).map((column) => ({ status: column.value, title: String(column.title), needs: [] }));
    },
    async editTicket(taskId, edit) {
      if (!Number.isInteger(Number(edit.revision))) throw sakError(400, "Reload this ticket");
      const patch: { title?: string; description?: string | null; note?: string | null } = {};
      if (edit.title !== undefined) {
        const title = clean(edit.title, 200);
        if (!title) throw sakError(400, "Name the ticket");
        patch.title = title;
      }
      if (edit.description !== undefined) {
        const text = (edit.description ?? "").trim();
        patch.description = text ? text.slice(0, 8000) : null;
      }
      if (edit.note !== undefined) {
        const text = (edit.note ?? "").trim();
        patch.note = text ? text.slice(0, 8000) : null;
      }
      return request("PATCH", `/api/tasks/${taskId}`, patch, { match: edit.revision });
    },
    async changeLabel(taskId, labelId, attach) {
      await request(attach ? "PUT" : "DELETE", `/api/tasks/${taskId}/labels/${labelId}`);
      return request("GET", `/api/tasks/${taskId}`);
    },
    async readTicket(taskId) {
      const task = await request("GET", `/api/tasks/${taskId}`);
      const home = await siteHome(files.connections.sak, fetchOptions?.fetchImpl);
      return { ...recordOf(task), ...(await relatedTasks(request, task)), url: home ? `${home}/tasks/${taskId}` : null };
    },
    async comments(taskId) {
      return listItems(await request("GET", `/api/tasks/${taskId}/comments`)).map(sakComment);
    },
    async addComment(taskId, text) {
      return sakComment(await request("POST", `/api/tasks/${taskId}/comments`, { body: text }));
    },
    async editComment() {
      throw sakError(400, "SAK keeps comments as they were written");
    },
    async deleteComment() {
      throw sakError(400, "SAK keeps comments as they were written");
    },
    checkItem: noChecklists,
    addCheckItem: noChecklists,
    async deleteTicket(taskId) {
      await request("DELETE", `/api/tasks/${taskId}`);
    },
    async changeRelation(taskId, otherId, kind, attach) {
      try {
        if (attach) await request("PUT", `/api/tasks/${taskId}/relations`, { other_task_id: otherId, kind });
        else await request("DELETE", `/api/tasks/${taskId}/relations/${otherId}/${kind}`);
      } catch (error) {
        if (isRecord(error) && error.status === 404) throw sakError(404, attach ? "There is no such ticket" : "These tickets have no such relation", error.code);
        throw error;
      }
    },
    files: {
      async list(taskId) {
        return listItems(await request("GET", `/api/tasks/${taskId}/files`));
      },
      async add(taskId, name, file) {
        return request("POST", `/api/tasks/${taskId}/files?${new URLSearchParams({ name })}`, file, { timeoutMs: FILE_TIMEOUT_MS });
      },
      async read(_taskId, fileId, range) {
        const options = { ...fetchOptions, timeoutMs: FILE_TIMEOUT_MS, range };
        return sakCall(enabledConnection(files.connections.sak), "GET", `/api/files/${fileId}`, undefined, options, fileBytes);
      },
      async remove(taskId, fileId) {
        const owned = listItems(await request("GET", `/api/tasks/${taskId}/files`)).some((file) => String(SakFile.parse(file).id) === fileId);
        if (!owned) throw sakError(404, "This ticket has no such file");
        await request("DELETE", `/api/files/${fileId}`);
      },
    },
    threadTicket(task) {
      const read = SakTask.parse(task);
      return {
        id: ticketId(read.id),
        title: read.title || "",
        status: read.attributes.status ?? null,
        description: threadText(read.description),
        note: threadText(read.note),
      };
    },
  };
}

function projectBinding(project: unknown) {
  const read = SakProject.parse(project);
  return { provider: "sak", projectId: read.id, title: read.title };
}

function sakBoard(request: SakRequest, services: BoardServices, folder: string, binding: SakBinding): BoundBoard {
  const { files } = services;
  return {
    folder,
    async load({ search }) {
      const project = await request("GET", `/api/projects/${binding.projectId}`);
      const defs = await request("GET", `/api/projects/${binding.projectId}/attributes`);
      const labels = await request("GET", `/api/projects/${binding.projectId}/labels`);
      const query = clean(search, 200);
      const page = await listAllTasks(request, binding.projectId, query);
      // A search can leave a parent's sub-tasks out, and they still count.
      const everyone = query ? (await listAllTasks(request, binding.projectId, "")).items : page.items;
      const home = await siteHome(files.connections.sak, services.fetchOptions?.fetchImpl);
      const view: SakBoardView = {
        provider: "sak",
        project,
        url: home ? `${home}/projects/${SakProject.parse(project).id}?mode=board` : null,
        columns: statusColumns(defs),
        labels: listItems(labels),
        tasks: boardTasks(page.items, everyone, home),
        truncated: page.truncated,
      };
      return { view, rebind: (state) => bindBoard(state, folder, projectBinding(project)) };
    },
    async createTicket(draft) {
      const title = clean(draft.title, 200);
      if (!title) throw sakError(400, "Name the ticket");
      const payload = draft.description === undefined ? { title } : { title, description: draft.description };
      const created = SakTask.parse(await request("POST", `/api/projects/${binding.projectId}/tasks`, payload));
      return request("PUT", `/api/tasks/${created.id}/attributes/status`, { value: "open" });
    },
    async addLabel(title, rawTaskId, color) {
      const existing = await request("GET", `/api/projects/${binding.projectId}/labels`);
      let label = listItems(existing).find((item) => SakLabel.parse(item).title === title);
      if (!label) label = await request("POST", `/api/projects/${binding.projectId}/labels`, color ? { title, color } : { title });
      let task = null;
      const taskId = ticketId(rawTaskId);
      if (rawTaskId !== undefined && rawTaskId !== "") {
        if (taskId === null) throw sakError(400, "Choose a ticket");
        await request("PUT", `/api/tasks/${taskId}/labels/${SakLabel.parse(label).id}`);
        task = await request("GET", `/api/tasks/${taskId}`);
      }
      return { label, task };
    },
    // SAK's label ids are global, so the label is looked up among this project's first.
    async deleteLabel(labelId) {
      const existing = await request("GET", `/api/projects/${binding.projectId}/labels`);
      if (!listItems(existing).some((item) => SakLabel.parse(item).id === labelId)) throw sakError(404, "That label is on another board");
      await request("DELETE", `/api/labels/${labelId}`);
    },
    async ticketOnBoard(taskId) {
      const task = await request("GET", `/api/tasks/${taskId}`);
      if (Number(SakTask.parse(task).project_id) !== binding.projectId) throw sakError(404, "That ticket is on another board");
      return task;
    },
    paintColumn: null,
    // SAK's page reads its token from local storage as it starts.
    signedInPage(taskId) {
      const { baseUrl, token } = readConnection(files.connections.sak);
      const page = typeof taskId === "number" ? `/tasks/${taskId}` : `/projects/${binding.projectId}?mode=board`;
      return { url: `${baseUrl}${page}`, storage: { from: `${baseUrl}/api/health`, items: { "sak.token": token } } };
    },
  };
}

// The board's tasks in their column order: ranked ones by rank, then the rest by id, which is
// how SAK listed them. Each carries its link (null without SAK's website), its parent's id, and for a parent how many of its
// sub-tasks are done, counted over everyone (the whole project, whatever the search).
function boardTasks(items: unknown[], everyone: unknown[], home: string | null): unknown[] {
  const tasks = items.map((item, index) => {
    const task = SakTask.parse(item);
    return { item, index, task, rank: rankOf(task.attributes.rank) };
  });
  const statusOf = new Map(everyone.map((item) => {
    const task = SakTask.parse(item);
    return [String(task.id), task.attributes.status];
  }));
  return tasks
    .sort((a, b) => {
      if (a.rank !== null && b.rank !== null) return a.rank - b.rank || a.index - b.index;
      if (a.rank !== null) return -1;
      if (b.rank !== null) return 1;
      return a.index - b.index;
    })
    .map(({ item, task }) => {
      const relations = (task.relations ?? []).map((relation) => SakRelation.parse(relation));
      const subtasks = relations.filter((relation) => relation.kind === "subtask");
      const done = subtasks.filter((relation) => statusOf.get(String(relation.task_id)) === "done").length;
      // "parent" is how SAK spells this task's own parent.
      const parent = ticketId(relations.find((relation) => relation.kind === "parent")?.task_id);
      return {
        ...recordOf(item),
        url: home ? `${home}/tasks/${String(task.id)}` : null,
        subtaskCount: subtasks.length ? { done, total: subtasks.length } : null,
        parentId: parent,
      };
    });
}

// The ticket's sub-tasks and the tickets it relates to. One that can't be read is left out.
async function relatedTasks(request: SakRequest, task: unknown): Promise<{ subtasks: unknown[]; related: unknown[] }> {
  const relations = (SakTask.parse(task).relations ?? []).map((relation) => SakRelation.parse(relation)).slice(0, 50);
  const reads = await Promise.all(relations.map(async (relation) => {
    const other = ticketId(relation.task_id);
    if (typeof other !== "number") return null;
    try {
      return { relation, other, read: SakTask.parse(await request("GET", `/api/tasks/${other}`)) };
    } catch {
      return null;
    }
  }));
  const subtasks: unknown[] = [];
  const related: unknown[] = [];
  for (const found of reads) {
    if (!found) continue;
    const { relation, other, read } = found;
    const status = read.attributes.status ?? null;
    const entry = { id: other, title: clean(read.title, 200), status, done: status === "done" };
    if (relation.kind === "subtask") {
      subtasks.push(entry);
      continue;
    }
    // "parent" is how SAK spells this task's own parent.
    const kind = relation.kind === "parent" ? "subtask of" : clean(relation.kind, 40).replace(/_/g, " ");
    related.push({ ...entry, kind });
  }
  return { subtasks, related };
}

// Writes the moved task's rank so it sits between the tasks the order puts above and below it.
// When a neighbor has no rank yet, or the two are too close, the whole column is numbered again.
async function placeTask(request: SakRequest, moved: unknown, taskId: TicketId, extra: MoveExtra | undefined): Promise<unknown> {
  const near = neighbors(extra?.order, taskId);
  if (!near || !extra?.order) return null;
  await ensureRank(request, Number(SakTask.parse(moved).project_id));
  const rankFor = async (id: TicketId | null) => {
    if (id === null) return null;
    return rankOf(SakTask.parse(await request("GET", `/api/tasks/${Number(id)}`)).attributes.rank);
  };
  const above = await rankFor(near.above);
  const below = await rankFor(near.below);
  const unranked = (near.above !== null && above === null) || (near.below !== null && below === null);
  const tight = above !== null && below !== null && below - above < 0.001;
  if (unranked || tight) {
    let last = moved;
    for (const [index, id] of extra.order.entries()) {
      if (typeof id !== "number") continue;
      const written = await request("PUT", `/api/tasks/${id}/attributes/${RANK}`, { value: String((index + 1) * RANK_STEP) });
      if (id === taskId) last = written;
    }
    return last;
  }
  return request("PUT", `/api/tasks/${taskId}/attributes/${RANK}`, { value: rankText(between(above, below)) });
}

// A rank strictly between two neighbors. A missing neighbor leaves one step on that side.
function between(above: number | null, below: number | null): number {
  if (above === null && below === null) return RANK_STEP;
  if (above === null) return (below ?? 0) - RANK_STEP;
  if (below === null) return above + RANK_STEP;
  return (above + below) / 2;
}

async function ensureRank(request: SakRequest, projectId: number): Promise<void> {
  const defs = AttributeDefs.parse(await request("GET", `/api/projects/${projectId}/attributes`)) || [];
  const rank = defs.find((def) => def.name === RANK);
  if (rank && rank.type === "number") return;
  if (rank) throw sakError(409, `This SAK project has a "${RANK}" attribute that is not a number`);
  await request("POST", `/api/projects/${projectId}/attributes`, { name: RANK, type: "number" });
}

function rankOf(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const rank = Number(value);
  return Number.isFinite(rank) ? rank : null;
}

// SAK takes digits with at most one point; a number like 1e-7 would be refused.
function rankText(rank: number): string {
  const fixed = rank.toFixed(6).replace(/\.?0+$/, "");
  return fixed === "-0" ? "0" : fixed;
}

function sakComment(value: unknown): BoardComment {
  const comment = SakComment.parse(value);
  return {
    id: comment.id,
    body: typeof comment.body === "string" ? comment.body : String(comment.body ?? ""),
    author: null,
    created: typeof comment.created_at === "string" ? comment.created_at : null,
    mine: false,
  };
}

// SAK's address for its pages, or null when it runs without its website and answers them with a 404.
async function siteHome(connectionFile: string, fetchImpl: BoardFetch = fetch): Promise<string | null> {
  const home = readConnection(connectionFile).baseUrl;
  try {
    return (await fetchImpl(`${home}/`, { method: "HEAD", signal: AbortSignal.timeout(1000) })).status === 404 ? null : home;
  } catch {
    return home;
  }
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? { ...value } : {};
}

// A list as SAK sent it. Anything else reads as empty.
function listItems(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function clean(value: unknown, max: number): string {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, max);
}
