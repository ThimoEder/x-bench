// The app's own settings the host acts on: keeping the Mac awake.

import { z } from "zod";
import { messageOf, sendJson } from "../http.ts";
import type { Host } from "../app.ts";
import { route, type Route } from "../router.ts";

export function appSettingRoutes(host: Host): Route[] {
  return [
    route({
      method: "POST",
      path: "/api/settings",
      body: z.object({ keepAwake: z.boolean("must be true or false") }),
      handle({ res, body }) {
        try {
          const settings = host.appSettings.save({ keepAwake: body.keepAwake });
          host.followAppSettings();
          sendJson(res, 200, { settings });
        } catch (error) {
          sendJson(res, 500, { error: messageOf(error) });
        }
      },
    }),
  ];
}
