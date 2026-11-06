import { useState } from "react";

export function MarkdownToggle({ off, preview, onChange }: { off: string; preview: boolean; onChange: (preview: boolean) => void }) {
  return (
    <span className="md-toggle" role="group" aria-label="View">
      <button type="button" aria-pressed={!preview} onClick={() => onChange(false)}>
        {off}
      </button>
      <button type="button" aria-pressed={preview} onClick={() => onChange(true)}>
        Preview
      </button>
    </span>
  );
}

export function useMarkdownPreview(key: string, fallback: boolean): [boolean, (preview: boolean) => void] {
  const [preview, setPreview] = useState(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored == null ? fallback : stored === "1";
    } catch {
      return fallback;
    }
  });
  function choose(next: boolean) {
    setPreview(next);
    try {
      localStorage.setItem(key, next ? "1" : "0");
    } catch {
      // Private mode can block storage.
    }
  }
  return [preview, choose];
}
