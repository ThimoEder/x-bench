// A board task, list or label id: a positive integer, a 24-character hex id in lower case, or a
// Jira issue key such as PROJ-123 in upper case.
export type TicketId = number | string;

const HEX_ID = /^[0-9a-f]{24}$/i;
const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9_]{0,254}-[1-9]\d{0,17}$/;

export function ticketId(value: unknown): TicketId | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  const text = String(value ?? "").trim();
  if (/^[1-9]\d*$/.test(text)) {
    const number = Number(text);
    if (Number.isSafeInteger(number) && number > 0) return number;
  }
  if (HEX_ID.test(text)) return text.toLowerCase();
  if (ISSUE_KEY.test(text)) return text.toUpperCase();
  return null;
}

export function isHexId(value: unknown): value is string {
  return typeof value === "string" && HEX_ID.test(value);
}

export function isIssueKey(value: unknown): value is string {
  return typeof value === "string" && ISSUE_KEY.test(value);
}
