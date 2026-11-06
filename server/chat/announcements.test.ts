import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { presentAnnouncements, readServiceNotices } from "./announcements.ts";

const outage = {
  id: "outage-2026-09-21-data-hall",
  message: "A datacenter incident is affecting all Grok models. The team is investigating.",
  severity: "critical",
  title: "We're currently experiencing issues serving our models",
  cta: { label: "Status page", url: "https://status.x.ai/" },
  dismissible: true,
};

test("a service outage becomes a short notice", () => {
  assert.deepEqual(
    presentAnnouncements({
      settings: {
        announcements: [outage, { id: "grok-4.7", severity: "info", title: "Grok 4.7 is here!", message: "Select it." }],
      },
    }),
    [
      {
        id: "outage-2026-09-21-data-hall",
        severity: "critical",
        title: "We're currently experiencing issues serving our models",
        message: "A datacenter incident is affecting all Grok models. The team is investigating.",
        url: "https://status.x.ai/",
        link: "Status page",
      },
    ],
  );
});

test("expired, empty, and non-http notices stay off the composer", () => {
  const now = Date.parse("2026-09-22T12:00:00Z");
  assert.deepEqual(
    presentAnnouncements(
      {
        announcements: [
          { ...outage, expires_at: "2026-09-22T11:00:00Z" },
          { id: "warn", severity: "warning", title: "  Slow replies  ", message: "  Some models are delayed.  ", cta: { url: "javascript:alert(1)" } },
          { severity: "critical", title: "   ", message: "" },
          null,
        ],
      },
      now,
    ),
    [
      {
        id: "warn",
        severity: "warning",
        title: "Slow replies",
        message: "Some models are delayed.",
        url: "",
        link: "",
      },
    ],
  );
});

test("a missing settings cache hides the notice", () => {
  assert.deepEqual(readServiceNotices(path.join(os.tmpdir(), "missing-grok-settings.json")), []);
});

test("the settings cache payload is unwrapped", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "grok-notices-"));
  const file = path.join(dir, "settings_cache.json");
  writeFileSync(file, JSON.stringify({ payload: JSON.stringify({ settings: { announcements: [outage] } }) }));
  assert.equal(readServiceNotices(file)[0]?.id, outage.id);
});
