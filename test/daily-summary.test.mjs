import test from "node:test";
import assert from "node:assert/strict";
import { formatDailySummary } from "../src/daily-summary.mjs";

test("有出行时生成四行小结", () => {
  const { title, body } = formatDailySummary({
    month: 11, day: 27,
    trip_count: 3, distance_km: 42.1, duration_min: 125,
    estimated_kwh: 6.1, cost_cny: 2.31, battery_level: 78
  });
  assert.equal(title, "📅 11 月 27 日小结");
  const lines = body.split("\n");
  assert.equal(lines[0], "🚗 3 趟 · 42.1 km");
  assert.equal(lines[1], "⏱ 2 小时 5 分");
  assert.equal(lines[2], "⚡ 6.1 度 · 电费 ¥2.31");
  assert.equal(lines[3], "🔋 当前电量 78%");
});

test("没有出行时给出明确空状态而不是零值堆砌", () => {
  const { body } = formatDailySummary({
    month: 11, day: 27, trip_count: 0, distance_km: 0, battery_level: 64
  });
  assert.match(body, /今天没有出行/);
  assert.match(body, /当前电量 64%/);
  assert.doesNotMatch(body, /0 趟/);
});

test("缺少电量时不影响其他行", () => {
  const { body } = formatDailySummary({ month: 12, day: 1, trip_count: 1, distance_km: 5.2, duration_min: 12 });
  assert.match(body, /1 趟 · 5\.2 km/);
  assert.doesNotMatch(body, /🔋/);
});

test("缺少电费时不输出空金额", () => {
  const { body } = formatDailySummary({ month: 11, day: 1, trip_count: 2, distance_km: 10, estimated_kwh: 1.8 });
  assert.match(body, /⚡ 1\.8 度/);
  assert.doesNotMatch(body, /电费/);
});

test("不足一小时用分钟表达", () => {
  const { body } = formatDailySummary({ month: 11, day: 2, trip_count: 1, distance_km: 3, duration_min: 18 });
  assert.match(body, /18 分钟/);
});
