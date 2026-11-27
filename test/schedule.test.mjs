import test from "node:test";
import assert from "node:assert/strict";
import { dailySummaryTarget, dueScheduledReport, dueScheduledReports } from "../src/schedule.mjs";

test("natural weekly and monthly reports have automatic delivery slots", () => {
  assert.deepEqual(dueScheduledReport({
    year: "2026", month: "08", day: "31", weekday: "Mon", hour: "09", minute: "00"
  }, { sent: {} }), {
    period: "previous_week",
    key: "weekly:2026-08-31"
  });
  assert.deepEqual(dueScheduledReport({
    year: "2026", month: "09", day: "01", weekday: "Tue", hour: "09", minute: "10"
  }, { sent: {} }), {
    period: "previous_month",
    key: "monthly:2026-09"
  });
});

test("an automatic report is not delivered twice", () => {
  const now = { year: "2026", month: "08", day: "31", weekday: "Mon", hour: "09", minute: "00" };
  assert.equal(dueScheduledReport(now, { sent: {
    "weekly:2026-08-31": "sent",
    "monthly:2026-08": "sent"
  } }), null);
});

test("weekly report catches up after the exact Monday minute was missed", () => {
  assert.deepEqual(dueScheduledReport({
    year: "2026", month: "08", day: "31", weekday: "Mon", hour: "09", minute: "07"
  }, { sent: {} }), {
    period: "previous_week",
    key: "weekly:2026-08-31"
  });
});

test("weekly report catches up later in the same natural week", () => {
  assert.deepEqual(dueScheduledReport({
    year: "2026", month: "09", day: "02", weekday: "Wed", hour: "14", minute: "20"
  }, { sent: {} }), {
    period: "previous_week",
    key: "weekly:2026-08-31"
  });
});

test("monthly report catches up after the first day of the month", () => {
  assert.deepEqual(dueScheduledReport({
    year: "2026", month: "09", day: "03", weekday: "Thu", hour: "08", minute: "00"
  }, { sent: { "weekly:2026-08-31": "sent" } }), {
    period: "previous_month",
    key: "monthly:2026-09"
  });
});

test("when weekly and monthly slots overlap, each unsent report is returned", () => {
  const now = { year: "2026", month: "06", day: "01", weekday: "Mon", hour: "10", minute: "00" };
  assert.deepEqual(dueScheduledReport(now, { sent: {} }), {
    period: "previous_month",
    key: "monthly:2026-06"
  });
  assert.deepEqual(dueScheduledReport(now, { sent: { "monthly:2026-06": "sent" } }), {
    period: "previous_week",
    key: "weekly:2026-06-01"
  });
});

test("月报固定在 1 号 08:00 触发，07:59 不触发月报", () => {
  const early = { year: "2026", month: "12", day: "01", weekday: "Tue", hour: "07", minute: "59" };
  assert.notEqual(dueScheduledReport(early, { sent: {} })?.period, "previous_month");

  const onTime = { ...early, hour: "08", minute: "00" };
  assert.deepEqual(dueScheduledReport(onTime, { sent: {} }), {
    period: "previous_month",
    key: "monthly:2026-12"
  });
});

test("月报当天未发出时，当天稍后仍会补发", () => {
  const later = { year: "2026", month: "12", day: "01", weekday: "Tue", hour: "19", minute: "30" };
  assert.deepEqual(dueScheduledReport(later, { sent: { "weekly:2026-11-30": "sent" } }), {
    period: "previous_month",
    key: "monthly:2026-12"
  });
});

test("到期列表同时返回周报与月报，避免只看首项时月报被周报挡住", () => {
  const now = { year: "2026", month: "11", day: "27", weekday: "Fri", hour: "10", minute: "00" };
  const all = dueScheduledReports(now, { sent: {} });
  assert.deepEqual(all.map((item) => item.period), ["previous_week", "previous_month"]);
});

test("每日小结 21 点起算当天", () => {
  assert.deepEqual(dailySummaryTarget(21, "2026-11-27", "2026-11-26"), {
    dateKey: "2026-11-27", period: "day", labelOffsetDays: 0
  });
  assert.equal(dailySummaryTarget(23, "2026-11-27", "2026-11-26").period, "day");
});

test("每日小结在 0–1 点补发前一天，避免跨零点丢失", () => {
  assert.deepEqual(dailySummaryTarget(0, "2026-11-28", "2026-11-27"), {
    dateKey: "2026-11-27", period: "previous_day", labelOffsetDays: -1
  });
  assert.equal(dailySummaryTarget(1, "2026-11-28", "2026-11-27").period, "previous_day");
});

test("每日小结在 2–20 点不触发", () => {
  for (const hour of [2, 6, 12, 20]) {
    assert.equal(dailySummaryTarget(hour, "2026-11-27", "2026-11-26"), null, `hour=${hour} 不应触发`);
  }
});
