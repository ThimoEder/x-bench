// The app's own settings the host acts on: keeping the Mac awake, and the experimental plan tool.

import { z } from "zod";
import { messageOf, sendJson } from "../http.ts";
import type { Host } from "../app.ts";
import { route, type Route } from "../router.ts";

export function appSettingRoutes(host: Host): Route[] {
  return [
    route({
      method: "POST",
      path: "/api/settings",
      body: z.object({ keepAwake: z.boolean("must be true or false").optional(), planTool: z.boolean("must be true or false").optional() }),
      handle({ res, body }) {
        try {
          const settings = host.appSettings.save({
            ...(body.keepAwake === undefined ? {} : { keepAwake: body.keepAwake }),
            ...(body.planTool === undefined ? {} : { planTool: body.planTool }),
          });
          host.followAppSettings();
          sendJson(res, 200, { settings });
        } catch (error) {
          sendJson(res, 500, { error: messageOf(error) });
        }
      },
    }),
  ];
}
