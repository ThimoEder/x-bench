// Voice routes: the speech model status, transcription, and a quieter Mac while the user dictates.

import { z } from "zod";
import { MAX_WAV_BYTES, readAudio } from "./voice.ts";
import { messageOf, sendJson } from "../http.ts";
import type { Host } from "../app.ts";
import { route, type Route } from "../router.ts";

export function voiceRoutes(host: Host): Route[] {
  const { voice, quietVolume } = host;

  return [
    {
      method: "GET",
      path: "/api/voice",
      handle({ res }) {
        sendJson(res, 200, voice.status());
      },
    },
    {
      method: "POST",
      path: "/api/voice/download",
      handle({ res }) {
        // The page polls GET /api/voice for progress and the outcome.
        voice.prepare().catch(() => {});
        sendJson(res, 200, voice.status());
      },
    },
    {
      method: "POST",
      path: "/api/voice/cancel",
      handle({ res }) {
        voice.cancel();
        sendJson(res, 200, voice.status());
      },
    },
    {
      method: "DELETE",
      path: "/api/voice",
      async handle({ res }) {
        if (!(await voice.remove())) {
          sendJson(res, 409, { error: "The speech model is in use. Try again when it is done." });
          return;
        }
        sendJson(res, 200, voice.status());
      },
    },
    {
      method: "POST",
      path: "/api/transcribe",
      raw: true,
      contentType: "audio/wav",
      maxBody: MAX_WAV_BYTES,
      async handle({ req, res }) {
        const audio = await readAudio(req);
        if (!audio) {
          sendJson(res, 413, { error: "Recording is too long" });
          return;
        }
        try {
          sendJson(res, 200, { text: await voice.transcribe(audio) });
        } catch (error) {
          sendJson(res, 500, { error: messageOf(error) || "Transcription failed" });
        }
      },
    },
    route({
      method: "POST",
      path: "/api/quiet-volume",
      body: z.object({ quiet: z.boolean().optional(), take: z.string().optional(), level: z.number().optional() }),
      async handle({ res, body }) {
        const take = body.take || "page";
        await (body.quiet === true ? quietVolume.lower(take, body.level) : quietVolume.restore(take));
        sendJson(res, 200, { ok: true });
      },
    }),
  ];
}
