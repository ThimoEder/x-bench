import { useState } from "react";
import type { ServiceNotice } from "../server/snapshot.ts";
import { CloseIcon } from "./icons.tsx";

const HIDDEN_KEY = "x-bench-hidden-notices";

function storedIds(key: string): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(key) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw.filter((id: unknown): id is string => typeof id === "string" && id !== "").slice(-40);
  } catch {
    return [];
  }
}

export function useNotices(all: ServiceNotice[] | undefined) {
  const [hidden, setHidden] = useState(() => storedIds(HIDDEN_KEY));

  function dismissNotice(id: string) {
    if (!id) return;
    setHidden((current) => {
      if (current.includes(id)) return current;
      const next = [...current, id].slice(-40);
      try {
        localStorage.setItem(HIDDEN_KEY, JSON.stringify(next));
      } catch {
        // The notice still stays closed for this visit.
      }
      return next;
    });
  }

  return { notices: (all ?? []).filter((notice) => !hidden.includes(notice.id)), dismissNotice };
}

export interface ServiceNoticesProps {
  notices?: ServiceNotice[] | null;
  onDismiss?: (id: string) => void;
}

export function ServiceNotices({ notices, onDismiss }: ServiceNoticesProps) {
  if (!notices?.length) return null;
  return (
    <div className="service-notices">
      {notices.map((notice) => (
        <div key={notice.id} className="service-notice" data-testid="service-notice" role="status">
          <div className="service-notice-copy">
            <p className="service-notice-title">{notice.title}</p>
            {notice.message || notice.url ? (
              <p className="service-notice-body">
                {notice.message}
                {notice.url ? (
                  <>
                    {notice.message ? " " : null}
                    <a href={notice.url} target="_blank" rel="noreferrer">
                      {notice.link || "Status"}
                    </a>
                  </>
                ) : null}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            className="service-notice-close"
            aria-label={`Dismiss: ${notice.title}`}
            onClick={() => onDismiss?.(notice.id)}
          >
            <CloseIcon />
          </button>
        </div>
      ))}
    </div>
  );
}
