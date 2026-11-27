// 哨兵感知：TeslaMate 只提供 sentry_mode 的开/关状态，拿不到「录了几段」。
// 这里用两个可观测信号做近似：哨兵开关变化，以及哨兵期间车辆从休眠被唤醒。
const SENTRY_FIELDS = Object.freeze({
  "sentry_mode": "sentry",
  "state": "state",
  "locked": "locked"
});

export function parseSentryTopic(topic, payload) {
  const match = /^teslamate\/cars\/([^/]+)\/(sentry_mode|state|locked)$/.exec(String(topic));
  if (!match) return null;
  const raw = String(payload).trim();
  if (raw === "") return null;
  const [, carId, field] = match;
  const value = field === "state" ? raw : raw === "true" ? true : raw === "false" ? false : null;
  if (value === null) return null;
  return { carId, field: SENTRY_FIELDS[field], value };
}

export function createSentryMonitor({
  notify = () => {},
  now = () => new Date().toISOString(),
  nowMs = () => Date.now(),
  cooldownMs = 3 * 60 * 1_000
} = {}) {
  const cars = new Map();
  const lastTriggered = new Map();

  function entry(carId) {
    let current = cars.get(carId);
    if (!current) {
      // null 表示「尚未观测过」，用来区分启动基线与真实变化，避免重启瞬间误报。
      current = { sentry: null, state: null, locked: null };
      cars.set(carId, current);
    }
    return current;
  }

  function emit(kind, carId, at) {
    try {
      notify(kind, { carId, at });
    } catch { /* 通知失败不能影响信号处理链路 */ }
  }

  return {
    observe({ carId, field, value, at = now() }) {
      if (!carId) return null;
      const current = entry(carId);

      if (field === "sentry") {
        const previous = current.sentry;
        current.sentry = Boolean(value);
        if (previous === null) return null;
        if (previous !== current.sentry) {
          emit(current.sentry ? "enabled" : "disabled", carId, at);
          return current.sentry ? "enabled" : "disabled";
        }
        return null;
      }

      if (field === "state") {
        const previous = current.state;
        current.state = String(value);
        if (current.sentry !== true) return null;
        if (previous !== "asleep" || current.state === "asleep") return null;
        const last = lastTriggered.get(carId) || 0;
        if (nowMs() - last < cooldownMs) return null;
        lastTriggered.set(carId, nowMs());
        emit("triggered", carId, at);
        return "triggered";
      }

      if (field === "locked") {
        const previous = current.locked;
        current.locked = Boolean(value);
        if (previous === null) return null;
        if (current.sentry === true && previous === true && current.locked === false) {
          emit("unlocked", carId, at);
          return "unlocked";
        }
        return null;
      }

      return null;
    },
    toJSON() {
      return Object.fromEntries(cars);
    },
    restore(snapshot = {}) {
      cars.clear();
      for (const [carId, value] of Object.entries(snapshot || {})) {
        if (!value || typeof value !== "object") continue;
        cars.set(carId, {
          sentry: value.sentry === undefined ? null : value.sentry,
          state: value.state === undefined ? null : value.state,
          locked: value.locked === undefined ? null : value.locked
        });
      }
    },
    reset() {
      cars.clear();
      lastTriggered.clear();
    }
  };
}
