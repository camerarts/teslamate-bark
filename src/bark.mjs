import { config } from "./config.mjs";
import { calculateFuelComparisons } from "./comparisons.mjs";

// 进程内去重：Bark 没有幂等键，靠 key + TTL 防止重启间隙或重复轮询造成连推。
const recent = new Map();
const DEDUPE_TTL_MS = 5 * 60 * 1_000;

export function isBarkConfigured() {
  return Boolean(config.barkKey);
}

export function barkDestinationEnabled() {
  return Boolean(config.barkKey);
}

function shouldSkip(key) {
  if (!key) return false;
  const now = Date.now();
  for (const [existing, at] of recent) {
    if (now - at > DEDUPE_TTL_MS) recent.delete(existing);
  }
  if (recent.has(key)) return true;
  recent.set(key, now);
  return false;
}

export function resetBarkDedupe() {
  recent.clear();
}

export async function pushBark({ title, body, group = config.notifyGroup, level = "active", sound = "minuet", url, ttl, key } = {}) {
  if (!isBarkConfigured()) {
    throw Object.assign(new Error("BARK_KEY 未配置"), { code: "BARK_NOT_CONFIGURED" });
  }
  if (!title || !body) {
    throw Object.assign(new Error("Bark 推送缺少标题或正文"), { code: "BARK_INVALID_PAYLOAD" });
  }
  if (shouldSkip(key)) return { status: "skipped" };

  const base = String(config.barkServer || "https://api.day.app").replace(/\/+$/, "");
  const endpoint = `${base}/${encodeURIComponent(config.barkKey)}`
    + `/${encodeURIComponent(title)}/${encodeURIComponent(body)}`;
  const params = new URLSearchParams({ group, level, sound });
  const clickUrl = url || config.barkClickUrl;
  if (clickUrl) params.set("url", clickUrl);
  if (ttl) params.set("ttl", String(ttl));

  const response = await fetch(`${endpoint}?${params}`, { signal: AbortSignal.timeout(8_000) });
  if (!response.ok) {
    throw Object.assign(new Error(`Bark HTTP ${response.status}`), { code: "BARK_HTTP" });
  }
  let payload = null;
  try { payload = await response.json(); } catch { /* 自建服务可能不返回 JSON，HTTP 200 即视为成功 */ }
  if (payload && typeof payload.code === "number" && payload.code !== 200) {
    throw Object.assign(new Error(`Bark 拒绝请求 code=${payload.code}`), { code: "BARK_REJECTED" });
  }
  return payload ?? { status: "sent" };
}

function formatClock(value) {
  // TeslaMate 的 utc_datetime 列存 UTC 但序列化后不带时区后缀，
  // 直接 new Date() 会按本地时间解析，比真实时间早 8 小时。补 Z 后再格式化。
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw) ? raw : `${raw}Z`;
  const date = new Date(normalized);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).format(date);
}

function formatDuration(minutes) {
  const total = Math.max(0, Math.round(Number(minutes) || 0));
  if (total < 60) return `${total} 分钟`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
}

function money(value) {
  const num = Number(value);
  return Number.isFinite(num) ? `¥${num.toFixed(2)}` : null;
}

function numOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

// display_name 形如「海天路, 小港街道, 北仑区, 宁波市, 浙江省, 315801, 中国」，
// 取最具体的一段作为地点名，避免整串地址把通知撑爆。
function shortPlace(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  return text.split(/[,，]/)[0].trim() || null;
}

function placeLabel(...candidates) {
  for (const candidate of candidates) {
    const label = shortPlace(candidate);
    if (label) return label;
  }
  return null;
}

const FAST_CHARGER_TYPES = Object.freeze({
  Gb: "国标", Tesla: "特斯拉", CCS: "CCS", CHAdeMO: "CHAdeMO", IEC: "IEC", J1772: "J1772"
});

function chargingTypeLabel(snapshot = {}) {
  if (snapshot.fast_charge === true) {
    const mapped = FAST_CHARGER_TYPES[snapshot.fast_charger_type];
    return mapped ? `直流快充 · ${mapped}` : "直流快充";
  }
  if (snapshot.fast_charge === false) return "交流慢充";
  // 没有 fast_charger 标记时按功率粗略判断。
  const kw = numOrNull(snapshot.avg_power_kw) ?? numOrNull(snapshot.charger_power);
  if (kw !== null) return kw >= 22 ? "直流快充" : "交流慢充";
  return null;
}

function rangeDeltaLabel(snapshot = {}) {
  const start = numOrNull(snapshot.start_rated_range_km);
  const end = numOrNull(snapshot.end_rated_range_km);
  if (start === null || end === null) return null;
  const delta = end - start;
  if (Math.abs(delta) < 0.5) return null;
  return `${delta > 0 ? "+" : ""}${delta.toFixed(0)}`;
}

export function formatChargingText(type, snapshot = {}) {
  const startLevel = numOrNull(snapshot.start_battery_level);
  const endLevel = numOrNull(snapshot.battery_level ?? snapshot.end_battery_level);
  const limit = numOrNull(snapshot.charge_limit_soc);
  const power = numOrNull(snapshot.charger_power);
  const avgPower = numOrNull(snapshot.avg_power_kw);
  const added = numOrNull(snapshot.charge_energy_added);
  const remaining = numOrNull(snapshot.time_to_full_charge);
  const place = placeLabel(snapshot.location, snapshot.address);

  if (type === "started") {
    const lines = [];
    const level = startLevel ?? endLevel;
    if (level !== null) lines.push(`🔋 起始电量 ${level}%`);
    const kind = chargingTypeLabel(snapshot);
    const powerLabel = power !== null ? `${power} kW` : limit !== null ? `目标 ${limit}%` : null;
    const detail = [kind, powerLabel].filter(Boolean);
    if (detail.length) lines.push(`⚡ ${detail.join(" · ")}`);
    if (place) lines.push(`📍 ${place}`);
    return { title: "🔌 开始充电", body: lines.join("\n") || "车辆已插枪开始充电" };
  }

  if (type === "near_limit") {
    const lines = [];
    if (endLevel !== null && limit !== null) lines.push(`🔋 ${endLevel}% / ${limit}%`);
    if (remaining !== null && remaining > 0) lines.push(`⏱ 约 ${formatDuration(remaining * 60)}后充满`);
    else if (power !== null) lines.push(`⚡ 当前功率 ${power} kW`);
    if (place) lines.push(`📍 ${place}`);
    return { title: "🔋 即将充满", body: lines.join("\n") || "电量接近设定的充电上限" };
  }

  if (type === "completed") {
    const lines = [];
    const soc = startLevel !== null && endLevel !== null ? `${startLevel}% → ${endLevel}%` : endLevel !== null ? `${endLevel}%` : null;
    const amount = added !== null ? `${added.toFixed(2)} kWh` : null;
    if (amount || soc) lines.push(`⚡ ${[amount, soc].filter(Boolean).join(" · ")}`);

    const rangeStart = numOrNull(snapshot.start_rated_range_km);
    const rangeEnd = numOrNull(snapshot.end_rated_range_km);
    if (rangeStart !== null && rangeEnd !== null) {
      const delta = rangeDeltaLabel(snapshot);
      lines.push(`🔋 续航 ${rangeStart.toFixed(0)} → ${rangeEnd.toFixed(0)} km${delta ? `（${delta}）` : ""}`);
    }

    const minutes = numOrNull(snapshot.duration_min);
    const timing = [
      avgPower !== null ? `平均 ${avgPower.toFixed(1)} kW` : null,
      minutes !== null && minutes > 0 ? formatDuration(minutes) : null
    ].filter(Boolean);
    if (timing.length) lines.push(`📈 ${timing.join(" · ")}`);

    const chargeCost = numOrNull(snapshot.cost_cny);
    if (chargeCost !== null && chargeCost >= 0) lines.push(`💰 电费约 ¥${chargeCost.toFixed(2)}`);

    if (place) lines.push(`📍 ${place}`);
    return { title: "✅ 充电完成", body: lines.join("\n") || "充电已结束" };
  }

  return { title: "充电状态更新", body: `状态：${type}` };
}

export function formatTripText(trip = {}, pricingSummary = null) {
  const distance = Number(trip.distance_km) || 0;
  const duration = Number(trip.duration_min) || 0;
  const kwh = Number(trip.estimated_kwh);
  const cost = Number(pricingSummary?.cost_cny ?? trip.estimated_cost_cny);
  const start = formatClock(trip.start_at);
  const end = formatClock(trip.end_at);

  const lines = [];
  const timeRange = start && end ? `${start} → ${end}` : start || end;
  lines.push(`🕐 ${timeRange ? `${timeRange} · ` : ""}${formatDuration(duration)}`);

  // road 常为空，用 display_name 兜底，保证起终点都能显示出来。
  const from = placeLabel(trip.start_road, trip.start_display);
  const to = placeLabel(trip.end_road, trip.end_display);
  if (from && to && from !== to) lines.push(`📍 ${from} → ${to}`);
  else if (from) lines.push(`📍 ${from} 出发`);
  else if (to) lines.push(`📍 到达 ${to}`);

  // 平均能耗用「度/百公里」更贴近车机口径，短途不显示避免数字失真。
  const whPerKm = Number.isFinite(kwh) && distance >= 1 ? Math.round(kwh * 1000 / distance) : null;
  const energy = [
    Number.isFinite(kwh) ? `${kwh.toFixed(2)} kWh` : null,
    whPerKm !== null ? `${whPerKm} Wh/km` : null,
    money(cost)
  ].filter(Boolean);
  if (energy.length) lines.push(`⚡ ${energy.join(" · ")}`);

  const startBattery = numOrNull(trip.start_battery_level);
  const endBattery = numOrNull(trip.end_battery_level);
  const startRange = numOrNull(trip.start_range_km);
  const endRange = numOrNull(trip.end_range_km);
  const batteryPart = startBattery !== null && endBattery !== null
    ? `电量 ${startBattery}% → ${endBattery}%`
    : endBattery !== null ? `电量 ${endBattery}%` : null;
  const rangePart = startRange !== null && endRange !== null
    ? `续航 ${Math.round(startRange)} → ${Math.round(endRange)} km`
    : endRange !== null ? `续航 ${Math.round(endRange)} km` : null;
  const telemetry = [batteryPart, rangePart].filter(Boolean);
  if (telemetry.length) lines.push(`🔋 ${telemetry.join(" · ")}`);

  if (distance > 0) {
    try {
      const comparison = calculateFuelComparisons(distance, Number.isFinite(cost) ? cost : null);
      const usable = comparison.items.filter((item) => Number.isFinite(item.cost_cny));
      // 只取家用车档位做基准：对比表里还有保时捷、兰博基尼，
      // 把它们算进来会让区间宽到失去参考意义。
      const household = usable.filter((item) => Number(item.consumption) <= 10);
      const pool = household.length ? household : usable;
      if (pool.length) {
        const costs = pool.map((item) => item.cost_cny);
        const low = Math.min(...costs);
        const high = Math.max(...costs);
        const saving = Number.isFinite(cost) && cost >= 0 ? low - cost : null;
        let line = high - low < 0.01
          ? `⛽ 油车约 ¥${low.toFixed(2)}`
          : `⛽ 油车 ¥${low.toFixed(2)}–${high.toFixed(2)}`;
        if (saving !== null && saving > 0) line += ` · 省 ¥${saving.toFixed(2)}`;
        lines.push(line);
      }
    } catch { /* 油价未就绪时省略对比，不影响主信息 */ }
  }

  return {
    title: `🚗 行程结束 · ${distance.toFixed(1)} km`,
    body: lines.join("\n") || "本次行程已结束"
  };
}

// 充电未达到设定上限就结束 —— 跳闸、枪被拔、车端故障都会是这个表现。
export function formatChargingInterrupted(snapshot = {}) {
  const endLevel = numOrNull(snapshot.battery_level ?? snapshot.end_battery_level);
  const limit = numOrNull(snapshot.charge_limit_soc);
  const added = numOrNull(snapshot.charge_energy_added);
  const minutes = numOrNull(snapshot.duration_min);
  const place = placeLabel(snapshot.location, snapshot.address);

  const lines = [];
  if (endLevel !== null && limit !== null) lines.push(`🔋 ${endLevel}% / 目标 ${limit}%`);
  else if (endLevel !== null) lines.push(`🔋 当前 ${endLevel}%`);

  const detail = [
    added !== null ? `已充 ${added.toFixed(2)} kWh` : null,
    minutes !== null && minutes > 0 ? formatDuration(minutes) : null
  ].filter(Boolean);
  if (detail.length) lines.push(`⚡ ${detail.join(" · ")}`);

  if (place) lines.push(`📍 ${place}`);
  lines.push("👉 请检查充电桩或插枪状态");

  return { title: "⚠️ 充电意外中断", body: lines.join("\n") };
}

export function formatLowBatteryAlert(pulse = {}) {
  const level = numOrNull(pulse.battery_level);
  const lines = [];
  if (level !== null) lines.push(`🔋 当前 ${level}%`);
  lines.push("📍 车在家，建议现在插枪");
  return { title: "🪫 电量偏低且未充电", body: lines.join("\n") };
}

// 胎压提醒：每条低于阈值的轮胎单独成行，带上阈值便于判断严重程度。
// 用「阈值」而不是「标准」——Model Y 标准胎压约 2.9 bar，阈值是人为设定的警戒线。
export function formatTpmsAlert({ tires = [], threshold = 2.6 } = {}) {
  const sorted = [...tires].sort((a, b) => a.bar - b.bar);
  const lines = sorted.map((tire) =>
    `⚠️ ${tire.label} ${Number(tire.bar).toFixed(2)} bar（阈值 ${Number(threshold).toFixed(2)}）`);
  lines.push("👉 建议尽快补气");
  return {
    title: sorted.length > 1 ? `🛞 ${sorted.length} 条轮胎胎压偏低` : "🛞 胎压偏低",
    body: lines.join("\n")
  };
}

// 未锁车提醒。判断依据是「车辆停车后迟迟不休眠」，所以文案按推断口径写，
// 不直接断言「没锁」，同时给出判断理由，便于用户自己核对。
export function formatUnlockedAlert(parking = {}) {
  const minutes = Number(parking.parked_minutes);
  const lines = [
    `🕐 已停车 ${Number.isFinite(minutes) ? Math.round(minutes) : "?"} 分钟，车辆仍在唤醒状态`,
    parking.at_home ? "🏠 停在家附近" : "📍 停在外面",
    "👉 锁车后车辆通常 15 分钟内休眠，请确认是否已锁"
  ];
  return { title: "🔓 车辆可能没锁", body: lines.join("\n") };
}

export function formatSentryText(kind, context = {}) {
  const clock = context.at ? formatClock(context.at) : null;
  if (kind === "enabled") {
    return { title: "🛡 哨兵已开启", body: "车辆进入监控状态" };
  }
  if (kind === "disabled") {
    return { title: "🛡 哨兵已关闭", body: "已退出监控，停止记录" };
  }
  if (kind === "triggered") {
    return {
      title: "🚨 哨兵疑似被触发",
      body: `${clock ? `${clock} ` : ""}车辆被唤醒\n建议查看 U 盘录像`
    };
  }
  if (kind === "unlocked") {
    return {
      title: "⚠️ 哨兵期间车辆被解锁",
      body: `${clock ? `${clock} ` : ""}锁车状态解除，请留意车辆`
    };
  }
  return { title: "哨兵状态变化", body: kind };
}
