import { useCallback, useRef, useState } from "react";
import { apiFetch, type CallOptions } from "./launchToken.ts";
import { requestSessionId, staleSessionFailure } from "./dock/deskView.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// A failed call answers { error }.
function replyError(data: unknown): string {
  return (isRecord(data) && typeof data.error === "string" && data.error) || "";
}

export function useCall() {
  const [notice, setNotice] = useState("");
  // The banner errors quiet polls put up, by poll, so the same poll's next success can take its own error down.
  const pollErrors = useRef(new Map<string, string>());

  const call = useCallback(async (path: string, body?: unknown, method = "POST", options: CallOptions = {}): Promise<unknown> => {
    const poll = `${method} ${path} ${JSON.stringify(body ?? {})}`;
    if (!options.quiet && !options.silent) {
      pollErrors.current.clear();
      setNotice("");
    }
    const response = await apiFetch(path, {
      method,
      headers: method === "GET" || method === "HEAD" ? undefined : { "content-type": "application/json" },
      body: method === "GET" || method === "HEAD" ? undefined : JSON.stringify(body ?? {}),
    });
    const data: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = replyError(data) || "Request failed";
      if (!options.silent && !staleSessionFailure(message, requestSessionId(path, body))) {
        setNotice(message);
        if (options.quiet) pollErrors.current.set(poll, message);
      }
      throw Object.assign(new Error(message), { reply: data, status: response.status });
    }
    const recovered = options.quiet ? pollErrors.current.get(poll) : undefined;
    if (recovered !== undefined) {
      pollErrors.current.delete(poll);
      // Only this poll's own error comes down: not a newer one, and not one another poll still has.
      if (![...pollErrors.current.values()].includes(recovered)) setNotice((current) => (current === recovered ? "" : current));
    }
    return data;
  }, []);

  const clearNotice = useCallback(() => {
    pollErrors.current.clear();
    setNotice("");
  }, []);

  return { call, notice, setNotice, clearNotice };
}
