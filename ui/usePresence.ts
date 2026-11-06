import { useEffect, useState } from "react";

// For a pane that comes and goes with a slide: mounted stays true for ms after show turns false, so the pane can
// slide out, and shown turns true a frame after mounting, so a pane that just came in starts closed and slides open.
// With ms 0 the pane leaves in the same render.
export function usePresence(show: boolean, ms: number): { mounted: boolean; shown: boolean } {
  const [mounted, setMounted] = useState(show);
  const [shown, setShown] = useState(show);
  useEffect(() => {
    if (!show) {
      setShown(false);
      const timer = setTimeout(() => setMounted(false), ms);
      return () => clearTimeout(timer);
    }
    setMounted(true);
    // Two frames: the first paints the pane closed, the second opens it.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setShown(true));
    });
    return () => cancelAnimationFrame(frame);
  }, [show, ms]);
  return { mounted: show || (ms > 0 && mounted), shown: show && shown };
}
