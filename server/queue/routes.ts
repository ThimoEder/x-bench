// Queue routes: check a parent ticket's sub-tickets, start a run, end it, and start a failed ticket again.

import { z } from "zod";
import { canonicalCwd } from "../chat/sessions.ts";
import { messageOf, sendJson, statusOf } from "../http.ts";
import { route, type Route } from "../router.ts";
import { DEFAULT_SLOTS, FINISH_MODES, MAX_SLOTS } from "./queuePlan.ts";
import type { QueueRunner } from "./queueRunner.ts";

const TaskId = z.union([z.string(), z.number()]).transform(String);
const Picks = z.object({ provider: z.string().default(""), model: z.string().default(""), effort: z.string().default("") });

export function queueRoutes(queues: QueueRunner): Route[] {
  async function answer(res: Parameters<Route["handle"]>[0]["res"], run: () => unknown) {
    try {
      sendJson(res, 200, await run());
    } catch (error) {
      sendJson(res, statusOf(error, 500), { error: messageOf(error) || "Something went wrong" });
    }
  }

  return [
    route({
      method: "POST",
      path: "/api/queues/check",
      body: z.object({ taskId: TaskId }),
      handle: ({ res, body }) => answer(res, async () => ({ plan: await queues.check(body.taskId) })),
    }),
    route({
      method: "POST",
      path: "/api/queues",
      body: z.object({ cwd: z.string().min(1), taskId: TaskId, mode: z.enum(FINISH_MODES), slots: z.number().int().min(1).max(MAX_SLOTS).default(DEFAULT_SLOTS), session: Picks.default({ provider: "", model: "", effort: "" }), main: Picks.optional(), tickets: z.record(z.string(), z.object({ picks: Picks.optional(), prompt: z.string().optional() })).default({}) }),
      handle: ({ res, body }) => answer(res, async () => ({ queue: await queues.start({ cwd: canonicalCwd(body.cwd), taskId: body.taskId, mode: body.mode, slots: body.slots, picks: body.session, main: body.main, tickets: body.tickets }) })),
    }),
    route({
      method: "POST",
      path: "/api/queues/end",
      body: z.object({ id: z.string() }),
      handle: ({ res, body }) => answer(res, () => (queues.end(body.id), { ok: true })),
    }),
    route({
      method: "POST",
      path: "/api/queues/retry",
      body: z.object({ id: z.string(), ticket: z.string() }),
      handle: ({ res, body }) => answer(res, () => (queues.retry(body.id, body.ticket), { ok: true })),
    }),
  ];
}
