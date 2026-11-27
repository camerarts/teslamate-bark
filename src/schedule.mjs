export function dueScheduledReports(now, state = {}) {
  const weekdayIndex = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }[now.weekday];
  if (weekdayIndex === undefined) return [];

  const currentDate = Date.UTC(Number(now.year), Number(now.month) - 1, Number(now.day));
  const monday = new Date(currentDate - weekdayIndex * 86_400_000);
  const mondayKey = [
    monday.getUTCFullYear(),
    String(monday.getUTCMonth() + 1).padStart(2, "0"),
    String(monday.getUTCDate()).padStart(2, "0")
  ].join("-");
  const clock = `${now.hour}:${now.minute}`;
  const weeklyDue = weekdayIndex > 0 || clock >= "09:00";
  // 月报固定在每月 1 号 08:00；错过则当天之后任意时刻补发。
  const MONTHLY_SLOT = "08:00";
  const monthlyDue = now.day > "01" || (now.day === "01" && clock >= MONTHLY_SLOT);
  const weekly = { period: "previous_week", key: `weekly:${mondayKey}` };
  const monthly = { period: "previous_month", key: `monthly:${now.year}-${now.month}` };
  const monthlySlotIsToday = now.day === "01" && clock >= MONTHLY_SLOT;
  const candidates = monthlySlotIsToday
    ? [monthly, ...(weeklyDue ? [weekly] : [])]
    : [...(weeklyDue ? [weekly] : []), ...(monthlyDue ? [monthly] : [])];
  return candidates.filter((candidate) => !state.sent?.[candidate.key]);
}

// 只关心第一个到期项的场景（原有行为）。
export function dueScheduledReport(now, state = {}) {
  return dueScheduledReports(now, state)[0] ?? null;
}

// 每日小结的目标：21 点起算当天；跨零点（0–1 点）补发前一天；其余时间不触发。
export function dailySummaryTarget(hour, todayKey, yesterdayKey, startHour = 21) {
  const h = Number(hour);
  if (!Number.isFinite(h)) return null;
  if (h >= startHour) return { dateKey: todayKey, period: "day", labelOffsetDays: 0 };
  if (h <= 1) return { dateKey: yesterdayKey, period: "previous_day", labelOffsetDays: -1 };
  return null;
}

// 未锁车判断（纯函数，便于单测）。
//
// 前提：锁车后车辆约 15 分钟内休眠，未锁车则保持唤醒。所以只看
// 「停车够久 + 仍是 online + 这段 online 覆盖了停车时刻 + 不在充电」。
// 返回 null 表示不提醒，否则返回提醒所需的上下文。
export function unlockedAlertFor(parking = {}, thresholdMinutes = 30) {
  if (!parking) return null;
  // 阈值设为 0 或负数表示关闭这条提醒。
  if (!(Number(thresholdMinutes) > 0)) return null;
  if (parking.driving || parking.charging) return null;

  const parked = Number(parking.parked_minutes);
  if (!Number.isFinite(parked) || parked < thresholdMinutes) return null;

  if (parking.state !== "online") return null;

  const stateMinutes = Number(parking.state_minutes);
  if (!Number.isFinite(stateMinutes)) return null;
  // 当前 online 段必须从停车那一刻就开始，否则只是刚被 App/哨兵唤醒。
  if (parked - stateMinutes > 5) return null;

  // 充完电车还会醒一阵。
  const chargeEnded = Number(parking.charge_ended_minutes);
  if (Number.isFinite(chargeEnded) && chargeEnded < thresholdMinutes) return null;

  return { parked_minutes: parked, at_home: Boolean(parking.at_home) };
}
