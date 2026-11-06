import type { ReactNode } from "react";
import { CaretIcon } from "./icons.tsx";
import { pages } from "./projectRows.ts";

// The fade on the row that ends a page, which reveals the next page.
export interface Paging {
  fade: boolean;
  revealed: boolean;
  extra: number;
  limit: number;
  reveal: () => void;
}

interface PageState {
  extraPages: Record<string, number>;
  reveal: (key: string, page: number) => void;
}

export function renderPages<T>(key: string, items: T[], limit: number, state: PageState, render: (item: T, paging: Paging) => ReactNode) {
  const shown = state.extraPages[key] ?? 0;
  const list = pages(items, limit, shown);
  const renderPage = (page: T[], index: number) => {
    const extra = items.length - limit * (index + 1);
    return page.map((item, row) =>
      render(item, { fade: extra > 0 && row === page.length - 1, revealed: shown > index, extra, limit, reveal: () => state.reveal(key, index + 1) }),
    );
  };
  return (
    <>
      {list.length > 0 ? renderPage(list[0]!.items, 0) : null}
      {list.slice(1).map((page, offset) => (
        <li key={`more-${offset + 1}`} className={page.revealed ? "project-more" : "project-more collapsed"} inert={page.revealed ? undefined : true}>
          <ul>{renderPage(page.items, offset + 1)}</ul>
        </li>
      ))}
    </>
  );
}

function moreLabel(extra: number, limit: number) {
  const next = Math.min(extra, limit);
  return `Show ${next} more ${next === 1 ? "chat" : "chats"}`;
}

export function PageFade({ paging }: { paging: Paging | undefined }) {
  if (!paging?.fade) return null;
  return (
    <button
      type="button"
      className={paging.revealed ? "preview-expand is-open" : "preview-expand"}
      aria-label={moreLabel(paging.extra, paging.limit)}
      aria-hidden={paging.revealed || undefined}
      tabIndex={paging.revealed ? -1 : 0}
      onClick={(event) => {
        event.stopPropagation();
        paging.reveal();
      }}
    >
      <CaretIcon />
    </button>
  );
}
