// A stand-in for SAK that keeps one project's board in memory and answers in SAK's own shapes.
// shortcut: it takes only the writes the browser tests make, and SAK's 404 answers the rest. Add a route when a test needs one.

import { once } from "node:events";
import http from "node:http";
import { json } from "node:stream/consumers";

type Label = { id: number; project_id: number; title: string; color: string | null };

export interface FakeSakBoard {
  project: { id: number; title: string };
  labels: Label[];
  tasks: { id: number; attributes: Record<string, string>; labels: Label[]; [field: string]: unknown }[];
  comments: Record<number, unknown[]>;
  // The time on everything a write creates.
  now: string;
}

const STATUS = { id: 1, name: "status", type: "enum", options: ["open", "active", "review", "done"].map((value, index) => ({ id: index + 1, value, position: index + 1 })) };

export async function startFakeSak(seed: FakeSakBoard, token: string): Promise<{ baseUrl: string; stop(): Promise<void> }> {
  // Writes stay in this server, so the next one starts on the seed again.
  const board = structuredClone(seed);
  const project = `/api/projects/${board.project.id}`;
  const attributes: unknown[] = [STATUS];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const [, id, name] = /^\/api\/tasks\/(\d+)(?:\/(?:attributes|labels)\/(\w+))?/.exec(url.pathname) ?? [];
    const taskId = Number(id);
    const task = board.tasks.find((item) => item.id === taskId);
    const label = board.labels.find((item) => item.id === Number(name));
    const sent = req.method === "GET" || req.method === "HEAD" || req.method === "DELETE" ? {} : Object(await json(req).catch(() => null));
    const answers: Record<string, () => unknown> = {
      "GET /api/health": () => ({ ok: true, version: "0.2.0" }),
      "GET /api/projects": () => [board.project],
      [`GET ${project}`]: () => board.project,
      [`GET ${project}/attributes`]: () => attributes,
      [`POST ${project}/attributes`]: () => {
        const added = { id: attributes.length + 1, name: sent.name, type: sent.type };
        attributes.push(added);
        return added;
      },
      [`GET ${project}/labels`]: () => board.labels,
      [`GET ${project}/tasks`]: () => {
        const search = (url.searchParams.get("search") ?? "").toLowerCase();
        const found = board.tasks.filter((item) => String(item.title).toLowerCase().includes(search));
        const perPage = Number(url.searchParams.get("per_page") || 50);
        const start = (Number(url.searchParams.get("page") || 1) - 1) * perPage;
        return { items: found.slice(start, start + perPage), total: found.length };
      },
      [`POST ${project}/tasks`]: () => {
        const created = { id: Math.max(0, ...board.tasks.map((item) => item.id)) + 1, reference: null, project_id: board.project.id, title: sent.title, description: sent.description ?? null, note: null, revision: 1, created_at: board.now, updated_at: board.now, attributes: {}, relations: [], labels: [] };
        board.tasks.push(created);
        return created;
      },
      [`GET /api/tasks/${taskId}`]: () => task,
      [`GET /api/tasks/${taskId}/comments`]: () => board.comments[taskId] ?? [],
      [`POST /api/tasks/${taskId}/comments`]: () => {
        if (!task) return undefined;
        const comments = (board.comments[taskId] ??= []);
        const created = { id: Object.values(board.comments).flat().length + 1, task_id: taskId, body: sent.body, created_at: board.now };
        comments.push(created);
        return created;
      },
      [`GET /api/tasks/${taskId}/files`]: () => [],
      [`PUT /api/tasks/${taskId}/attributes/${name}`]: () => task && Object.assign(task, { attributes: { ...task.attributes, [String(name)]: String(sent.value) } }),
      [`DELETE /api/tasks/${taskId}/attributes/${name}`]: () => task && Object.assign(task, { attributes: Object.fromEntries(Object.entries(task.attributes).filter(([key]) => key !== name)) }),
      [`PUT /api/tasks/${taskId}/labels/${name}`]: () => task && label && Object.assign(task, { labels: [...task.labels.filter((item) => item.id !== label.id), label] }),
      [`DELETE /api/tasks/${taskId}/labels/${name}`]: () => task && Object.assign(task, { labels: task.labels.filter((item) => item.id !== label?.id) }),
    };
    const authorized = req.headers.authorization === `Bearer ${token}`;
    // A HEAD of the site gets the 404 of a SAK that runs without its website.
    const body = authorized ? answers[`${req.method} ${url.pathname}`]?.() : undefined;
    const status = req.method !== "HEAD" && !authorized ? 401 : body === undefined ? 404 : 200;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body ?? { error: status === 401 ? "unauthorized" : "not_found" }));
  });
  await once(server.listen(0, "127.0.0.1"), "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The fake SAK got no port.");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async stop() {
      server.closeAllConnections();
      await once(server.close(), "close");
    },
  };
}
