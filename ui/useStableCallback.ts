import { useCallback, useLayoutEffect, useRef } from "react";

// A function that keeps its identity from render to render and runs the latest fn, so a memoised child
// is not re-rendered for a new closure. For handlers and effects, not for calling during render.
export function useStableCallback<Args extends unknown[], Result>(fn: (...args: Args) => Result): (...args: Args) => Result {
  const latest = useRef(fn);
  useLayoutEffect(() => {
    latest.current = fn;
  });
  return useCallback((...args: Args) => latest.current(...args), []);
}
