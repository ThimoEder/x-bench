import { useEffect, useSyncExternalStore } from "react";
import type Katex from "katex";

// KaTeX and its stylesheet load with the first math the page shows, as their own chunk, so the page's
// main script stays small and a page without math never parses them.
let katex: typeof Katex | null = null;
let loading: Promise<void> | null = null;
const waiting = new Set<() => void>();

export function loadMath(): Promise<void> {
  loading ??= Promise.all([import("katex"), import("katex/dist/katex.min.css")]).then(([module]) => {
    katex = module.default;
    for (const wake of waiting) wake();
  });
  return loading;
}

// True once KaTeX is loaded. The first caller starts the load.
export function useMathReady(): boolean {
  const ready = useSyncExternalStore(subscribe, isReady);
  useEffect(() => {
    if (!ready) loadMath().catch(() => {});
  }, [ready]);
  return ready;
}

function subscribe(wake: () => void) {
  waiting.add(wake);
  return () => {
    waiting.delete(wake);
  };
}

function isReady() {
  return katex != null;
}

// KaTeX output for one expression, cached because a streaming reply renders the same math on every tick.
// trust: false keeps out \href, \includegraphics and the \html* commands, so the markup has no links,
// pictures, classes or ids from the reply: such a command shows as its name, in the error colour. A parse
// error comes back as KaTeX's error span, which shows the expression's source. Any other failure, or KaTeX not loaded yet, is null, and the caller shows the source.
const cache = new Map<string, string | null>();
const CACHE_SIZE = 500;

export function renderMath(tex: string, display: boolean): string | null {
  if (!katex) return null;
  const key = `${display ? "D" : "I"}${tex}`;
  if (cache.has(key)) return cache.get(key) ?? null;
  let html: string | null;
  try {
    html = katex.renderToString(tex, {
      displayMode: display,
      throwOnError: false,
      trust: false,
      strict: "ignore",
      errorColor: "var(--danger)",
      maxSize: 20,
      maxExpand: 1000,
    });
  } catch {
    html = null;
  }
  if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value ?? "");
  cache.set(key, html);
  return html;
}
