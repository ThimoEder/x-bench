import { useCallback, useEffect, useState } from "react";

// How a sidebar row shows the provider its chat runs on: its logo, its name as a tag, or not at all.
export type SidebarProvider = "icon" | "label" | "none";

export const SIDEBAR_PROVIDER_KEY = "x-bench-sidebar-provider";
export const SIDEBAR_PROVIDERS: { id: SidebarProvider; name: string }[] = [
  { id: "icon", name: "Icon" },
  { id: "label", name: "Label" },
  { id: "none", name: "None" },
];

// Tells the sidebar and the settings page that the choice changed.
const EVENT = "x-bench-sidebar-provider";
// The choice made in this window, which holds for the visit even when storage refuses it.
let chosen: SidebarProvider | null = null;

export function readSidebarProvider(storage: Pick<Storage, "getItem"> | null | undefined = globalThis.localStorage): SidebarProvider {
  let stored: unknown = null;
  try {
    stored = storage?.getItem(SIDEBAR_PROVIDER_KEY) ?? null;
  } catch {
    stored = null;
  }
  return stored === "label" || stored === "none" ? stored : "icon";
}

export function persistSidebarProvider(choice: SidebarProvider, storage: Pick<Storage, "setItem"> | null | undefined = globalThis.localStorage) {
  try {
    storage?.setItem(SIDEBAR_PROVIDER_KEY, choice);
  } catch {
    // The choice still applies for this visit.
  }
}

export function useSidebarProvider(): [SidebarProvider, (next: SidebarProvider) => void] {
  const [choice, setChoice] = useState(() => chosen ?? readSidebarProvider());

  useEffect(() => {
    const onChange = () => setChoice(chosen ?? readSidebarProvider());
    window.addEventListener(EVENT, onChange);
    return () => window.removeEventListener(EVENT, onChange);
  }, []);

  const choose = useCallback((next: SidebarProvider) => {
    chosen = next;
    persistSidebarProvider(next);
    setChoice(next);
    window.dispatchEvent(new Event(EVENT));
  }, []);

  return [choice, choose];
}
