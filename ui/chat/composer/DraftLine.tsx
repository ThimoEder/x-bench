import { useEffect, useState } from "react";

// How long the old line takes to blur away (line-blur-out in styles.css).
const leaveMs = 300;
const welcomeText = "Welcome to X Bench";
// How long after the pane appears the welcome gives way to the folder line.
const welcomeMs = 1800;
// The welcome plays once per launch, even if the pane is shown again later.
let welcomed = false;

interface Shown {
  text: string;
  key: number;
  leaving: string | null;
}

export interface DraftLineProps {
  text: string;
  // The app opened on this pane: say welcome first.
  welcome?: boolean;
}

// A new session's line. It plays the sidebar's title reveal when it appears.
// When the text changes, the old line blurs away first and the new one reveals after it.
// The motion and the welcome's timer start once the page has drawn two frames.
// A hidden page draws none (the desktop window can open behind another one),
// and the first frame after load is slow, so starting earlier would play the
// reveal before it is seen, or squeeze it into the few frames after that long one.
export function DraftLine({ text, welcome = false }: DraftLineProps) {
  const [greeting, setGreeting] = useState(() => welcome && !welcomed);
  const [live, setLive] = useState(false);
  const target = greeting ? welcomeText : text;
  const [shown, setShown] = useState<Shown>({ text: target, key: 0, leaving: null });
  if (shown.text !== target) setShown({ text: target, key: shown.key + 1, leaving: shown.text });

  useEffect(() => {
    let frame = window.requestAnimationFrame(() => {
      frame = window.requestAnimationFrame(() => setLive(true));
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (greeting) welcomed = true;
  }, [greeting]);

  useEffect(() => {
    if (!greeting || !live) return undefined;
    const timer = window.setTimeout(() => setGreeting(false), welcomeMs);
    return () => window.clearTimeout(timer);
  }, [greeting, live]);

  useEffect(() => {
    if (shown.leaving === null) return undefined;
    const timer = window.setTimeout(() => setShown((current) => ({ ...current, leaving: null })), leaveMs + 100);
    return () => window.clearTimeout(timer);
  }, [shown.leaving, shown.key]);

  return (
    <div className={live ? "draft-line" : "draft-line is-waiting"}>
      {shown.leaving !== null ? (
        <p key={`leaving-${shown.key}`} className="empty is-leaving" aria-hidden="true">
          {shown.leaving}
        </p>
      ) : null}
      <p key={shown.key} className={shown.key > 0 ? "empty after-leave" : "empty"}>
        {shown.text}
      </p>
    </div>
  );
}
