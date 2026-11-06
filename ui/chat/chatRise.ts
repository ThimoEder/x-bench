import { useState } from "react";

// Whether an opening chat's messages rise in, on until turned off in Settings.
const CHAT_RISE_KEY = "x-bench-chat-rise";
// The choice made on this page, which holds when storage cannot keep it.
let chosen: boolean | null = null;

export function chatRiseOn(): boolean {
  if (chosen !== null) return chosen;
  try {
    return localStorage.getItem(CHAT_RISE_KEY) !== "off";
  } catch {
    return true;
  }
}

export function useChatRise(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(chatRiseOn);
  function choose(next: boolean) {
    chosen = next;
    setOn(next);
    try {
      localStorage.setItem(CHAT_RISE_KEY, next ? "on" : "off");
    } catch {
      // Kept for this page only.
    }
  }
  return [on, choose];
}
