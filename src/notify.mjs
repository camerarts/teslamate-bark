// 通知层：把监控事件翻译成 Bark 推送。
// 与监控逻辑解耦——这里只负责「取数 → 组文案 → 发出去」，
// 事件从哪来（MQTT 还是数据库轮询）由 worker 决定。
import { config } from "./config.mjs";
import {
  formatChargingInterrupted,
  formatChargingText,
  formatLowBatteryAlert,
  formatSentryText,
  formatTpmsAlert,
  formatTripText,
  formatUnlockedAlert,
  pushBark
} from "./bark.mjs";
import { calculateFuelComparisons } from "./comparisons.mjs";
import { formatDailySummary } from "./daily-summary.mjs";
import { getElectricityCostSummary } from "./electricity-cost-service.mjs";
import { logError } from "./logger.mjs";
import { formatMonthlyReport } from "./monthly-report.mjs";
import { getPricingSettings } from "./store.mjs";
import {
  getChargingContext,
  getDriveGroup,
  getLatestChargingProcess,
  getPeriodCharging,
  getPeriodTrips,
  getVehiclePulse
} from "./teslamate.mjs";

const TPMS_FIELDS = Object.freeze([
  { key: "fl", label: "左前" },
  { key: "fr", label: "右前" },
  { key: "rl", label: "左后" },
  { key: "rr", label: "右后" }
]);

// 推送失败不向上抛：调用方通常已经把事件合入状态，
// 抛错会导致整段逻辑回滚并重复投递同一事件。
async function pushToBark(message) {
  try {
    await pushBark({ url: config.barkClickUrl || undefined, ...message });
  } catch (error) {
    logError(`bark_push_failed code=${error?.code || "unknown"} message=${error?.message || error}`);
  }
}

// 上一个自然月的月份数字，用于「📊 10 月驾驶报告」标题。
function previousMonthNumber() {
  const current = Number(new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timeZone, month: "2-digit"
  }).format(new Date()));
  return current === 1 ? 12 : current - 1;
}

// MQTT 快照里没有地点、平均功率、充电类型，推送前按需补齐一次。
// 补齐失败只少几行内容，不影响推送本身。
async function enrichChargingSnapshot(event) {
  const snapshot = { ...(event.snapshot || {}) };
  let processId = event.processId ?? snapshot.processId ?? snapshot.process_id ?? null;
  if (!processId && event.type === "started") {
    processId = await getLatestChargingProcess().then((latest) => latest?.id ?? null).catch(() => null);
  }
  if (!processId) return snapshot;

  const context = await getChargingContext(processId).catch(() => null);
  if (!context) return snapshot;

  const pick = (key) => snapshot[key] ?? context[key];
  return {
    ...snapshot,
    location: pick("location"),
    address: pick("address"),
    avg_power_kw: pick("avg_power_kw"),
    fast_charge: pick("fast_charge"),
    fast_charger_type: pick("fast_charger_type"),
    start_rated_range_km: pick("start_rated_range_km"),
    end_rated_range_km: pick("end_rated_range_km"),
    start_battery_level: pick("start_battery_level"),
    end_battery_level: pick("end_battery_level"),
    start_at: pick("start_at"),
    end_at: pick("end_at"),
    duration_min: pick("duration_min"),
    charge_energy_added: pick("charge_energy_added")
  };
}

export async function sendChargingEvent(event, key = Date.now()) {
  if (!event?.type) return { status: "ignored" };
  const snapshot = await enrichChargingSnapshot(event);

  if (event.type === "completed") {
    // 电费统一按固定电价估算（store 里的默认电价，可由用户修改）。
    const settings = await getPricingSettings().catch(() => null);
    const rate = Number(settings?.default_rate_history?.at(-1)?.price_cny_per_kwh);
    const added = Number(snapshot.charge_energy_added);
    if (Number.isFinite(rate) && rate > 0 && Number.isFinite(added) && added > 0) {
      snapshot.unit_price_cny_per_kwh = rate;
      snapshot.cost_cny = Number((added * rate).toFixed(2));
    }
  }

  // 充到设定上限才叫正常结束；明显没充满就断开，按「意外中断」提醒。
  const limit = Number(snapshot.charge_limit_soc);
  const endLevel = Number(snapshot.battery_level ?? snapshot.end_battery_level);
  const interrupted = event.type === "completed"
    && Number.isFinite(limit) && limit > 0
    && Number.isFinite(endLevel)
    && endLevel < limit - 5;

  const message = interrupted
    ? formatChargingInterrupted(snapshot)
    : formatChargingText(event.type, snapshot);

  await pushToBark({
    title: message.title,
    body: message.body,
    key: `charging:${key}:${interrupted ? "interrupted" : event.type}`,
    level: interrupted ? "timeSensitive" : "active",
    sound: event.type === "completed" ? "bell" : "minuet"
  });
  return { status: "sent", message };
}

export async function sendCompletedTrip(event = {}, key = Date.now()) {
  const trip = event.trip || await getDriveGroup(event.segment_ids);
  if (!trip) return { status: "empty" };

  let pricingSummary = null;
  try {
    pricingSummary = trip?.segment_ids?.length
      ? await getElectricityCostSummary(trip.segment_ids)
      : null;
  } catch { /* 电价未就绪时省掉费用行，不影响里程与时间 */ }

  const { title, body } = formatTripText(trip, pricingSummary);
  // 行程属高频低优先级事件：passive 静默投递，不弹窗不响铃。
  await pushToBark({ title, body, key: `trip:${key}`, level: "passive" });
  return { status: "sent" };
}

export async function sendSentryEvent(kind, context = {}, key = Date.now()) {
  const { title, body } = formatSentryText(kind, context);
  // 告警类用时效性通知 + 独立铃声，并延长 TTL，避免错过。
  const urgent = kind === "triggered" || kind === "unlocked";
  await pushToBark({
    title,
    body,
    key: `sentry:${key}:${kind}`,
    level: urgent ? "timeSensitive" : "active",
    sound: urgent ? "alarm" : "minuet",
    ttl: urgent ? 86_400 : 3_600
  });
  return { status: "sent" };
}

// 纯函数，便于单测：挑出低于阈值的轮胎。
// 不能直接 Number(null)——会得到 0，把「没有数据」误判成 0 bar。
export function lowTiresFrom(tpms, threshold = config.tpmsThresholdBar) {
  if (!tpms) return [];
  return TPMS_FIELDS
    .map(({ key, label }) => {
      const raw = tpms[key];
      const missing = raw === null || raw === undefined || raw === "";
      return { key, label, bar: missing ? NaN : Number(raw) };
    })
    .filter((tire) => Number.isFinite(tire.bar) && tire.bar < threshold);
}

export async function sendTpmsAlert(tires, key = Date.now()) {
  const message = formatTpmsAlert({ tires, threshold: config.tpmsThresholdBar });
  await pushToBark({ ...message, key: `tpms:${key}`, level: "active", sound: "bell" });
  return { status: "sent", message };
}

// 停车后长时间不休眠 = 大概率没锁车。每次停车只提醒一次。
export async function sendUnlockedAlert(parking, key = Date.now()) {
  const message = formatUnlockedAlert(parking);
  await pushToBark({ ...message, key: `unlocked:${key}`, level: "active", sound: "minuet" });
  return { status: "sent", message };
}

// 每日小结：默认统计当天；跨零点补发时传 previous_day 并把标题日期回退一天。
export async function sendDailySummary({ period = "day", labelOffsetDays = 0, key = Date.now() } = {}) {
  const [trips, pulse] = await Promise.all([
    getPeriodTrips(period),
    getVehiclePulse().catch(() => null)
  ]);

  let cost = null;
  if (trips?.drive_ids?.length) {
    const pricing = await getElectricityCostSummary(trips.drive_ids).catch(() => null);
    cost = pricing?.cost_cny ?? null;
  }

  const labelDate = new Date(Date.now() + labelOffsetDays * 86_400_000);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timeZone, month: "2-digit", day: "2-digit"
  }).formatToParts(labelDate).map((item) => [item.type, item.value]));

  const message = formatDailySummary({
    month: parts.month,
    day: parts.day,
    trip_count: trips?.trip_count ?? 0,
    distance_km: trips?.distance_km ?? 0,
    duration_min: trips?.duration_min ?? 0,
    estimated_kwh: trips?.estimated_kwh ?? 0,
    cost_cny: cost,
    battery_level: pulse?.battery_level ?? null
  });

  await pushToBark({ ...message, key: `daily:${key}`, level: "active" });
  return { status: "sent", message };
}

export async function sendLowBatteryAlert(pulse, key = Date.now()) {
  const message = formatLowBatteryAlert(pulse);
  await pushToBark({ ...message, key: `low-battery:${key}`, level: "timeSensitive", sound: "bell", ttl: 86_400 });
  return { status: "sent", message };
}

// 月报：上一个自然月，每月 1 号由调度触发。
export async function sendMonthlyReport(key = Date.now()) {
  const period = "previous_month";
  const [trips, charging] = await Promise.all([
    getPeriodTrips(period),
    getPeriodCharging(period).catch(() => null)
  ]);
  if (!trips || !(Number(trips.trip_count) > 0)) return { status: "empty" };

  const settings = await getPricingSettings().catch(() => null);
  const rate = Number(settings?.default_rate_history?.at(-1)?.price_cny_per_kwh);
  const chargedKwh = Number(charging?.kwh);
  const driveKwh = Number(trips.estimated_kwh);
  const basisKwh = Number.isFinite(chargedKwh) && chargedKwh > 0 ? chargedKwh : driveKwh;
  const cost = Number.isFinite(rate) && rate > 0 && Number.isFinite(basisKwh) && basisKwh > 0
    ? Number((basisKwh * rate).toFixed(2))
    : null;

  // 油车对比只取家用车档位：对比表里还有跑车和性能车，
  // 把它们算进来会让区间宽到失去参考意义。
  const comparisons = calculateFuelComparisons(trips.distance_km, cost);
  const household = comparisons.items.filter((item) => Number(item.consumption) <= 10);
  const pool = household.length ? household : comparisons.items;
  const fuelCosts = pool.map((item) => item.cost_cny).filter(Number.isFinite);
  const fuelLow = fuelCosts.length ? Math.min(...fuelCosts) : null;
  const fuelHigh = fuelCosts.length ? Math.max(...fuelCosts) : null;

  const message = formatMonthlyReport({
    month: previousMonthNumber(),
    trip_count: trips.trip_count,
    distance_km: trips.distance_km,
    duration_min: trips.duration_min,
    estimated_kwh: driveKwh,
    cost_cny: cost,
    fuel_low: fuelLow,
    fuel_high: fuelHigh,
    saving_cny: fuelLow !== null && cost !== null ? fuelLow - cost : null,
    charging,
    unit_price_cny_per_kwh: Number.isFinite(rate) && rate > 0 ? rate : null
  });

  await pushToBark({ ...message, key: `monthly:${key}`, ttl: 86_400 });
  return { status: "sent", message };
}
