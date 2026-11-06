import { isRecord } from "../../../bridge/lenient.ts";
import {
  boardError,
  mappedThreadTicket,
  noChecklists,
  type BoardAdapter,
  type BoardCapabilities,
  type BoardServices,
  type BoundBoard,
} from "../boardAdapter.ts";
import { bindBoard, bindingFor, boundFolder, readTickets, writeTickets } from "../tickets.ts";
import type { JiraBinding } from "./jiraSource.ts";
import { isIssueKey, ticketId, type TicketId } from "../ticketId.ts";
import {
  addJiraComment,
  addJiraFile,
  changeJiraLabel,
  createJiraIssue,
  deleteJiraComment,
  deleteJiraFile,
  deleteJiraIssue,
  editJiraComment,
  editJiraIssue,
  jiraAccountId,
  jiraColumns,
  jiraError,
  jiraIssueOnBoard,
  jiraLabel,
  jiraMoves,
  jiraStatus,
  listJiraBoards,
  listJiraComments,
  listJiraFiles,
  loadJiraBoard,
  moveJiraIssue,
  presentIssue,
  readJiraBoard,
  readJiraConnection,
  readJiraFile,
  readJiraIssue,
  saveJiraConnection,
  type JiraBoardInfo,
  type JiraConnection,
} from "./jira.ts";

// An issue has no note, a move is a workflow transition, and a board load is skipped while the
// board's newest change stays the same. Column colors stay in Jira.
export const jiraCapabilities: BoardCapabilities = {
  notes: false,
  moves: "transitions",
  conditionalFetch: true,
  local: false,
  columnColors: false,
  labels: true,
  standaloneLabels: false,
  labelColors: false,
  labelDeletes: false,
  deletes: true,
  types: true,
  assignees: true,
  dueDates: true,
  priority: true,
  subtasks: true,
  checklists: false,
  relations: false,
  commentEdits: true,
  embedsByName: true,
  signedInPages: false,
  archives: false,
  assigneeLabel: "Assignee",
  badge: "key",
};

interface LocatedIssue {
  connection: JiraConnection;
  binding: JiraBinding;
}

export function jiraAdapter(services: BoardServices): BoardAdapter {
  const { files, fetchOptions } = services;
  const connection = () => readJiraConnection(files.connections.jira);
  const columnsOf = (located: LocatedIssue) => jiraColumns(located.connection, located.binding.boardId, fetchOptions);
  return {
    provider: "jira",
    label: "Jira",
    capabilities: jiraCapabilities,
    open(folder, binding) {
      return binding.provider === "jira" ? jiraBoard(services, folder, binding) : null;
    },
    claims(taskId) {
      return isIssueKey(taskId);
    },
    async status() {
      return jiraStatus(connection(), fetchOptions);
    },
    async saveConnection(body) {
      saveJiraConnection(body, files.connections.jira);
      return jiraStatus(connection(), fetchOptions);
    },
    boardsRoute: "boards",
    async listBoards() {
      return listJiraBoards(connection(), fetchOptions);
    },
    createBoard: null,
    async bind(folder, choice) {
      if (choice.boardId === undefined || choice.boardId === "") {
        throw jiraError(400, "Choose a Jira board. New boards are made in Jira.");
      }
      const info = await readJiraBoard(connection(), choice.boardId, fetchOptions);
      writeTickets(bindBoard(readTickets(files.tickets), folder, bindingInput(info)), files.tickets);
      return { provider: "jira", boardId: info.boardId, title: info.title };
    },
    async moveTicket(taskId, status, cwd, extra) {
      const located = await locate(services, taskId, cwd);
      return moveJiraIssue(located.connection, taskId, status, await columnsOf(located), fetchOptions, extra);
    },
    async moves(taskId) {
      const located = await locate(services, taskId);
      return jiraMoves(located.connection, taskId, await columnsOf(located), fetchOptions);
    },
    async editTicket(taskId, edit) {
      const located = await locate(services, taskId);
      return editJiraIssue(located.connection, taskId, edit, await columnsOf(located), fetchOptions);
    },
    async changeLabel(taskId, label, attach) {
      const located = await locate(services, taskId);
      return changeJiraLabel(located.connection, taskId, label, attach, await columnsOf(located), fetchOptions);
    },
    async readTicket(taskId) {
      const located = await locate(services, taskId);
      const [issue, columns] = await Promise.all([readJiraIssue(located.connection, taskId, fetchOptions), columnsOf(located)]);
      return presentIssue(issue, columns, located.connection.site);
    },
    async comments(taskId) {
      return listJiraComments(connection(), taskId, fetchOptions);
    },
    async addComment(taskId, text) {
      const located = await locate(services, taskId);
      return addJiraComment(located.connection, taskId, text, fetchOptions);
    },
    async editComment(taskId, commentId, text) {
      const located = await locate(services, taskId);
      return editJiraComment(located.connection, taskId, commentId, text, fetchOptions);
    },
    async deleteComment(taskId, commentId) {
      const located = await locate(services, taskId);
      await deleteJiraComment(located.connection, taskId, commentId, fetchOptions);
    },
    async deleteTicket(taskId) {
      const located = await locate(services, taskId);
      await deleteJiraIssue(located.connection, taskId, fetchOptions);
    },
    checkItem: noChecklists,
    addCheckItem: noChecklists,
    changeRelation: null,
    files: {
      async list(taskId) {
        return listJiraFiles(connection(), taskId, fetchOptions);
      },
      async add(taskId, name, file) {
        const located = await locate(services, taskId);
        return addJiraFile(located.connection, taskId, name, file, fetchOptions);
      },
      async read(_taskId, fileId, range) {
        return readJiraFile(connection(), fileId, range, fetchOptions);
      },
      async remove(taskId, fileId) {
        const located = await locate(services, taskId);
        await deleteJiraFile(located.connection, taskId, fileId, fetchOptions);
      },
    },
    threadTicket: mappedThreadTicket,
  };
}

function jiraBoard(services: BoardServices, folder: string, binding: JiraBinding): BoundBoard {
  const { files, fetchOptions } = services;
  const connection = () => readJiraConnection(files.connections.jira);
  return {
    folder,
    async load({ search, activity }) {
      const loaded = await loadJiraBoard(connection(), binding.boardId, { ...(fetchOptions || {}), search, activity });
      if (!loaded.info) return { view: loaded.payload, rebind: null };
      const info = loaded.info;
      return {
        view: { ...loaded.payload, me: (await jiraAccountId(connection(), fetchOptions)) || null },
        rebind: (state) => bindBoard(state, folder, bindingInput(info)),
      };
    },
    async createTicket(draft) {
      const columns = await jiraColumns(connection(), binding.boardId, fetchOptions);
      return createJiraIssue(connection(), binding.projectKey, columns, draft, fetchOptions);
    },
    async addLabel(title, rawTaskId) {
      const label = { id: jiraLabel(title), title: jiraLabel(title), color: null };
      if (rawTaskId === undefined || rawTaskId === "") return { label, task: null };
      const taskId = ticketId(rawTaskId);
      if (!isIssueKey(taskId)) throw boardError(400, "Choose a ticket");
      const columns = await jiraColumns(connection(), binding.boardId, fetchOptions);
      return { label, task: await changeJiraLabel(connection(), taskId, label.title, true, columns, fetchOptions) };
    },
    async ticketOnBoard(taskId) {
      const issue = await jiraIssueOnBoard(connection(), binding.boardId, taskId, fetchOptions);
      return presentIssue(issue, await jiraColumns(connection(), binding.boardId, fetchOptions), connection().site);
    },
    deleteLabel: null,
    paintColumn: null,
    signedInPage: null,
  };
}

function bindingInput(info: JiraBoardInfo) {
  return {
    provider: "jira",
    boardId: info.boardId,
    title: info.title,
    projectKey: info.projectKey,
    columns: info.columns.map((column) => column.title),
  };
}

// The Jira binding whose board holds the issue: the folder the request named, or else the first bound
// board that holds it, trying boards on the issue's project first.
async function locate(services: BoardServices, taskId: TicketId, cwd?: unknown): Promise<LocatedIssue> {
  const { files, fetchOptions } = services;
  const connection = readJiraConnection(files.connections.jira);
  const state = readTickets(files.tickets);
  let candidates: JiraBinding[];
  if (cwd) {
    const binding = bindingFor(state, boundFolder(state, services.folderOf(cwd), services.projectHome));
    if (!binding || binding.provider !== "jira") throw boardError(404, "This folder has no board");
    candidates = [binding];
  } else {
    const project = String(taskId).split("-")[0];
    candidates = Object.values(state.bindings)
      .filter((binding): binding is JiraBinding => binding.provider === "jira")
      .sort((a, b) => Number(b.projectKey === project) - Number(a.projectKey === project));
  }
  for (const binding of candidates) {
    try {
      await jiraIssueOnBoard(connection, binding.boardId, taskId, fetchOptions);
      return { connection, binding };
    } catch (error) {
      if (!(isRecord(error) && error.status === 404)) throw error;
    }
  }
  throw boardError(404, "That ticket is on another board");
}
