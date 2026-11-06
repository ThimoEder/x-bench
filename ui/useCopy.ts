import { useEffect, useRef, useState } from "react";

// Copies text to the clipboard. copied is true for a moment after it worked, and false again once the text changes.
export function useCopy(text: string): [copied: boolean, copy: () => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef(0);

  useEffect(() => {
    setCopied(false);
    return () => window.clearTimeout(timer.current);
  }, [text]);

  function copy() {
    const write = navigator.clipboard?.writeText?.(text);
    if (!write) return;
    write
      .then(() => {
        setCopied(true);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), 1600);
      })
      .catch(() => {});
  }

  return [copied, copy];
}
