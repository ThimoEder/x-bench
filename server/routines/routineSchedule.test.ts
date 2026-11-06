import assert from "node:assert/strict";
import test from "node:test";
import { describeSchedule, dueSlot, MISSED, nextSlot, parseSchedule, previousSlot, runLabel, shortWhen, slotKey } from "./routineSchedule.ts";

// The clock changes below are Berlin's: spring forward on 29 March 2026 at 02:00, fall back on 25 October at 03:00.
// Node reads TZ again when it changes.
process.env.TZ = "Europe/Berlin";

const local = (text: string) => new Date(text);
const key = (date: Date | null) => (date ? slotKey(date) : null);

test("a schedule from the page is checked field by field", () => {
  assert.deepEqual(parseSchedule({ every: "manual", at: "09:00" }), { every: "manual" });
  assert.deepEqual(parseSchedule({ every: "hours", hours: 6, minute: 15 }), { every: "hours", hours: 6, minute: 15 });
  assert.deepEqual(parseSchedule({ every: "hours", hours: 1 }), { every: "hours", hours: 1, minute: 0 });
  assert.equal(parseSchedule({ every: "hours", hours: 5, minute: 0 }), null, "5 does not divide the day");
  assert.equal(parseSchedule({ every: "hours", hours: 1, minute: 60 }), null);
  assert.deepEqual(parseSchedule({ every: "day", at: "09:00", days: [5, 1, 3] }), { every: "day", at: "09:00", days: [1, 3, 5] });
  assert.equal(parseSchedule({ every: "day", at: "9:00", days: [1] }), null);
  assert.equal(parseSchedule({ every: "day", at: "09:00", days: [] }), null);
  assert.equal(parseSchedule({ every: "day", at: "09:00", days: [7] }), null);
  assert.equal(parseSchedule({ every: "day", at: "09:00", days: [1, 1] }), null);
  assert.deepEqual(parseSchedule({ every: "once", at: "2026-10-04T18:00" }), { every: "once", at: "2026-10-04T18:00" });
  assert.equal(parseSchedule({ every: "once", at: "2026-02-30T18:00" }), null);
  assert.equal(parseSchedule({ every: "weekly" }), null);
  assert.equal(parseSchedule(null), null);
});

test("a daily schedule runs on its days at its time", () => {
  const weekdays = { every: "day", at: "09:00", days: [1, 2, 3, 4, 5] } as const;
  // Saturday 3 October 2026, 14:00.
  const saturday = local("2026-10-03T14:00:00");
  assert.equal(key(previousSlot({ ...weekdays, days: [...weekdays.days] }, saturday)), "2026-10-02T09:00");
  assert.equal(key(nextSlot({ ...weekdays, days: [...weekdays.days] }, saturday)), "2026-10-05T09:00");
  const daily = { every: "day" as const, at: "09:00", days: [0, 1, 2, 3, 4, 5, 6] };
  assert.equal(key(previousSlot(daily, local("2026-10-03T09:00:00"))), "2026-10-03T09:00", "the slot itself counts as passed");
  assert.equal(key(nextSlot(daily, local("2026-10-03T09:00:00"))), "2026-10-04T09:00");
  assert.equal(key(previousSlot(daily, local("2026-10-03T08:59:00"))), "2026-10-02T09:00");
});

test("every N hours counts from midnight", () => {
  const six = { every: "hours" as const, hours: 6, minute: 15 };
  assert.equal(key(previousSlot(six, local("2026-10-03T14:00:00"))), "2026-10-03T12:15");
  assert.equal(key(nextSlot(six, local("2026-10-03T14:00:00"))), "2026-10-03T18:15");
  assert.equal(key(previousSlot(six, local("2026-10-03T00:10:00"))), "2026-10-02T18:15");
  assert.equal(key(nextSlot(six, local("2026-10-03T23:00:00"))), "2026-10-04T00:15");
  const hourly = { every: "hours" as const, hours: 1, minute: 0 };
  assert.equal(key(nextSlot(hourly, local("2026-10-03T14:00:00"))), "2026-10-03T15:00");
});

test("once runs at its moment, and manual never does", () => {
  const once = { every: "once" as const, at: "2026-10-04T18:00" };
  assert.equal(previousSlot(once, local("2026-10-04T17:59:00")), null);
  assert.equal(key(nextSlot(once, local("2026-10-04T17:59:00"))), "2026-10-04T18:00");
  assert.equal(key(previousSlot(once, local("2026-10-05T10:00:00"))), "2026-10-04T18:00");
  assert.equal(nextSlot(once, local("2026-10-05T10:00:00")), null);
  assert.equal(previousSlot({ every: "manual" }, local("2026-10-05T10:00:00")), null);
  assert.equal(nextSlot({ every: "manual" }, local("2026-10-05T10:00:00")), null);
});

test("the clock changes neither skip nor repeat a run", () => {
  const night = { every: "day" as const, at: "02:30", days: [0, 1, 2, 3, 4, 5, 6] };
  // 02:30 does not exist on 29 March. The run comes at 03:30 that day.
  const spring = nextSlot(night, local("2026-03-29T01:00:00"));
  assert.equal(key(spring), "2026-03-29T03:30");
  // 02:30 comes twice on 25 October. The second has the key of the first, which already ran.
  const first = new Date(Date.UTC(2026, 9, 25, 0, 30));
  const second = new Date(Date.UTC(2026, 9, 25, 1, 30));
  assert.equal(slotKey(first), slotKey(second));
  const input = { schedule: night, catchUp: true, armedAt: "2026-10-01T00:00:00.000Z", lastSlot: slotKey(first) };
  assert.equal(dueSlot(input, new Date(second.getTime() + 60_000)), null);
});

test("a due slot runs on time, catches up once when missed, and is skipped when too old or without catch-up", () => {
  const daily = { every: "day" as const, at: "09:00", days: [0, 1, 2, 3, 4, 5, 6] };
  const base = { schedule: daily, catchUp: true, armedAt: "2026-09-01T00:00:00.000Z", lastSlot: "2026-10-02T09:00" };
  assert.deepEqual(dueSlot(base, local("2026-10-03T09:10:00")), { key: "2026-10-03T09:00", slot: local("2026-10-03T09:00:00"), trigger: "schedule" });
  const late = dueSlot(base, local("2026-10-03T13:00:00"));
  assert.ok(late && "trigger" in late && late.trigger === "catch-up");
  assert.equal(dueSlot({ ...base, lastSlot: "2026-10-03T09:00" }, local("2026-10-03T13:00:00")), null, "a handled slot is done");
  const week = dueSlot({ ...base, lastSlot: "2026-09-20T09:00" }, local("2026-10-03T13:00:00"));
  assert.equal(week?.key, "2026-10-03T09:00", "a week away gives the latest slot only");
  const skipped = dueSlot({ ...base, catchUp: false }, local("2026-10-03T13:00:00"));
  assert.deepEqual(skipped && "skip" in skipped ? skipped.skip : null, MISSED);
  const once = { every: "once" as const, at: "2026-09-20T09:00" };
  const old = dueSlot({ ...base, schedule: once, lastSlot: null }, local("2026-10-03T13:00:00"));
  assert.ok(old && "skip" in old, "a slot older than a week only skips");
});

test("a slot before the routine was armed never runs", () => {
  const daily = { every: "day" as const, at: "09:00", days: [0, 1, 2, 3, 4, 5, 6] };
  // Created at 15:00, so 09:00 that morning is not missed.
  const input = { schedule: daily, catchUp: true, armedAt: local("2026-10-03T15:00:00").toISOString(), lastSlot: null };
  assert.equal(dueSlot(input, local("2026-10-03T15:00:30")), null);
  assert.equal(dueSlot(input, local("2026-10-04T09:00:30"))?.key, "2026-10-04T09:00");
});

test("the schedule reads as a few words", () => {
  assert.equal(describeSchedule({ every: "manual" }), "Manually");
  assert.equal(describeSchedule({ every: "hours", hours: 1, minute: 0 }), "Every hour");
  assert.equal(describeSchedule({ every: "hours", hours: 6, minute: 15 }), "Every 6 hours at :15");
  assert.equal(describeSchedule({ every: "day", at: "09:00", days: [0, 1, 2, 3, 4, 5, 6] }), "Daily at 09:00");
  assert.equal(describeSchedule({ every: "day", at: "09:00", days: [1, 2, 3, 4, 5] }), "Weekdays at 09:00");
  assert.equal(describeSchedule({ every: "day", at: "10:00", days: [0, 6] }), "Weekends at 10:00");
  assert.equal(describeSchedule({ every: "day", at: "08:30", days: [1] }), "Mondays at 08:30");
  assert.equal(describeSchedule({ every: "day", at: "08:30", days: [1, 3, 5] }), "Mon, Wed and Fri at 08:30");
  assert.equal(describeSchedule({ every: "once", at: "2026-10-04T18:00" }), "Once on Sun 4 Oct at 18:00");
});

test("times near now and run titles read short", () => {
  const now = local("2026-10-03T14:00:00");
  assert.equal(shortWhen(local("2026-10-03T09:00:00"), now), "Today 09:00");
  assert.equal(shortWhen(local("2026-10-04T09:00:00"), now), "Tomorrow 09:00");
  assert.equal(shortWhen(local("2026-10-05T09:00:00"), now), "Mon 09:00");
  assert.equal(shortWhen(local("2026-10-20T09:00:00"), now), "Tue 20 Oct 09:00");
  assert.equal(runLabel({ every: "day", at: "09:00", days: [1] }, now), "Oct 3");
  assert.equal(runLabel({ every: "hours", hours: 2, minute: 0 }, now), "Oct 3 14:00");
});
