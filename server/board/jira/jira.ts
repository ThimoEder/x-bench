import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { fields, isRecord, maybe } from "../../../bridge/lenient.ts";
import { openSecret, sealSecret } from "../../secrets/secrets.ts";
import { isIssueKey, ticketId } from "../ticketId.ts";
import {
  fileBytes,
  FILE_TIMEOUT_MS,
  needsFields,
  neighbors,
  person,
  responseJson,
  type BoardCallOptions,
  type BoardComment,
  type BoardFetchResponse,
  type BoardMove,
  type BoardPerson,
  type ConnectionRequest,
  type FileBytes,
  type MoveExtra,
  type MoveField,
  type TicketEdit,
} from "../boardAdapter.ts";
import { stripHidden } from "../boardText.ts";


// Done tickets drop off the board two weeks after their last change.
const BOARD_SCOPE = "(statusCategory != Done OR updated >= -14d)";
const ISSUE_FIELDS = "summary,description,status,labels,updated,created,project,issuetype,assignee,priority,duedate,subtasks,issuelinks,parent,comment";
const PAGE = 100;
const MOST_ITEMS = 1000;

// The site, email and API token in ~/.x-bench/jira.json.
export interface JiraConnection {
  site: string;
  email: string;
  token: string;
  enabled: boolean;
}

// What the page learns about the connection. It never holds the token.
export interface JiraStatus {
  configured: boolean;
  enabled: boolean;
  reachable: boolean;
  name: unknown;
  site: string;
  email: string;
}

export type JiraCallOptions = BoardCallOptions;

export interface JiraLoadOptions extends JiraCallOptions {
  search?: string | null;
  activity?: string | null;
}

export type JiraError = Error & { status: number; code: string };

// A board column and the workflow statuses it holds. Its title is also its value on the page.
export interface JiraColumn {
  title: string;
  statuses: string[];
}

// A board the member can pick. project is the key of the project the board is located in.
export interface JiraBoardChoice {
  id: number;
  title: string;
  project: string;
}

// A board's name, home project and columns.
export interface JiraBoardInfo {
  boardId: number;
  title: string;
  projectKey: string;
  columns: JiraColumn[];
}

export interface JiraLabelView {
  id: string;
  title: string;
  color: null;
}

// An issue as the board shows it. The key is the id, and the status is the title of the
// column that holds the issue's workflow status.
export interface JiraTask {
  id: string;
  project_id: unknown;
  title: string;
  description: string | null;
  note: null;
  revision: unknown;
  reference: null;
  attributes: { status: string | null };
  linkStatus: string | null;
  labels: JiraLabelView[];
  // task, bug, story or subtask, for the icon, and Jira's own name for the type.
  type: string;
  typeName: string;
  assignees: BoardPerson[];
  priority: string | null;
  due: string | null;
  // A done issue is never late.
  dueDone: boolean;
  commentCount: number | null;
  subtaskCount: { done: number; total: number } | null;
  subtasks: JiraLinked[];
  related: (JiraLinked & { kind: string })[];
  created: string | null;
  updated: string | null;
  url: string;
}

export interface JiraLinked {
  id: string;
  title: string;
  status: string | null;
  done: boolean;
}

export interface JiraBoardView {
  provider: "jira";
  project: { id: number; title: string };
  url: string;
  columns: { value: string; title: string }[];
  labels: JiraLabelView[];
  tasks: JiraTask[];
  truncated: boolean;
  activity: string;
}

export interface JiraBoardUnchanged {
  unchanged: true;
  provider: "jira";
  activity: string;
}

export type JiraBoardLoad =
  | { payload: JiraBoardView; info: JiraBoardInfo }
  | { payload: JiraBoardUnchanged; info: null };

const StoredConnection = fields({
  site: z.unknown().optional(),
  email: z.unknown().optional(),
  token: z.unknown().optional(),
  enabled: z.unknown().optional(),
});

// Jira's bodies. Values are clipped, coerced or checked where they are used.
const Myself = fields({ accountId: z.unknown().optional(), displayName: z.unknown().optional(), emailAddress: z.unknown().optional() });

const Page = fields({
  values: maybe(z.array(z.unknown())),
  issues: maybe(z.array(z.unknown())),
  issueTypes: maybe(z.array(z.unknown())),
  comments: maybe(z.array(z.unknown())),
  transitions: maybe(z.array(z.unknown())),
  total: z.unknown().optional(),
  isLast: z.unknown().optional(),
});

const Board = fields({
  id: z.unknown().optional(),
  name: z.unknown().optional(),
  location: fields({ projectKey: z.unknown().optional() }),
});

const Configuration = fields({
  columnConfig: fields({ columns: maybe(z.array(z.unknown())) }),
});

const ConfigColumn = fields({
  name: z.unknown().optional(),
  statuses: maybe(z.array(z.unknown())),
});

const Named = fields({ id: z.unknown().optional(), name: z.unknown().optional() });

const IssueType = fields({ id: z.unknown().optional(), name: z.unknown().optional(), subtask: z.unknown().optional() });

const Status = fields({
  id: z.unknown().optional(),
  name: z.unknown().optional(),
  statusCategory: fields({ key: z.unknown().optional() }),
});

const User = fields({ accountId: z.unknown().optional(), displayName: z.unknown().optional() });

const Nested = fields({
  key: z.unknown().optional(),
  fields: fields({ summary: z.unknown().optional(), status: Status }),
});

const IssueLink = fields({
  type: fields({ inward: z.unknown().optional(), outward: z.unknown().optional() }),
  inwardIssue: z.unknown().optional(),
  outwardIssue: z.unknown().optional(),
});

const Issue = fields({
  key: z.unknown().optional(),
  fields: fields({
    summary: z.unknown().optional(),
    description: z.unknown().optional(),
    status: Status,
    labels: maybe(z.array(z.unknown())),
    updated: z.unknown().optional(),
    created: z.unknown().optional(),
    project: fields({ id: z.unknown().optional(), key: z.unknown().optional() }),
    issuetype: fields({ subtask: z.unknown().optional(), name: z.unknown().optional() }),
    assignee: z.unknown().optional(),
    priority: fields({ name: z.unknown().optional() }),
    duedate: z.unknown().optional(),
    subtasks: maybe(z.array(z.unknown())),
    issuelinks: maybe(z.array(z.unknown())),
    parent: z.unknown().optional(),
    comment: fields({ total: z.unknown().optional(), comments: maybe(z.array(z.unknown())) }),
  }),
});

type JiraIssue = z.output<typeof Issue>;

const Comment = fields({
  id: z.unknown().optional(),
  body: z.unknown().optional(),
  created: z.unknown().optional(),
  author: z.unknown().optional(),
});

// The connected account's id, by token, so a comment can say whether it is yours.
const accountIds = new Map<string, string>();

const Transition = fields({
  id: z.unknown().optional(),
  to: fields({ id: z.unknown().optional(), name: z.unknown().optional() }),
  fields: z.unknown().optional(),
});

const TransitionField = fields({
  required: z.unknown().optional(),
  hasDefaultValue: z.unknown().optional(),
  name: z.unknown().optional(),
  allowedValues: maybe(z.array(z.unknown())),
  schema: fields({ type: z.unknown().optional() }),
});

const Attachment = fields({
  id: z.unknown().optional(),
  filename: z.unknown().optional(),
  mimeType: z.unknown().optional(),
  size: z.unknown().optional(),
  content: z.unknown().optional(),
  created: z.unknown().optional(),
});

const AttachedIssue = fields({ fields: fields({ attachment: maybe(z.array(z.unknown())) }) });

const Failure = fields({
  errorMessages: maybe(z.array(z.unknown())),
  errors: z.unknown().optional(),
  message: z.unknown().optional(),
});

export function readJiraConnection(file: string): JiraConnection {
  const empty = { site: "", email: "", token: "", enabled: false };
  if (!file || !existsSync(file)) return empty;
  try {
    const raw = StoredConnection.parse(JSON.parse(readFileSync(file, "utf8")));
    const site = storedSite(raw.site);
    const email = cleanSecret(raw.email);
    const token = cleanSecret(openSecret(raw.token));
    const configured = Boolean(site && email && token);
    return { site, email, token, enabled: raw.enabled === false ? false : configured };
  } catch {
    return empty;
  }
}

export function writeJiraConnection(connection: unknown, file: string): JiraConnection {
  const input = StoredConnection.parse(connection);
  const site = jiraSite(input.site);
  const email = cleanSecret(input.email);
  const token = cleanSecret(input.token);
  if (!email || !token) throw jiraError(400, "Add your Jira email and API token");
  const enabled = input.enabled !== false;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ site, email, token: sealSecret(token), enabled }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return { site, email, token, enabled };
}

export function saveJiraConnection(input: ConnectionRequest, file: string): JiraConnection {
  const current = readJiraConnection(file);
  const site = jiraSite(input.baseUrl?.trim() || current.site);
  return writeJiraConnection({
    site,
    email: input.email?.trim() || current.email,
    token: input.token?.trim() || (site === current.site ? current.token : ""),
    enabled: input.enabled ?? true,
  }, file);
}

// The site's origin. A bare host name gets https. Plain http is allowed only on this machine.
export function jiraSite(value: unknown): string {
  const text = String(value ?? "").trim();
  const failure = jiraError(400, "Enter the Jira site, for example https://example.atlassian.net");
  if (!text || /\s/.test(text)) throw failure;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw failure;
  }
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw failure;
  if (url.username || url.password) throw failure;
  return url.origin;
}

export async function jiraStatus(connection: JiraConnection, options?: JiraCallOptions): Promise<JiraStatus> {
  const configured = Boolean(connection.site && connection.email && connection.token);
  const enabled = configured && connection.enabled;
  const base = { configured, enabled, site: connection.site, email: connection.email };
  if (!enabled) return { ...base, reachable: false, name: null };
  try {
    const me = Myself.parse(await jiraFetch(connection, "GET", "/rest/api/2/myself", options));
    return { ...base, reachable: true, name: me.displayName || me.emailAddress || null };
  } catch {
    return { ...base, reachable: false, name: null };
  }
}

export async function listJiraBoards(connection: JiraConnection, options?: JiraCallOptions): Promise<JiraBoardChoice[]> {
  requireConnection(connection);
  const { items } = await allPages(connection, "/rest/agile/1.0/board", "values", {}, options);
  return items.flatMap((item) => {
    const board = Board.parse(item);
    const id = boardNumber(board.id);
    return id === null ? [] : [{ id, title: clip(board.name, 200) || String(id), project: projectKeyOf(board.location.projectKey) }];
  });
}

export async function readJiraBoard(connection: JiraConnection, boardId: unknown, options?: JiraCallOptions): Promise<JiraBoardInfo> {
  requireConnection(connection);
  const id = boardNumber(boardId);
  if (id === null) throw jiraError(400, "Choose a Jira board");
  const [board, config] = await Promise.all([
    jiraFetch(connection, "GET", `/rest/agile/1.0/board/${id}`, options).then((reply) => Board.parse(reply)),
    jiraFetch(connection, "GET", `/rest/agile/1.0/board/${id}/configuration`, options).then((reply) => Configuration.parse(reply)),
  ]);
  return {
    boardId: id,
    title: clip(board.name, 200) || String(id),
    projectKey: projectKeyOf(board.location.projectKey),
    columns: presentColumns(config.columnConfig.columns),
  };
}

export async function jiraColumns(connection: JiraConnection, boardId: number, options?: JiraCallOptions): Promise<JiraColumn[]> {
  const config = Configuration.parse(await jiraFetch(connection, "GET", `/rest/agile/1.0/board/${boardId}/configuration`, options));
  return presentColumns(config.columnConfig.columns);
}

export function presentColumns(value: unknown[] | undefined): JiraColumn[] {
  const columns: JiraColumn[] = [];
  for (const item of value ?? []) {
    const column = ConfigColumn.parse(item);
    // Board replies strip hidden characters, so names are cleaned before they are made unique.
    const name = clip(stripHidden(column.name), 80);
    if (!name) continue;
    let title = name;
    for (let copy = 2; columns.some((other) => other.title === title); copy += 1) title = `${name} ${copy}`;
    const statuses = (column.statuses ?? []).flatMap((status) => {
      const id = String(Named.parse(status).id ?? "").trim();
      return id ? [id] : [];
    });
    columns.push({ title, statuses });
  }
  return columns;
}

export async function loadJiraBoard(connection: JiraConnection, boardId: unknown, options: JiraLoadOptions = {}): Promise<JiraBoardLoad> {
  requireConnection(connection);
  const id = boardNumber(boardId);
  if (id === null) throw jiraError(400, "Choose a Jira board");
  const [info, latest] = await Promise.all([readJiraBoard(connection, id, options), latestChange(connection, id, options)]);
  // The board's name and columns, its newest ticket change and how many tickets it shows. A load with the same stamp is skipped.
  const activity = createHash("sha256").update(JSON.stringify([info, latest.total, latest.key, latest.updated])).digest("hex").slice(0, 32);
  if (options.activity && options.activity === activity) {
    return { payload: { unchanged: true, provider: "jira", activity }, info: null };
  }
  const { items, truncated } = await allPages(connection, `/rest/agile/1.0/board/${id}/issue`, "issues", {
    jql: `${BOARD_SCOPE} ORDER BY Rank ASC`,
    fields: ISSUE_FIELDS,
  }, options);
  return { payload: presentJiraBoard(connection, info, items, options.search || "", truncated, activity), info };
}

export function presentJiraBoard(
  connection: Pick<JiraConnection, "site">,
  info: JiraBoardInfo,
  issues: unknown[],
  search: string,
  truncated: boolean,
  activity: string,
): JiraBoardView {
  const needle = search.trim().toLowerCase();
  // A sub-task gets no card of its own. It still opens from a link and takes moves and comments.
  const cards = issues
    .filter((issue) => Issue.parse(issue).fields.issuetype.subtask !== true)
    .map((issue) => presentIssue(issue, info.columns, connection.site));
  const tasks = cards.filter((task) => task.id && (!needle || `${task.title}\n${task.description || ""}`.toLowerCase().includes(needle)));
  // Jira keeps no list of labels, so the board's are those on its issues, whatever the search.
  const labels = new Map<string, JiraLabelView>();
  for (const task of cards) for (const label of task.labels) labels.set(label.id, label);
  return {
    provider: "jira",
    project: { id: info.boardId, title: info.title },
    url: `${connection.site}/secure/RapidBoard.jspa?rapidView=${info.boardId}`,
    columns: info.columns.map((column) => ({ value: column.title, title: column.title })),
    labels: [...labels.values()],
    tasks,
    truncated,
    activity,
  };
}

export function presentIssue(input: unknown, columns: JiraColumn[], site = ""): JiraTask {
  const issue = Issue.parse(input);
  const key = ticketId(issue.key);
  const status = String(issue.fields.status.id ?? "");
  const column = columns.find((item) => item.statuses.includes(status));
  const description = typeof issue.fields.description === "string" && issue.fields.description.trim()
    ? issue.fields.description
    : null;
  const subtasks = (issue.fields.subtasks ?? []).flatMap((item) => linkedIssue(item, columns));
  const assignee = User.parse(issue.fields.assignee);
  const owner = person(assignee.accountId, assignee.displayName);
  const comments = Number(issue.fields.comment.total ?? issue.fields.comment.comments?.length);
  return {
    id: isIssueKey(key) ? key : "",
    project_id: issue.fields.project.id ?? "",
    title: clip(issue.fields.summary, 200),
    description,
    note: null,
    revision: issue.fields.updated ?? null,
    reference: null,
    attributes: { status: column?.title ?? null },
    linkStatus: column?.title ?? null,
    // The full label is its id, so a long one can still be removed; only the title is clipped.
    labels: (issue.fields.labels ?? []).flatMap((item) => {
      const id = typeof item === "string" ? item.trim() : "";
      return id ? [{ id, title: clip(id, 40), color: null }] : [];
    }),
    type: issueType(issue.fields.issuetype),
    typeName: clip(issue.fields.issuetype.name, 40),
    assignees: owner ? [owner] : [],
    priority: clip(issue.fields.priority.name, 40) || null,
    due: typeof issue.fields.duedate === "string" && issue.fields.duedate ? issue.fields.duedate : null,
    dueDone: issue.fields.status.statusCategory.key === "done",
    commentCount: Number.isFinite(comments) ? comments : null,
    subtaskCount: subtasks.length ? { done: subtasks.filter((item) => item.done).length, total: subtasks.length } : null,
    subtasks,
    related: [
      ...parentLink(issue.fields.parent, columns),
      ...(issue.fields.issuelinks ?? []).flatMap((item) => {
        const link = IssueLink.parse(item);
        const outward = link.outwardIssue !== undefined;
        const kind = clip(outward ? link.type.outward : link.type.inward, 40);
        return linkedIssue(outward ? link.outwardIssue : link.inwardIssue, columns).map((other) => ({ ...other, kind }));
      }),
    ],
    created: typeof issue.fields.created === "string" ? issue.fields.created : null,
    updated: typeof issue.fields.updated === "string" ? issue.fields.updated : null,
    url: site && isIssueKey(key) ? `${site}/browse/${key}` : "",
  };
}

function issueType(type: { subtask?: unknown; name?: unknown }): string {
  if (type.subtask === true) return "subtask";
  const name = String(type.name ?? "").toLowerCase();
  if (name === "bug") return "bug";
  if (name === "story") return "story";
  return "task";
}

function linkedIssue(value: unknown, columns: JiraColumn[]): JiraLinked[] {
  const nested = Nested.parse(value);
  const key = ticketId(nested.key);
  if (!isIssueKey(key)) return [];
  const status = String(nested.fields.status.id ?? "");
  const column = columns.find((item) => item.statuses.includes(status));
  return [{
    id: key,
    title: clip(nested.fields.summary, 200),
    status: column?.title ?? (clip(nested.fields.status.name, 80) || null),
    done: nested.fields.status.statusCategory.key === "done",
  }];
}

function parentLink(value: unknown, columns: JiraColumn[]): (JiraLinked & { kind: string })[] {
  return value === undefined || value === null ? [] : linkedIssue(value, columns).map((parent) => ({ ...parent, kind: "sub-task of" }));
}

export function resolveJiraColumn(columns: JiraColumn[], status: unknown): JiraColumn | null {
  const raw = stripHidden(status).trim();
  if (!raw) return null;
  const exact = columns.find((column) => column.title === raw);
  if (exact) return exact;
  const matches = columns.filter((column) => column.title.toLowerCase() === raw.toLowerCase());
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

export async function readJiraIssue(connection: JiraConnection, key: unknown, options?: JiraCallOptions): Promise<JiraIssue> {
  requireConnection(connection);
  const issue = await jiraFetch(connection, "GET", `/rest/api/2/issue/${issueKey(key)}`, { ...options, query: { fields: ISSUE_FIELDS } });
  if (!isRecord(issue)) throw jiraError(502, "Jira returned no ticket");
  return Issue.parse(issue);
}

// The issue when the board's filter holds it, including done ones the board view leaves out.
export async function jiraIssueOnBoard(connection: JiraConnection, boardId: number, key: unknown, options?: JiraCallOptions): Promise<unknown> {
  requireConnection(connection);
  const page = Page.parse(await jiraFetch(connection, "GET", `/rest/agile/1.0/board/${boardId}/issue`, {
    ...options,
    query: { jql: `key = ${issueKey(key)}`, fields: ISSUE_FIELDS, maxResults: 1 },
  }));
  const [issue] = page.issues ?? [];
  if (!issue) throw jiraError(404, "That ticket is on another board");
  return issue;
}

export async function createJiraIssue(
  connection: JiraConnection,
  projectKey: string,
  columns: JiraColumn[],
  { title, description }: { title?: unknown; description?: unknown },
  options?: JiraCallOptions,
): Promise<JiraTask> {
  requireConnection(connection);
  const summary = clip(title, 200);
  if (!summary) throw jiraError(400, "Name the ticket");
  if (!projectKey) throw jiraError(400, "This Jira board is not in one project, so create the ticket in Jira");
  const types = Page.parse(await jiraFetch(connection, "GET", `/rest/api/2/issue/createmeta/${projectKey}/issuetypes`, options));
  const choices = (types.issueTypes ?? types.values ?? []).map((item) => IssueType.parse(item)).filter((type) => type.subtask !== true && type.id);
  const type = choices.find((item) => String(item.name).toLowerCase() === "task") ?? choices[0];
  if (!type) throw jiraError(400, `Jira has no issue type to create in ${projectKey}`);
  const text = description ? String(description).trim().slice(0, 8000) : "";
  const created = Issue.parse(await jiraFetch(connection, "POST", "/rest/api/2/issue", {
    ...options,
    body: {
      fields: {
        project: { key: projectKey },
        issuetype: { id: String(type.id) },
        summary,
        ...(text ? { description: text } : {}),
      },
    },
  }));
  return presentIssue(await readJiraIssue(connection, created.key, options), columns, connection.site);
}

export async function editJiraIssue(
  connection: JiraConnection,
  key: unknown,
  edit: TicketEdit,
  columns: JiraColumn[],
  options?: JiraCallOptions,
): Promise<JiraTask> {
  requireConnection(connection);
  if (edit.revision === undefined || edit.revision === null || edit.revision === "") throw jiraError(400, "Reload this ticket");
  const current = await readJiraIssue(connection, key, options);
  if (String(current.fields.updated ?? "") !== String(edit.revision)) throw jiraError(409, "Someone else edited this ticket");
  const changed: { summary?: string; description?: string | null } = {};
  if (edit.title !== undefined) {
    const summary = clip(edit.title, 200);
    if (!summary) throw jiraError(400, "Name the ticket");
    if (summary !== current.fields.summary) changed.summary = summary;
  }
  if (edit.description !== undefined) {
    const text = (edit.description ?? "").trim().slice(0, 8000);
    const before = typeof current.fields.description === "string" ? current.fields.description : "";
    if (text !== before) changed.description = text || null;
  }
  if (Object.keys(changed).length) {
    await jiraFetch(connection, "PUT", `/rest/api/2/issue/${issueKey(key)}`, { ...options, body: { fields: changed } });
  }
  return presentIssue(await readJiraIssue(connection, key, options), columns, connection.site);
}

async function transitionsOf(connection: JiraConnection, key: unknown, columns: JiraColumn[], options?: JiraCallOptions) {
  const listed = Page.parse(await jiraFetch(connection, "GET", `/rest/api/2/issue/${issueKey(key)}/transitions`, {
    ...options,
    query: { expand: "transitions.fields" },
  }));
  return (listed.transitions ?? []).flatMap((item) => {
    const transition = Transition.parse(item);
    const column = columns.find((candidate) => candidate.statuses.includes(String(transition.to.id ?? "")));
    return transition.id && column ? [{ transition, column }] : [];
  });
}

// What a transition asks for before Jira takes it. A resolution is picked here. A text field or a
// comment is asked of the person (fillable); any other required field has to be set in Jira.
function transitionNeeds(transition: z.output<typeof Transition>) {
  const fillable: MoveField[] = [];
  const elsewhere: string[] = [];
  const preset: Record<string, unknown> = {};
  for (const [id, raw] of Object.entries(isRecord(transition.fields) ? transition.fields : {})) {
    const field = TransitionField.parse(raw);
    if (field.required !== true || field.hasDefaultValue === true) continue;
    const resolution = id === "resolution" ? pickResolution(field.allowedValues) : null;
    const name = clip(field.name, 60) || id;
    if (resolution) preset[id] = resolution;
    else if (id === "comment" || field.schema.type === "string") fillable.push({ id, name });
    else elsewhere.push(name);
  }
  return { fillable, elsewhere, preset };
}

// The columns the issue can move to now, by Jira's workflow, and the fields each move asks for.
// A move that needs a field only Jira can set is left out.
export async function jiraMoves(connection: JiraConnection, key: unknown, columns: JiraColumn[], options?: JiraCallOptions): Promise<BoardMove[]> {
  requireConnection(connection);
  const issue = await readJiraIssue(connection, key, options);
  const here = String(issue.fields.status.id ?? "");
  const transitions = await transitionsOf(connection, key, columns, options);
  return columns.flatMap((column) => {
    const transition = column.statuses.includes(here) ? undefined : pickTransition(transitions, column);
    const needs = transition ? transitionNeeds(transition) : null;
    return needs && !needs.elsewhere.length ? [{ status: column.title, title: column.title, needs: needs.fillable }] : [];
  });
}

// The transition a move into the column takes: the first in the column's status order that needs
// no field only Jira can set, or else the first, so the refusal can name that field.
function pickTransition(transitions: { transition: z.output<typeof Transition>; column: JiraColumn }[], column: JiraColumn) {
  const into = transitions
    .filter((item) => item.column === column)
    .map((item) => item.transition)
    .sort((a, b) => column.statuses.indexOf(String(a.to.id)) - column.statuses.indexOf(String(b.to.id)));
  return into.find((transition) => !transitionNeeds(transition).elsewhere.length) ?? into[0];
}

// Moves the issue through the workflow transition that leads into the column, then ranks it
// where the order puts it. A workflow with no such transition, or one that needs a field only
// Jira can set, refuses with a 409. A field the person can fill in is asked for with needsFields.
export async function moveJiraIssue(
  connection: JiraConnection,
  key: unknown,
  status: unknown,
  columns: JiraColumn[],
  options?: JiraCallOptions,
  extra?: MoveExtra,
): Promise<JiraTask> {
  requireConnection(connection);
  const column = resolveJiraColumn(columns, status);
  if (!column) throw jiraError(400, "Choose a column");
  const issue = await readJiraIssue(connection, key, options);
  if (!column.statuses.includes(String(issue.fields.status.id ?? ""))) {
    await transitionInto(connection, key, issue, column, columns, options, extra?.fields ?? {});
  }
  await rankIssue(connection, key, extra, options);
  return presentIssue(await readJiraIssue(connection, key, options), columns, connection.site);
}

async function transitionInto(
  connection: JiraConnection,
  key: unknown,
  issue: JiraIssue,
  column: JiraColumn,
  columns: JiraColumn[],
  options: JiraCallOptions | undefined,
  given: Record<string, string>,
): Promise<void> {
  const transition = pickTransition(await transitionsOf(connection, key, columns, options), column);
  const from = clip(issue.fields.status.name, 80) || "its status";
  if (!transition) throw jiraError(409, `Jira's workflow has no move from ${from} to ${column.title}`);
  const needs = transitionNeeds(transition);
  if (needs.elsewhere.length) throw jiraError(409, `Moving to ${column.title} needs ${needs.elsewhere.join(", ")} in Jira`);
  const unanswered = needs.fillable.filter((field) => !given[field.id]?.trim());
  if (unanswered.length) {
    throw needsFields(`Moving to ${column.title} needs ${unanswered.map((field) => field.name).join(", ")}`, "jira", unanswered);
  }
  const filled: Record<string, unknown> = { ...needs.preset };
  let comment = "";
  for (const field of needs.fillable) {
    const value = String(given[field.id] ?? "").trim().slice(0, 8000);
    if (field.id === "comment") comment = value;
    else filled[field.id] = value;
  }
  try {
    await jiraFetch(connection, "POST", `/rest/api/2/issue/${issueKey(key)}/transitions`, {
      ...options,
      body: {
        transition: { id: String(transition.id) },
        ...(Object.keys(filled).length ? { fields: filled } : {}),
        ...(comment ? { update: { comment: [{ add: { body: comment } }] } } : {}),
      },
    });
  } catch (error) {
    if (isRecord(error) && error.status === 400) {
      throw jiraError(409, `Jira refused the move to ${column.title}: ${String(error.message)}`);
    }
    throw error;
  }
}

async function rankIssue(connection: JiraConnection, key: unknown, extra: MoveExtra | undefined, options?: JiraCallOptions): Promise<void> {
  const own = issueKey(key);
  const near = neighbors(extra?.order, own);
  if (!near) return;
  const after = isIssueKey(near.above) ? near.above : null;
  const before = isIssueKey(near.below) ? near.below : null;
  if (!after && !before) return;
  try {
    await jiraFetch(connection, "PUT", "/rest/agile/1.0/issue/rank", {
      ...options,
      body: after ? { issues: [own], rankAfterIssue: after } : { issues: [own], rankBeforeIssue: before },
    });
  } catch {
    // A board without ranking keeps Jira's order; the move itself stands.
  }
}

// Adds or removes one label. A Jira label is a plain word, so its title is also its id.
export async function changeJiraLabel(
  connection: JiraConnection,
  key: unknown,
  label: unknown,
  attach: boolean,
  columns: JiraColumn[],
  options?: JiraCallOptions,
): Promise<JiraTask> {
  requireConnection(connection);
  const title = jiraLabel(label);
  // A board reply strips hidden characters from label names, so a removal finds the label as Jira spells it.
  const labels = attach ? [] : ((await readJiraIssue(connection, key, options)).fields.labels ?? []);
  const named = labels.includes(title) ? title : labels.find((item): item is string => typeof item === "string" && stripHidden(item) === stripHidden(title));
  await jiraFetch(connection, "PUT", `/rest/api/2/issue/${issueKey(key)}`, {
    ...options,
    body: { update: { labels: [attach ? { add: title } : { remove: named ?? title }] } },
  });
  return presentIssue(await readJiraIssue(connection, key, options), columns, connection.site);
}

// Jira refuses a label with a space in it, so spaces become dashes.
export function jiraLabel(value: unknown): string {
  const title = clip(value, 255).replace(/\s+/g, "-");
  if (!title) throw jiraError(400, "Name the label");
  return title;
}

export async function listJiraComments(connection: JiraConnection, key: unknown, options?: JiraCallOptions): Promise<BoardComment[]> {
  requireConnection(connection);
  const { items } = await allPages(connection, `/rest/api/2/issue/${issueKey(key)}/comment`, "comments", { orderBy: "created" }, options);
  const me = await jiraAccountId(connection, options);
  return items.flatMap((item) => {
    const comment = presentComment(item, me);
    return comment.id && comment.body ? [comment] : [];
  });
}

export async function addJiraComment(connection: JiraConnection, key: unknown, text: string, options?: JiraCallOptions): Promise<BoardComment> {
  requireConnection(connection);
  const created = await jiraFetch(connection, "POST", `/rest/api/2/issue/${issueKey(key)}/comment`, { ...options, body: { body: text } });
  return presentComment(created, await jiraAccountId(connection, options), text);
}

export async function editJiraComment(connection: JiraConnection, key: unknown, commentId: string, text: string, options?: JiraCallOptions): Promise<BoardComment> {
  requireConnection(connection);
  const edited = await jiraFetch(connection, "PUT", `/rest/api/2/issue/${issueKey(key)}/comment/${commentNumber(commentId)}`, { ...options, body: { body: text } });
  return presentComment(edited, await jiraAccountId(connection, options), text);
}

export async function deleteJiraComment(connection: JiraConnection, key: unknown, commentId: string, options?: JiraCallOptions): Promise<void> {
  requireConnection(connection);
  await jiraFetch(connection, "DELETE", `/rest/api/2/issue/${issueKey(key)}/comment/${commentNumber(commentId)}`, options);
}

// Jira refuses an issue with sub-tasks, and an account without the Delete Issues permission, with its own message.
export async function deleteJiraIssue(connection: JiraConnection, key: unknown, options?: JiraCallOptions): Promise<void> {
  requireConnection(connection);
  await jiraFetch(connection, "DELETE", `/rest/api/2/issue/${issueKey(key)}`, options);
}

function presentComment(item: unknown, me: string, fallback = ""): BoardComment {
  const comment = Comment.parse(item);
  const author = User.parse(comment.author);
  return {
    id: comment.id,
    body: (typeof comment.body === "string" ? comment.body : fallback).trim(),
    author: person(author.accountId, author.displayName),
    created: typeof comment.created === "string" ? comment.created : null,
    mine: Boolean(me) && String(author.accountId ?? "") === me,
  };
}

function attachmentNumber(value: string): number {
  const id = ticketId(value);
  if (typeof id !== "number") throw jiraError(404, "This ticket has no such file");
  return id;
}

function presentFile(value: unknown): unknown {
  const file = Attachment.parse(value);
  return {
    id: file.id === undefined ? null : String(file.id),
    name: file.filename ?? null,
    content_type: file.mimeType ?? null,
    size: file.size ?? null,
    url: file.content ?? null,
    created_at: file.created ?? null,
  };
}

function commentNumber(value: string): number {
  const id = ticketId(value);
  if (typeof id !== "number") throw jiraError(400, "Choose a comment");
  return id;
}

// The connected account's id. Empty when Jira does not say, so no comment reads as yours.
export async function jiraAccountId(connection: JiraConnection, options?: JiraCallOptions): Promise<string> {
  const known = accountIds.get(connection.token);
  if (known) return known;
  try {
    const me = Myself.parse(await jiraFetch(connection, "GET", "/rest/api/2/myself", options));
    const id = typeof me.accountId === "string" ? me.accountId : "";
    if (id) accountIds.set(connection.token, id);
    return id;
  } catch {
    return "";
  }
}

export async function listJiraFiles(connection: JiraConnection, key: unknown, options?: JiraCallOptions): Promise<unknown[]> {
  requireConnection(connection);
  const issue = AttachedIssue.parse(await jiraFetch(connection, "GET", `/rest/api/2/issue/${issueKey(key)}`, { ...options, query: { fields: "attachment" } }));
  return (issue.fields.attachment ?? []).map(presentFile);
}

export async function addJiraFile(connection: JiraConnection, key: unknown, name: string, file: Blob, options?: JiraCallOptions): Promise<unknown> {
  requireConnection(connection);
  const form = new FormData();
  form.append("file", file, name);
  // Jira refuses an upload without this header.
  const headers = { "X-Atlassian-Token": "no-check" };
  const added = await jiraFetch(connection, "POST", `/rest/api/2/issue/${issueKey(key)}/attachments`, { ...options, timeoutMs: FILE_TIMEOUT_MS, body: form, headers });
  const [first] = Array.isArray(added) ? added : [];
  if (!first) throw jiraError(502, "Jira did not return the file");
  return presentFile(first);
}

export async function readJiraFile(connection: JiraConnection, fileId: string, range: string | undefined, options?: JiraCallOptions): Promise<FileBytes> {
  requireConnection(connection);
  const headers: Record<string, string> = { Accept: "*/*" };
  if (range) headers.Range = range;
  return jiraCall(connection, "GET", `/rest/api/2/attachment/content/${attachmentNumber(fileId)}`, { ...options, timeoutMs: FILE_TIMEOUT_MS, headers }, fileBytes);
}

// An attachment id names no issue, so the issue's own list is read first.
export async function deleteJiraFile(connection: JiraConnection, key: unknown, fileId: string, options?: JiraCallOptions): Promise<void> {
  const owned = (await listJiraFiles(connection, key, options)).some((file) => isRecord(file) && file.id === fileId);
  if (!owned) throw jiraError(404, "This ticket has no such file");
  await jiraFetch(connection, "DELETE", `/rest/api/2/attachment/${attachmentNumber(fileId)}`, options);
}

export function jiraError(status: number, message: string): JiraError {
  return Object.assign(new Error(message), { status, code: "jira" });
}

interface JiraRequest extends JiraCallOptions {
  query?: Record<string, unknown>;
  body?: unknown;
  headers?: Record<string, string>;
}

function jiraFetch(connection: JiraConnection, method: string, jiraPath: string, request: JiraRequest = {}): Promise<unknown> {
  return jiraCall(connection, method, jiraPath, request, responseJson);
}

async function jiraCall<T>(
  connection: JiraConnection,
  method: string,
  jiraPath: string,
  { query = {}, body, headers = {}, timeoutMs = 15000, fetchImpl = fetch }: JiraRequest,
  read: (response: BoardFetchResponse) => Promise<T>,
): Promise<T> {
  if (!connection.site || !connection.email || !connection.token) throw jiraError(400, "Add a Jira site, email and API token");
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") params.set(name, String(value));
  }
  const search = params.size ? `?${params}` : "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const form = body instanceof FormData;
  try {
    const response = await fetchImpl(`${connection.site}${jiraPath}${search}`, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${Buffer.from(`${connection.email}:${connection.token}`).toString("base64")}`,
        ...(body === undefined || form ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      body: body === undefined || form ? body : JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) throw jiraError(response.status, safeJiraMessage(response.status, await responseJson(response), connection));
    return await read(response);
  } catch (error) {
    if (isRecord(error) && error.name === "AbortError") throw jiraError(504, "Jira did not answer");
    if (isRecord(error) && error.code === "jira") throw error;
    throw jiraError(502, "Jira is not reachable");
  } finally {
    clearTimeout(timer);
  }
}

// Every item of a paged Jira list, up to MOST_ITEMS. A page can hold fewer items than asked for.
async function allPages(
  connection: JiraConnection,
  jiraPath: string,
  field: "values" | "issues" | "comments",
  query: Record<string, unknown>,
  options?: JiraCallOptions,
): Promise<{ items: unknown[]; truncated: boolean }> {
  const pageAt = async (startAt: number) => Page.parse(await jiraFetch(connection, "GET", jiraPath, {
    ...options,
    query: { ...query, startAt, maxResults: PAGE },
  }));
  const items: unknown[] = [];
  const ended = (complete: boolean) => (
    complete || items.length >= MOST_ITEMS ? { items: items.slice(0, MOST_ITEMS), truncated: !complete || items.length > MOST_ITEMS } : null
  );
  let ahead = true;
  for (;;) {
    const page = await pageAt(items.length);
    const batch = page[field] ?? [];
    items.push(...batch);
    const total = Number(page.total);
    const end = ended(batch.length === 0 || page.isLast === true || (Number.isFinite(total) && items.length >= total));
    if (end) return end;
    if (!ahead || !Number.isFinite(total)) continue;
    ahead = false;
    const starts: number[] = [];
    for (let start = items.length; start < Math.min(total, MOST_ITEMS); start += batch.length) starts.push(start);
    const pages = await Promise.all(starts.map(pageAt));
    for (const [index, rest] of pages.entries()) {
      // A short page shifts every later start, so from there the loop reads on in turn.
      if (items.length !== starts[index]) break;
      items.push(...(rest[field] ?? []));
    }
    const read = ended(items.length >= total);
    if (read) return read;
  }
}

async function latestChange(connection: JiraConnection, boardId: number, options?: JiraCallOptions): Promise<{ total: unknown; key: unknown; updated: unknown }> {
  const page = Page.parse(await jiraFetch(connection, "GET", `/rest/agile/1.0/board/${boardId}/issue`, {
    ...options,
    query: { jql: `${BOARD_SCOPE} ORDER BY updated DESC`, fields: "updated", maxResults: 1 },
  }));
  const latest = Issue.parse(page.issues?.[0]);
  return { total: page.total ?? "", key: latest.key ?? "", updated: latest.fields.updated ?? "" };
}

function pickResolution(values: unknown[] | undefined): { id: string } | null {
  const choices = (values ?? []).map((item) => Named.parse(item)).filter((item) => item.id);
  const choice = choices.find((item) => String(item.name).toLowerCase() === "done") ?? choices[0];
  return choice ? { id: String(choice.id) } : null;
}

function requireConnection(connection: JiraConnection): void {
  if (!connection.site || !connection.email || !connection.token) throw jiraError(400, "Add a Jira site, email and API token");
  if (!connection.enabled) throw jiraError(400, "Enable Jira in Setup");
}

function issueKey(value: unknown): string {
  const key = ticketId(value);
  if (!isIssueKey(key)) throw jiraError(400, "Choose a ticket");
  return key;
}

function boardNumber(value: unknown): number | null {
  const id = ticketId(value);
  return typeof id === "number" ? id : null;
}

function projectKeyOf(value: unknown): string {
  const key = String(value ?? "").trim().toUpperCase();
  return /^[A-Z][A-Z0-9_]*$/.test(key) ? key : "";
}

function safeJiraMessage(status: number, parsed: unknown, connection: JiraConnection): string {
  if (status === 401) return "The Jira email or API token was refused";
  const failure = Failure.parse(parsed);
  const errors = isRecord(failure.errors) ? Object.values(failure.errors) : [];
  const first = [...(failure.errorMessages ?? []), ...errors, failure.message].find((item) => typeof item === "string" && item.trim());
  const message = typeof first === "string" ? first.trim().replace(/\s+/g, " ") : "";
  if (!message || message.length > 200) return status === 404 ? "Jira has no such ticket or board" : "Jira refused the request";
  if (message.includes(connection.token) || message.includes(connection.email)) return "Jira refused the request";
  return message;
}

function storedSite(value: unknown): string {
  try {
    return jiraSite(value);
  } catch {
    return "";
  }
}

function cleanSecret(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || /[\r\n]/.test(text)) return "";
  return text;
}

function clip(value: unknown, max: number): string {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, max);
}
