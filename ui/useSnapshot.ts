import { useEffect, useEffectEvent, useRef, useState } from "react";
import { REMOTE_OFF, type Snapshot, type Surface } from "../server/snapshot.ts";
import { noteSnapshot } from "./board/boardCache.ts";
import { remotePage, withToken } from "./launchToken.ts";
import { ONBOARDED_KEY } from "./onboarding/Onboarding.tsx";
import { shareEqual } from "./shareEqual.ts";
import { storedFlag } from "./stored.ts";

// The page's first snapshot, before the host publishes: no usage or composer yet, and no platform.
export type PageSnapshot = Omit<Snapshot, "usage" | "composer" | "platform">
  & Partial<Pick<Snapshot, "usage" | "composer">>
  & { platform: Snapshot["platform"] | "" };

const empty: PageSnapshot = {
  error: null,
  cwd: "",
  platform: "",
  open: [],
  sessions: [],
  projects: [],
  chats: [],
  surface: "builder",
  working: [],
  attention: [],
  unread: [],
  notices: [],
  tickets: { boards: [], bySession: {} },
  providers: [],
  browser: { available: false, tabs: [], active: {}, focus: { count: 0, owner: null } },
  deviceFocus: { count: 0, owner: null, device: null },
  terminals: {},
  remote: REMOTE_OFF,
  routines: { scheduler: { here: false, takesPart: false, port: null }, desktop: false, list: [] },
  app: { desktop: false, keepAwake: false },
  reveal: null,
};

// The host is the only sender on /api/events: a whole snapshot first, then only the fields that changed.
function isSnapshot(value: unknown): value is Snapshot {
  return typeof value === "object" && value !== null;
}

function rememberOnboarded() {
  try {
    localStorage.setItem(ONBOARDED_KEY, "1");
  } catch {
    // Private mode can block storage. Onboarding stays closed until the app reloads.
  }
}

export function useSnapshot(call: (path: string, body?: unknown) => Promise<unknown>) {
  const [snapshot, setSnapshot] = useState<PageSnapshot>(empty);
  const [ready, setReady] = useState(false);
  const [live, setLive] = useState(true);
  const [onboarded, setOnboarded] = useState(() => remotePage() || storedFlag(ONBOARDED_KEY, false));
  // The surface the toggle asked for. Until a snapshot shows it, the desk keeps the panes of the
  // surface being left unmounted, so they don't poll a session the host has just parked.
  const [surfaceGoal, setSurfaceGoal] = useState<Surface | null>(null);
  const surfacePosted = useRef(false);
  const sawSurface = useRef(false);

  // The stream retries a dropped connection by itself, but an HTTP error ends it for good: ngrok answers with one
  // while the host restarts. iOS also suspends a page in the background and may leave a dead connection open. So
  // on a page through remote access, a stream that ended opens again after a growing wait, and so does one on a
  // page back after more than five seconds hidden.
  useEffect(() => {
    const remote = remotePage();
    let source: EventSource | null = null;
    let retry: number | undefined;
    let firstSnapshot = true;
    let wait = 3000;
    let hiddenAt = 0;
    let current: PageSnapshot = empty;
    function open() {
      window.clearTimeout(retry);
      source?.close();
      const next = new EventSource(withToken("/api/events?changes=1"));
      source = next;
      next.onmessage = (event) => {
        const data: unknown = JSON.parse(event.data);
        if (!isSnapshot(data)) return;
        // The first event after connecting is the whole snapshot. The rest carry only the fields that changed.
        current = { ...current, ...data };
        // Onboarding is for a first launch only: a host that already has chats marks it done for good.
        if (firstSnapshot && (current.chats.length || current.projects.some((project) => project.sessions.length))) {
          rememberOnboarded();
          setOnboarded(true);
        }
        firstSnapshot = false;
        const surface = current.surface;
        setSurfaceGoal((goal) => (goal === surface ? null : goal));
        // Unchanged parts keep their identity, so a chunk re-renders only what it changed.
        const whole = current;
        setSnapshot((previous) => shareEqual(previous, whole));
        setReady(true);
        setLive(true);
        wait = 3000;
      };
      next.onerror = () => {
        setLive(false);
        if (!remote || next.readyState !== EventSource.CLOSED || source !== next) return;
        retry = window.setTimeout(open, wait);
        wait = Math.min(wait * 2, 60_000);
      };
    }
    function onVisibility() {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
        return;
      }
      if (hiddenAt && Date.now() - hiddenAt > 5000) open();
      hiddenAt = 0;
    }
    open();
    if (remote) document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearTimeout(retry);
      document.removeEventListener("visibilitychange", onVisibility);
      source?.close();
    };
  }, []);

  // The launch screen in index.html fades out over the app once the first snapshot is in.
  useEffect(() => {
    const launch = document.getElementById("launch");
    if (!ready || !launch) return;
    launch.classList.add("gone");
    window.setTimeout(() => launch.remove(), 400);
  }, [ready]);

  const postSurface = useEffectEvent((mode: string) => call("/api/surface", { mode }));
  useEffect(() => {
    if (!ready || surfacePosted.current) return;
    surfacePosted.current = true;
    let saved = "";
    try {
      saved = localStorage.getItem("x-bench-surface") || "";
    } catch {
      // The server surface still applies for this visit.
    }
    if ((saved === "chat" || saved === "builder") && saved !== (snapshot.surface || "builder")) {
      postSurface(saved).catch(() => {});
    }
  }, [ready, snapshot.surface]);

  useEffect(() => {
    if (!ready) return;
    if (!sawSurface.current) {
      sawSurface.current = true;
      return;
    }
    const mode = snapshot.surface;
    if (mode !== "builder" && mode !== "chat") return;
    try {
      localStorage.setItem("x-bench-surface", mode);
    } catch {
      // The switch still applies for this visit.
    }
  }, [ready, snapshot.surface]);

  useEffect(() => {
    noteSnapshot(snapshot.tickets, [...snapshot.chats, ...snapshot.projects.flatMap((project) => project.sessions)], snapshot.working);
  }, [snapshot.tickets, snapshot.chats, snapshot.projects, snapshot.working]);

  function markOnboarded() {
    setOnboarded(true);
    rememberOnboarded();
  }

  function requestSurface(mode: Surface) {
    setSurfaceGoal(mode);
    return call("/api/surface", { mode }).catch((failure: unknown) => {
      setSurfaceGoal(null);
      throw failure;
    });
  }

  const switching = surfaceGoal !== null && surfaceGoal !== snapshot.surface;
  const chatting = (switching ? surfaceGoal : snapshot.surface) === "chat";
  return { snapshot, ready, live, onboarded, markOnboarded, switching, chatting, requestSurface };
}
