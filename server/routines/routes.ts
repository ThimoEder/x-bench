// Routine routes: create, change, delete and run routines.

import { z } from "zod";
import { messageOf, sendJson, statusOf } from "../http.ts";
import type { Host } from "../app.ts";
import { route, type Route } from "../router.ts";
import { RoutineChange } from "./routines.ts";

const RoutineId = z.object({ id: z.string() });

export function routineRoutes(host: Host): Route[] {
  const { routines, routineEdits } = host;

  function answer(res: Parameters<Route["handle"]>[0]["res"], error: unknown) {
    sendJson(res, statusOf(error, 500), { error: messageOf(error) || "Something went wrong" });
  }

  return [
    route({
      method: "POST",
      path: "/api/routines",
      body: RoutineChange,
      handle({ res, body }) {
        try {
          sendJson(res, 200, { routine: routineEdits.create(body) });
        } catch (error) {
          answer(res, error);
        }
      },
    }),
    route({
      method: "POST",
      path: "/api/routines/update",
      body: RoutineChange.extend(RoutineId.shape),
      handle({ res, body }) {
        try {
          sendJson(res, 200, { routine: routineEdits.update(body.id, body) });
        } catch (error) {
          answer(res, error);
        }
      },
    }),
    route({
      method: "POST",
      path: "/api/routines/delete",
      body: RoutineId,
      handle({ res, body }) {
        try {
          routineEdits.remove(body.id);
          sendJson(res, 200, { ok: true });
        } catch (error) {
          answer(res, error);
        }
      },
    }),
    route({
      method: "POST",
      path: "/api/routines/run",
      body: RoutineId,
      async handle({ res, body }) {
        try {
          sendJson(res, 200, await routines.runNow(body.id));
        } catch (error) {
          answer(res, error);
        }
      },
    }),
  ];
}
