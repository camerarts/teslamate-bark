// 月度驾驶报告（Bark 文本版）。
// 设计原则：6 行讲完，每行一个主题，数字在前，单位在后，不堆形容词。
const numberFormat = new Intl.NumberFormat("zh-CN");

function km(value, digits = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return numberFormat.format(digits ? Number(num.toFixed(digits)) : Math.round(num));
}

function duration(minutes) {
  const total = Math.max(0, Math.round(Number(minutes) || 0));
  if (total < 60) return `${total} 分钟`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
}

export function formatMonthlyReport(data = {}) {
  const {
    month, trip_count, distance_km, duration_min, estimated_kwh,
    cost_cny, fuel_low, fuel_high, saving_cny, charging, unit_price_cny_per_kwh
  } = data;

  const lines = [];

  const trips = Number(trip_count);
  const distance = km(distance_km);
  const distanceLabel = distance === null ? null : `${distance} km`;
  if (Number.isFinite(trips) && distanceLabel) lines.push(`🚗 ${numberFormat.format(trips)} 趟 · ${distanceLabel}`);
  else if (distanceLabel) lines.push(`🚗 ${distanceLabel}`);

  const clock = Number(duration_min) > 0 ? duration(duration_min) : null;
  const speed = Number(distance_km) > 0 && Number(duration_min) > 0
    ? Math.round(Number(distance_km) / (Number(duration_min) / 60))
    : null;
  const pace = [clock, speed !== null ? `均速 ${speed} km/h` : null].filter(Boolean).join(" · ");
  if (pace) lines.push(`⏱ ${pace}`);

  const kwh = Number(estimated_kwh);
  if (Number.isFinite(kwh)) lines.push(`⚡ 行驶能耗 ${kwh.toFixed(1)} 度`);

  const low = Number(fuel_low);
  const high = Number(fuel_high);
  if (Number.isFinite(low) && Number.isFinite(high)) {
    const range = `${numberFormat.format(Math.round(low))}–${numberFormat.format(Math.round(high))}`;
    const saved = Number(saving_cny);
    lines.push(`⛽ 油车 ¥${range}${Number.isFinite(saved) && saved > 0 ? ` · 省 ¥${numberFormat.format(Math.round(saved))}` : ""}`);
  }

  if (charging && Number(charging.sessions) > 0) {
    const parts = [`充电 ${numberFormat.format(Number(charging.sessions))} 次`];
    const chargedKwh = Number(charging.kwh);
    if (Number.isFinite(chargedKwh) && chargedKwh > 0) parts.push(`${chargedKwh.toFixed(1)} 度`);
    lines.push(`🔌 ${parts.join(" · ")}`);
  }

  // 预估电费固定放在最后一行，作为整月的费用结论。
  const cost = Number(cost_cny);
  if (Number.isFinite(cost) && cost >= 0) {
    const rate = Number(unit_price_cny_per_kwh);
    const suffix = Number.isFinite(rate) && rate > 0 ? `（${rate} 元/度）` : "";
    lines.push(`💰 预估电费 ¥${cost.toFixed(2)}${suffix}`);
  }

  const monthLabel = month ? `${Number(month)} 月` : "本月";
  return {
    title: `📊 ${monthLabel}驾驶报告`,
    body: lines.join("\n") || "本月没有可用数据"
  };
}
