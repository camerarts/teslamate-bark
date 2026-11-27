import test from "node:test";
import assert from "node:assert/strict";
import { formatMonthlyReport } from "../src/monthly-report.mjs";

const full = {
  month: 10,
  trip_count: 165,
  distance_km: 1746.3,
  duration_min: 3375,
  estimated_kwh: 243.57,
  cost_cny: 87.68,
  fuel_low: 859.45,
  fuel_high: 1106.84,
  saving_cny: 771.77,
  charging: { sessions: 10, kwh: 314.9 },
  unit_price_cny_per_kwh: 0.36
};

test("完整数据生成结构化月报，预估电费固定在最后一行", () => {
  const { title, body } = formatMonthlyReport(full);
  assert.equal(title, "📊 10 月驾驶报告");
  const lines = body.split("\n");
  assert.equal(lines.length, 6);
  assert.equal(lines[0], "🚗 165 趟 · 1,746 km");
  assert.equal(lines[1], "⏱ 56 小时 15 分 · 均速 31 km/h");
  assert.equal(lines[2], "⚡ 行驶能耗 243.6 度");
  assert.equal(lines[3], "⛽ 油车 ¥859–1,107 · 省 ¥772");
  assert.equal(lines[4], "🔌 充电 10 次 · 314.9 度");
  assert.equal(lines[5], "💰 预估电费 ¥87.68（0.36 元/度）");
});

test("月报不再输出常跑路线行", () => {
  const { body } = formatMonthlyReport(full);
  assert.doesNotMatch(body, /🛣/);
  assert.doesNotMatch(body, /常跑路线/);
});

test("缺少单价时不输出空括号", () => {
  const { body } = formatMonthlyReport({ ...full, unit_price_cny_per_kwh: undefined });
  assert.match(body, /💰 预估电费 ¥87\.68$/m);
  assert.doesNotMatch(body, /元\/度/);
});

test("电费只出现一次，不会和能耗行重复", () => {
  const { body } = formatMonthlyReport(full);
  assert.equal((body.match(/¥87\.68/g) || []).length, 1);
});

test("缺少充电数据时收敛行数，电费仍在最后", () => {
  const { body } = formatMonthlyReport({ ...full, charging: null });
  const lines = body.split("\n");
  assert.equal(lines.length, 5);
  assert.doesNotMatch(body, /🔌/);
  assert.match(lines.at(-1), /预估电费/);
});

test("没有电费与油车对比时只保留基础统计", () => {
  const { body } = formatMonthlyReport({
    month: 9, trip_count: 12, distance_km: 86.2, duration_min: 120, estimated_kwh: 13.1
  });
  assert.match(body, /12 趟 · 86 km/);
  assert.match(body, /2 小时/);
  assert.match(body, /行驶能耗 13\.1 度/);
  assert.doesNotMatch(body, /预估电费/);
  assert.doesNotMatch(body, /油车/);
});

test("完全没有数据时给出兜底文案而不是空消息", () => {
  const { body } = formatMonthlyReport({ month: 8 });
  assert.equal(body, "本月没有可用数据");
});

test("千位分隔正确，避免大数字难以扫读", () => {
  const { body } = formatMonthlyReport({ ...full, distance_km: 12345.6, trip_count: 1234 });
  assert.match(body, /1,234 趟/);
  assert.match(body, /12,346 km/);
});
