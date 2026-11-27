import test from "node:test";
import assert from "node:assert/strict";
import { formatChargingInterrupted, formatChargingText, formatLowBatteryAlert, formatSentryText, formatTripText, pushBark } from "../src/bark.mjs";

test("充电开始推送起始电量、充电类型与地点", () => {
  const { title, body } = formatChargingText("started", {
    battery_level: 41, charge_limit_soc: 80, charger_power: 70,
    fast_charge: true, fast_charger_type: "Gb", location: "海江大道"
  });
  assert.equal(title, "🔌 开始充电");
  assert.match(body, /起始电量 41%/);
  assert.match(body, /直流快充 · 国标 · 70 kW/);
  assert.match(body, /海江大道/);
});

test("充电开始时缺少快充标记，按功率推断充电类型", () => {
  assert.match(formatChargingText("started", { battery_level: 30, charger_power: 4 }).body, /交流慢充/);
  assert.match(formatChargingText("started", { battery_level: 30, charger_power: 60 }).body, /直流快充/);
});

test("接近上限时用小时分钟表达剩余时间，不出现写死的 15 分钟", () => {
  const { title, body } = formatChargingText("near_limit", { battery_level: 77, charge_limit_soc: 80, time_to_full_charge: 0.5 });
  assert.equal(title, "🔋 即将充满");
  assert.match(body, /77% \/ 80%/);
  assert.match(body, /30 分钟/);
});

test("充电完成推送充入电量、电量变化、续航、平均功率、时长与地点", () => {
  const { title, body } = formatChargingText("completed", {
    charge_energy_added: 27.04, start_battery_level: 45, end_battery_level: 95,
    start_rated_range_km: 174.45, end_rated_range_km: 370.18,
    avg_power_kw: 4, duration_min: 460, start_at: "2026-11-26T14:00:00Z", end_at: "2026-11-26T21:39:00Z",
    location: "小港街道"
  });
  assert.equal(title, "✅ 充电完成");
  assert.match(body, /27\.04 kWh · 45% → 95%/);
  assert.match(body, /续航 174 → 370 km（\+196）/);
  assert.match(body, /平均 4\.0 kW · 7 小时 40 分/);
  assert.match(body, /小港街道/);
});

test("行程推送把时间、起终点、能耗与电费组织成多行", () => {
  const { title, body } = formatTripText({
    distance_km: 23.4, duration_min: 38, estimated_kwh: 4.2,
    start_at: "2026-11-27T04:03:00Z", end_at: "2026-11-27T04:41:00Z",
    start_road: "望京", end_road: "国贸"
  }, { cost_cny: 3.18 });
  assert.equal(title, "🚗 行程结束 · 23.4 km");
  const lines = body.split("\n");
  assert.match(lines[0], /12:03 → 12:41 · 38 分钟/);
  assert.match(lines[1], /望京 → 国贸/);
  assert.match(body, /4\.20 kWh/);
  assert.match(body, /¥3\.18/);
});

test("行程推送包含平均能耗、电量变化与续航变化", () => {
  const { body } = formatTripText({
    distance_km: 2.65, duration_min: 5, estimated_kwh: 0.34,
    start_at: "2026-11-27T00:21:08Z", end_at: "2026-11-27T00:26:21Z",
    start_road: "海天路", end_road: "小港街道",
    start_battery_level: 93, end_battery_level: 92,
    start_range_km: 361.8, end_range_km: 359.2
  }, { cost_cny: 0.12 });
  assert.match(body, /0\.34 kWh · 128 Wh\/km · ¥0\.12/);
  assert.match(body, /电量 93% → 92% · 续航 362 → 359 km/);
});

test("短途不显示平均能耗，避免个位数距离导致数值失真", () => {
  const { body } = formatTripText({
    distance_km: 0.4, duration_min: 2, estimated_kwh: 0.1,
    start_at: "2026-11-27T00:21:08Z", end_at: "2026-11-27T00:23:08Z"
  }, null);
  assert.doesNotMatch(body, /Wh\/km/);
});

test("缺少电量或续航数据时不输出空行", () => {
  const { body } = formatTripText({
    distance_km: 5, duration_min: 10, estimated_kwh: 0.8,
    start_at: "2026-11-27T00:21:08Z", end_at: "2026-11-27T00:31:08Z"
  }, null);
  assert.doesNotMatch(body, /🔋/);
});

test("road 为空时用 display_name 兜底，保证起终点都能显示", () => {
  const { body } = formatTripText({
    distance_km: 2.65, duration_min: 5,
    start_at: "2026-11-27T00:21:08Z", end_at: "2026-11-27T00:26:21Z",
    start_road: "海天路", start_display: "海天路, 小港街道, 北仑区, 宁波市",
    end_road: null, end_display: "小港街道, 北仑区, 宁波市, 浙江省, 315801, 中国"
  }, null);
  assert.match(body, /海天路 → 小港街道/);
});

test("只有一端有地点时不显示残缺箭头", () => {
  const onlyStart = formatTripText({ distance_km: 3, duration_min: 8, start_road: "海天路" }, null).body;
  assert.match(onlyStart, /海天路 出发/);
  assert.doesNotMatch(onlyStart, /→/);
  const onlyEnd = formatTripText({ distance_km: 3, duration_min: 8, end_display: "小港街道, 北仑区" }, null).body;
  assert.match(onlyEnd, /到达 小港街道/);
});

test("行程缺少费用信息时不报错，仍给出里程与时间", () => {
  const { body } = formatTripText({ distance_km: 5, duration_min: 12, start_at: "2026-11-27T01:00:00Z", end_at: "2026-11-27T01:12:00Z" }, null);
  assert.match(body, /09:00 → 09:12/);
});

test("数据库返回的 UTC 时间串没有时区后缀时，按 UTC 解释而不是本地时间", () => {
  const { body } = formatTripText({
    distance_km: 10, duration_min: 20,
    start_at: "2026-11-27T00:26:21.55", end_at: "2026-11-27T00:46:21.55"
  }, null);
  assert.match(body, /08:26 → 08:46/, `实际输出：${body}`);
});

test("行程正文每行都带图标前缀，保证手机端可扫读", () => {
  const { body } = formatTripText({
    distance_km: 12.5, duration_min: 25, estimated_kwh: 2.1,
    start_at: "2026-11-27T00:00:00Z", end_at: "2026-11-27T00:25:00Z",
    start_road: "A", end_road: "B"
  }, { cost_cny: 1.5 });
  for (const line of body.split("\n")) {
    assert.match(line, /^[^\w\s]/, `行首应是图标或符号：${line}`);
  }
});

test("哨兵疑似触发使用时效性文案并提示查看录像", () => {
  const triggered = formatSentryText("triggered", { at: "2026-11-27T02:30:00Z" });
  assert.equal(triggered.title, "🚨 哨兵疑似被触发");
  assert.match(triggered.body, /10:30/);
  assert.match(triggered.body, /U 盘录像/);
  assert.equal(formatSentryText("enabled").title, "🛡 哨兵已开启");
  assert.equal(formatSentryText("disabled").title, "🛡 哨兵已关闭");
  assert.equal(formatSentryText("unlocked").title, "⚠️ 哨兵期间车辆被解锁");
});

test("未配置 BARK_KEY 时推送直接报错而不是静默失败", async () => {
  await assert.rejects(() => pushBark({ title: "标题", body: "内容" }), (error) => error.code === "BARK_NOT_CONFIGURED");
});

test("充电未达上限就结束时，用中断文案而不是「充电完成」", () => {
  const { title, body } = formatChargingInterrupted({
    battery_level: 62, charge_limit_soc: 95, charge_energy_added: 18.2,
    duration_min: 130, location: "小港街道"
  });
  assert.equal(title, "⚠️ 充电意外中断");
  assert.match(body, /62% \/ 目标 95%/);
  assert.match(body, /已充 18\.20 kWh · 2 小时 10 分/);
  assert.match(body, /小港街道/);
  assert.match(body, /检查充电桩/);
});

test("低电量提醒说明当前电量并给出行动建议", () => {
  const { title, body } = formatLowBatteryAlert({ battery_level: 15 });
  assert.equal(title, "🪫 电量偏低且未充电");
  assert.match(body, /当前 15%/);
  assert.match(body, /建议现在插枪/);
});

test("充电完成按固定电价估算电费，并标注「约」", () => {
  const { body } = formatChargingText("completed", {
    charge_energy_added: 27.04, end_battery_level: 95, cost_cny: 9.73
  });
  assert.match(body, /电费约 ¥9\.73/);
});
