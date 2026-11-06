import { useSyncExternalStore } from "react";
import type { PresentedItem, PresentedPermission, PresentedToolItem } from "../../../server/present.ts";

// What the person answered to a card, shown in the thread where the card was.
export interface Receipt {
  id: string;
  // The provider stretch it was answered in, since each stretch numbers its items anew.
  stretch: number;
  // The transcript item the receipt follows.
  after: string;
  icon: "check" | "close" | "plan";
  label: string;
  // The command, file or site it was about, or the answer.
  detail: string;
  code: boolean;
}

export type ReceiptText = Omit<Receipt, "id" | "stretch" | "after">;

export interface AnsweredSession {
  transcript: readonly PresentedItem[];
  stretches?: readonly unknown[];
  pendingPermission?: Pick<PresentedPermission, "toolCallId"> | null;
}

// shortcut: receipts live in this page only, so a reload or another window shows none. Keep them with the session on the host to show them everywhere.
const bySession = new Map<string, Receipt[]>();
const listeners = new Set<() => void>();
const NONE: Receipt[] = [];

// The row of the tool call whose permission waits. Its card stands in for it.
export function askingRow(session: AnsweredSession) {
  const id = session.pendingPermission?.toolCallId;
  return id ? session.transcript.find((item): item is PresentedToolItem => item.type === "tool" && item.toolCallId === id) : undefined;
}

// Places the receipt after the last item above the card that stays: a waiting steered message can still be deleted.
export function addReceipt(sessionId: string, session: AnsweredSession, text: ReceiptText) {
  const asking = askingRow(session);
  const after = session.transcript.findLast((item) => item !== asking && !(item.type === "user" && item.delivery?.state === "waiting"))?.id ?? "";
  const stretch = session.stretches?.length ?? 0;
  const list = bySession.get(sessionId) ?? [];
  bySession.set(sessionId, [...list, { ...text, stretch, after, id: `${stretch}:${after}:${list.length}` }]);
  for (const listener of listeners) listener();
}

export function useReceipts(sessionId: string): Receipt[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => bySession.get(sessionId) ?? NONE,
  );
}

// A stretch's receipts by the item each follows.
export function receiptsAfter(list: readonly Receipt[], stretch: number) {
  const byItem = new Map<string, Receipt[]>();
  for (const receipt of list) if (receipt.stretch === stretch) byItem.set(receipt.after, [...(byItem.get(receipt.after) ?? []), receipt]);
  return byItem;
}
