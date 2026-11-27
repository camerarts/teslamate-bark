// 每日小结（Bark 文本版）。21:00 推送当天出行概况。
function money(value) {
  const num = Number(value);
  return Number.isFinite(num) ? `¥${num.toFixed(2)}` : null;
}

function duration(minutes) {
  const total = Math.max(0, Math.round(Number(minutes) || 0));
  if (total < 60) return `${total} 分钟`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
}

export function formatDailySummary(data = {}) {
  const { month, day, trip_count, distance_km, duration_min, estimated_kwh, cost_cny, battery_level } = data;

  const header = month && day ? `${Number(month)} 月 ${Number(day)} 日` : "今日";
  const lines = [];
  const trips = Number(trip_count);

  if (Number.isFinite(trips) && trips > 0) {
    const distance = Number(distance_km);
    const distanceLabel = Number.isFinite(distance) ? `${distance.toFixed(1)} km` : null;
    lines.push(`🚗 ${trips} 趟${distanceLabel ? ` · ${distanceLabel}` : ""}`);
    if (Number(duration_min) > 0) lines.push(`⏱ ${duration(duration_min)}`);

    const kwh = Number(estimated_kwh);
    const energy = [
      Number.isFinite(kwh) && kwh > 0 ? `${kwh.toFixed(1)} 度` : null,
      money(cost_cny) ? `电费 ${money(cost_cny)}` : null
    ].filter(Boolean).join(" · ");
    if (energy) lines.push(`⚡ ${energy}`);
  } else {
    lines.push("💤 今天没有出行");
  }

  const battery = Number(battery_level);
  if (Number.isFinite(battery)) lines.push(`🔋 当前电量 ${battery}%`);

  return {
    title: `📅 ${header}小结`,
    body: lines.join("\n")
  };
}
