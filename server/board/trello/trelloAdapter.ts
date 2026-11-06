import {
  boardError,
  mappedThreadTicket,
  type BoardAdapter,
  type BoardCapabilities,
  type BoardServices,
  type BoundBoard,
} from "../boardAdapter.ts";
import { bindBoard, bindingFor, boundFolder, readTickets, writeTickets, type TicketsState } from "../tickets.ts";
import { listColorName, type BoardColumn, type TrelloBinding } from "./trelloSource.ts";
import { isHexId, ticketId } from "../ticketId.ts";
import {
  addTrelloCheckItem,
  addTrelloComment,
  addTrelloFile,
  addTrelloLabel,
  archiveTrelloCard,
  attachTrelloLabel,
  checkTrelloItem,
  colorTrelloList,
  createTrelloCard,
  deleteTrelloComment,
  deleteTrelloFile,
  editTrelloCard,
  editTrelloComment,
  labelColor,
  listTrelloBoards,
  listTrelloComments,
  listTrelloFiles,
  loadTrelloBoard,
  moveTrelloCard,
  presentCard,
  provisionTrelloBoard,
  readTrelloCard,
  readTrelloConnection,
  readTrelloFile,
  removeTrelloLabel,
  resolveColumn,
  saveTrelloConnection,
  trelloChecklists,
  trelloError,
  trelloMemberId,
  trelloStatus,
  type TrelloCard,
  type TrelloConnection,
} from "./trello.ts";

// A card has no note, moves into any open list, and a board load can be skipped when
// the board's last activity has not changed. Lists can be painted.
export const trelloCapabilities: BoardCapabilities = {
  notes: false,
  moves: "free",
  conditionalFetch: true,
  local: false,
  columnColors: true,
  labels: true,
  standaloneLabels: true,
  labelColors: false,
  labelDeletes: false,
  deletes: true,
  types: false,
  assignees: true,
  dueDates: true,
  priority: false,
  subtasks: false,
  checklists: true,
  relations: false,
  commentEdits: true,
  embedsByName: false,
  signedInPages: false,
  archives: true,
  assigneeLabel: "Members",
  badge: "number",
};

interface LocatedCard {
  connection: TrelloConnection;
  card: TrelloCard;
  binding: TrelloBinding;
  folder: string;
}

export function trelloAdapter(services: BoardServices): BoardAdapter {
  const { files, fetchOptions } = services;
  const connection = () => readTrelloConnection(files.connections.trello);
  return {
    provider: "trello",
    label: "Trello",
    capabilities: trelloCapabilities,
    open(folder, binding) {
      return binding.provider === "trello" ? trelloBoard(services, folder, binding) : null;
    },
    claims(taskId) {
      return isHexId(taskId);
    },
    async status() {
      return trelloStatus(connection(), fetchOptions);
    },
    async saveConnection(body) {
      saveTrelloConnection(body, files.connections.trello);
      return trelloStatus(connection(), fetchOptions);
    },
    boardsRoute: "boards",
    async listBoards() {
      return listTrelloBoards(connection(), fetchOptions);
    },
    createBoard: null,
    async bind(folder, choice) {
      const hasId = choice.boardId !== undefined && String(choice.boardId).trim() !== "";
      const hasTitle = Boolean(clean(choice.title, 200));
      if (hasId === hasTitle) throw trelloError(400, "Choose a Trello board or a name");
      const created = await provisionTrelloBoard(connection(), {
        boardId: hasId ? choice.boardId : "",
        title: hasTitle ? clean(choice.title, 200) : "",
      }, fetchOptions);
      writeTickets(bindBoard(readTickets(files.tickets), folder, { provider: "trello", ...created }), files.tickets);
      return { provider: "trello", boardId: created.boardId, title: created.title };
    },
    async moveTicket(taskId, status, cwd, extra) {
      const located = await trelloCard(services, taskId, cwd);
      let columns = located.binding.columns;
      if (!resolveColumn(columns, status)) {
        columns = await columnsFor(services, located.folder, { ...located.binding, columns: [] });
      }
      return moveTrelloCard(located.connection, taskId, status, columns, fetchOptions, extra);
    },
    async moves(taskId) {
      const located = await trelloCard(services, taskId);
      return located.binding.columns
        .filter((column) => column.id !== located.card.idList)
        .map((column) => ({ status: column.id, title: column.title, needs: [] }));
    },
    async editTicket(taskId, edit) {
      const located = await trelloCard(services, taskId);
      return editTrelloCard(located.connection, taskId, edit, located.binding.columns, fetchOptions);
    },
    async changeLabel(taskId, labelId, attach) {
      const located = await trelloCard(services, taskId);
      return attach
        ? attachTrelloLabel(located.connection, taskId, labelId, located.binding.columns, fetchOptions)
        : removeTrelloLabel(located.connection, taskId, labelId, located.binding.columns, fetchOptions);
    },
    async readTicket(taskId) {
      const located = await trelloCard(services, taskId);
      const checklists = await trelloChecklists(located.connection, taskId, fetchOptions);
      return { ...presentCard(located.card, located.binding.columns), checklists };
    },
    async checkItem(taskId, itemId, done) {
      const located = await trelloCard(services, taskId);
      await checkTrelloItem(located.connection, taskId, itemId, done, fetchOptions);
      return this.readTicket(taskId);
    },
    async addCheckItem(taskId, checklistId, title) {
      const located = await trelloCard(services, taskId);
      if (!(await trelloChecklists(located.connection, taskId, fetchOptions)).some((list) => list.id === checklistId)) {
        throw boardError(404, "That checklist is on another card");
      }
      await addTrelloCheckItem(located.connection, checklistId, title, fetchOptions);
      return this.readTicket(taskId);
    },
    async comments(taskId) {
      return listTrelloComments(connection(), taskId, fetchOptions);
    },
    async addComment(taskId, text) {
      const located = await trelloCard(services, taskId);
      return addTrelloComment(located.connection, taskId, text, fetchOptions);
    },
    async editComment(taskId, commentId, text) {
      const located = await trelloCard(services, taskId);
      return editTrelloComment(located.connection, commentId, text, fetchOptions);
    },
    async deleteComment(taskId, commentId) {
      const located = await trelloCard(services, taskId);
      await deleteTrelloComment(located.connection, commentId, fetchOptions);
    },
    async deleteTicket(taskId) {
      const located = await trelloCard(services, taskId);
      await archiveTrelloCard(located.connection, taskId, fetchOptions);
    },
    changeRelation: null,
    files: {
      async list(taskId) {
        return listTrelloFiles(connection(), taskId, fetchOptions);
      },
      async add(taskId, name, file) {
        const located = await trelloCard(services, taskId);
        return addTrelloFile(located.connection, taskId, name, file, fetchOptions);
      },
      async read(taskId, fileId, range) {
        return readTrelloFile(connection(), taskId, fileId, range, fetchOptions);
      },
      async remove(taskId, fileId) {
        const located = await trelloCard(services, taskId);
        await deleteTrelloFile(located.connection, taskId, fileId, fetchOptions);
      },
    },
    threadTicket: mappedThreadTicket,
  };
}

function trelloBoard(services: BoardServices, folder: string, binding: TrelloBinding): BoundBoard {
  const { files, fetchOptions } = services;
  const connection = () => readTrelloConnection(files.connections.trello);
  return {
    folder,
    async load({ search, activity }) {
      const loaded = await loadTrelloBoard(connection(), binding.boardId, { ...(fetchOptions || {}), search, activity });
      if (!loaded.columns) return { view: loaded.payload, rebind: null };
      const remembered = new Map(binding.columns.map((column) => [column.id, column.color || ""]));
      const columns = loaded.columns.map((column) => (
        column.color || !remembered.get(column.id) ? column : { ...column, color: remembered.get(column.id) }
      ));
      loaded.payload.columns = columns.map((column) => (
        column.color
          ? { value: column.id, title: column.title, colorName: column.color, color: labelColor(column.color) }
          : { value: column.id, title: column.title }
      ));
      const title = loaded.payload.project.title || binding.title;
      return {
        view: { ...loaded.payload, me: (await trelloMemberId(connection(), fetchOptions)) || null },
        rebind: (state) => bindBoard(state, folder, { ...binding, title, columns }),
      };
    },
    async createTicket(draft) {
      const columns = await columnsFor(services, folder, binding);
      return createTrelloCard(connection(), columns, draft, fetchOptions);
    },
    async addLabel(title, rawTaskId) {
      const taskId = ticketId(rawTaskId);
      if (rawTaskId !== undefined && rawTaskId !== "" && taskId === null) {
        throw boardError(400, "Choose a ticket");
      }
      return addTrelloLabel(connection(), binding.boardId, taskId, title, binding.columns, fetchOptions);
    },
    async ticketOnBoard(taskId) {
      const card = await readTrelloCard(connection(), taskId, fetchOptions);
      if (card.idBoard !== binding.boardId) throw boardError(404, "That ticket is on another board");
      return presentCard(card, binding.columns);
    },
    deleteLabel: null,
    async paintColumn(rawListId, color) {
      const listId = ticketId(rawListId);
      if (!isHexId(listId)) throw trelloError(400, "Choose a column");
      const current = binding.columns.find((column) => column.id === listId);
      if (!current) throw trelloError(404, "Choose a column");
      const clearing = color === null || color === "";
      const name = clearing ? null : listColorName(color);
      if (!clearing && !name) throw trelloError(400, "Choose a color");
      await colorTrelloList(connection(), listId, name, fetchOptions);
      writeTickets(paintStored(readTickets(files.tickets), folder, listId, name), files.tickets);
      return {
        column: name
          ? { value: listId, title: current.title, colorName: name, color: labelColor(name) }
          : { value: listId, title: current.title },
      };
    },
    signedInPage: null,
  };
}

function paintStored(state: TicketsState, folder: string, listId: string, name: string | null): TicketsState {
  const stored = bindingFor(state, folder);
  if (stored?.provider !== "trello") return state;
  const columns = stored.columns.map((column) => {
    if (column.id !== listId) return column;
    return name ? { ...column, color: name } : { id: column.id, title: column.title };
  });
  return bindBoard(state, folder, { ...stored, columns });
}

// The binding's lists, loaded and saved once when the binding has none yet.
async function columnsFor(services: BoardServices, folder: string, binding: TrelloBinding): Promise<BoardColumn[]> {
  const { files, fetchOptions } = services;
  if (binding.columns.length) return binding.columns;
  const loaded = await loadTrelloBoard(readTrelloConnection(files.connections.trello), binding.boardId, fetchOptions);
  if (loaded.columns?.length) {
    writeTickets(bindBoard(readTickets(files.tickets), folder, {
      ...binding,
      title: loaded.payload.project.title || binding.title,
      columns: loaded.columns,
    }), files.tickets);
  }
  return loaded.columns || [];
}

// The card and the bound folder whose board holds it: the folder the request named, or else
// any folder bound to the card's board.
async function trelloCard(services: BoardServices, taskId: unknown, cwd?: unknown): Promise<LocatedCard> {
  const { files, fetchOptions } = services;
  const connection = readTrelloConnection(files.connections.trello);
  const card = await readTrelloCard(connection, taskId, fetchOptions);
  const state = readTickets(files.tickets);
  if (cwd) {
    const folder = services.folderOf(cwd);
    const bound = boundFolder(state, folder, services.projectHome);
    const binding = bindingFor(state, bound);
    if (!binding || binding.provider !== "trello") throw boardError(404, "This folder has no board");
    if (card.idBoard !== binding.boardId) throw boardError(404, "That ticket is on another board");
    return { connection, card, binding, folder: bound };
  }
  for (const [folder, binding] of Object.entries(state.bindings)) {
    if (binding.provider === "trello" && binding.boardId === card.idBoard) return { connection, card, binding, folder };
  }
  throw boardError(404, "That ticket is on another board");
}

function clean(value: unknown, max: number): string {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, max);
}
