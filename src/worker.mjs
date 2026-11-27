import { config } from "./config.mjs";
import { randomUUID } from 'node:crypto';
import { createEventProcessor, createSerialQueue, safeErrorCode } from './worker-runtime.mjs';
import { connect } from "mqtt";
import { sendChargingEvent, sendCompletedTrip, sendDailySummary, sendLowBatteryAlert, sendMonthlyReport, sendSentryEvent, sendTpmsAlert, sendUnlockedAlert, lowTiresFrom } from "./notify.mjs";
import { barkDestinationEnabled } from "./bark.mjs";
import { createSentryMonitor, parseSentryTopic } from "./sentry-monitor.mjs";
import { ChargingTracker, parseTeslaMateTopic } from "./charging.mjs";
import { createChargingDatabaseMonitor, deliverPendingChargingEvents } from "./charging-monitor.mjs";
import { ensureTeslaMate, getDriveGroup, getDriveMonitorSnapshot, getLatestChargingProcess, getLatestTpms, getParkingState, getVehiclePulse } from "./teslamate.mjs";
import { appendTripSignal, getRuntimeState, markScheduledPush, saveChargingMonitorState, saveTripMonitorState } from "./store.mjs";
import { createTripDatabaseMonitor } from "./trip-monitor.mjs";
import { summarizeTripState, TripSessionTracker, tripBoundaryDefaults } from "./trip-session.mjs";
import { parseVehicleSignalTopic, tripSignalTopics } from "./vehicle-signals.mjs";
import { refreshReferenceFuelPrices } from "./fuel-prices.mjs";
import { dailySummaryTarget, dueScheduledReports, unlockedAlertFor } from "./schedule.mjs";

let stopping = false;
const children = new Set();
const processEvent = createEventProcessor();
const timers = new Set();
const signalWrites = createSerialQueue();
const schedulerQueue = createSerialQueue();
let mqttClient = null;
const chargingQueue = createSerialQueue();
let chargingTracker = null;
let sentryTracker = null;
let checkChargingDatabase = null;
const tripQueue = createSerialQueue();
let tripTracker = null;
let checkTripDatabase = null;

function log(message) {
  process.stdout.write(`[${new Date().toISOString()}] ${message}\n`);
}

// 只走 Bark 时没有飞书会话，为监控器提供一个虚拟投递目标，
// 否则 chat_id 门禁会让行程与充电事件永远停在队列里。
async function getMonitorState() {
  const state = await getRuntimeState();
  if (!state.chat_id && barkDestinationEnabled()) return { ...state, push_target: "bark" };
  return state;
}

function shanghaiParts() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
    weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date());
  return Object.fromEntries(parts.map((item) => [item.type, item.value]));
}

async function checkScheduledPush() {
  const state = await getRuntimeState();
  const now = shanghaiParts();
  const dues = dueScheduledReports(now, state);
  if (dues.length === 0) return;

  // 本项目只做月报；周报保持静默跳过。
  // 必须遍历全部到期项：周报永远排在前面且永不标记已发，
  // 只看第一个候选会让月报被永久挡住。
  const monthly = dues.find((item) => item.period === "previous_month");
  if (!monthly) return;

  const result = await sendMonthlyReport(monthly.key);
  // 空月份也要标记已发，否则整个月每分钟重试。
  await markScheduledPush(monthly.key);
  log(result.status === "empty"
    ? "scheduled previous_month report skipped: no trips"
    : "scheduled previous_month report sent");
}

// 每日小结：21:00 起每小时尝试一次；车辆仍在行驶就顺延到下一个整点。
// 若 23 点还在开车，则在次日 0 点补发前一天的小结，避免整天丢失。
let dailyAttemptedSlot = null;

function shanghaiDateString(offsetDays = 0) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date(Date.now() + offsetDays * 86_400_000)).map((item) => [item.type, item.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

async function checkDailySummary() {
  if (!barkDestinationEnabled()) return;
  const now = shanghaiParts();
  const hour = Number(now.hour);

  const target = dailySummaryTarget(hour, shanghaiDateString(0), shanghaiDateString(-1), config.dailySummaryHour);
  if (!target) return;
  const { dateKey, period, labelOffsetDays } = target;

  // 调度器每 60 秒触发且不与整点对齐，因此用「同一小时只尝试一次」代替分钟数判断。
  const slot = `${dateKey}#${hour}`;
  if (dailyAttemptedSlot === slot) return;
  dailyAttemptedSlot = slot;

  const state = await getRuntimeState();
  const sentKey = `daily:${dateKey}`;
  if (state.sent?.[sentKey]) return;

  const pulse = await getVehiclePulse().catch(() => null);
  if (pulse?.driving) {
    log(`daily summary deferred for ${dateKey}: still driving at ${now.hour}:${now.minute}`);
    return;
  }

  await sendDailySummary({ period, labelOffsetDays, key: dateKey });
  await markScheduledPush(sentKey);
  log(`daily summary sent for ${dateKey}`);
}

// 低电量且未插枪：只在夜间、停在家围栏内触发，一天最多一次。
async function checkLowBattery() {
  if (!barkDestinationEnabled()) return;
  const now = shanghaiParts();
  if (Number(now.hour) < config.lowBatteryHour) return;
  const key = `low-battery:${now.year}-${now.month}-${now.day}`;
  const state = await getRuntimeState();
  if (state.sent?.[key]) return;

  const pulse = await getVehiclePulse().catch(() => null);
  if (!pulse || pulse.charging || pulse.driving || !pulse.at_home) return;
  const level = Number(pulse.battery_level);
  if (!Number.isFinite(level) || level > config.lowBatteryPercent) return;

  await sendLowBatteryAlert(pulse, key);
  await markScheduledPush(key);
  log(`low battery alert sent level=${level}`);
}

// 胎压低于标准就提醒；同一条轮胎每天最多提醒一次，避免刷屏。
const TPMS_STALE_MS = 6 * 3_600_000;
async function checkTpms() {
  if (!barkDestinationEnabled()) return;
  const tpms = await getLatestTpms().catch(() => null);
  if (!tpms) return;
  // 数据太旧说明车长时间没上报，用旧胎压报会误导
  if (Number(tpms.age_seconds) * 1000 > TPMS_STALE_MS) return;

  const low = lowTiresFrom(tpms);
  if (low.length === 0) return;

  const now = shanghaiParts();
  const dateKey = `${now.year}-${now.month}-${now.day}`;
  const state = await getRuntimeState();
  const fresh = low.filter((tire) => !state.sent?.[`tpms:${tire.key}:${dateKey}`]);
  if (fresh.length === 0) return;

  await sendTpmsAlert(fresh, `${dateKey}-${Date.now()}`);
  for (const tire of fresh) await markScheduledPush(`tpms:${tire.key}:${dateKey}`);
  log(`tpms alert sent tires=${fresh.map((tire) => `${tire.label}:${tire.bar}`).join(",")}`);
}

// 停车后忘记锁车：车辆会一直保持唤醒，不会进入休眠。
// 判断「停车满 N 分钟 + 当前仍 online + 这段 online 从停车时就开始 + 不在充电」，
// 每次停车只提醒一次，用 drive_id 做幂等键。
let lastUnlockedCheckAt = 0;
async function checkUnlocked() {
  if (!barkDestinationEnabled()) return;
  // 查询本身很轻，但 60 秒一问没必要，5 分钟一次足够。
  if (Date.now() - lastUnlockedCheckAt < 5 * 60_000) return;
  lastUnlockedCheckAt = Date.now();

  const parking = await getParkingState().catch(() => null);
  if (!parking) return;

  const alert = unlockedAlertFor(parking, config.unlockedAlertMinutes);
  if (!alert) return;

  const key = `unlocked:${parking.drive_id}`;
  const state = await getRuntimeState();
  if (state.sent?.[key]) return;

  const pulse = await getVehiclePulse().catch(() => null);
  await sendUnlockedAlert({ ...alert, at_home: Boolean(pulse?.at_home) }, key);
  await markScheduledPush(key);
  log(`unlocked alert sent drive=${parking.drive_id} parked=${alert.parked_minutes}min`);
}

async function deliverChargingQueue(source, at = new Date().toISOString()) {
  const result = await deliverPendingChargingEvents({
    tracker: chargingTracker,
    getRuntimeState: getMonitorState,
    saveState: saveChargingMonitorState,
    sendEvent: async (_chatId, event, key) => {
      await sendChargingEvent(event, key);
      log(`charging ${event.type} notification sent source=${source}`);
    },
    at
  });
  if (result.status === "no_chat") log(`charging notification pending: no registered chat source=${source}`);
  if (result.discarded > 0) log(`charging stale notification discarded count=${result.discarded} source=${source}`);
  return result;
}

function enqueueCharging(operation) {
  return chargingQueue.enqueue(operation);
}

function enqueueTrip(operation, key) {
  return tripQueue.enqueue(operation, key);
}

function logTripStateTransition(source, before, after) {
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  log(
    `trip state source=${source}`
    + ` phase=${before.phase}->${after.phase}`
    + ` segments=${before.segment_count}->${after.segment_count}`
    + ` pending=${before.pending_count}->${after.pending_count}`
    + ` active=${before.active}->${after.active}`
    + ` boundary=${before.boundary_stage}->${after.boundary_stage}`
    + ` reason=${after.reason}`
  );
}

async function persistTripMutation(operation, source = "mutation") {
  if (!tripTracker) return false;
  const beforeState = tripTracker.toJSON();
  const before = JSON.stringify(beforeState);
  const changed = operation();
  if (changed || JSON.stringify(tripTracker.toJSON()) !== before) {
    await saveTripMonitorState(tripTracker.toJSON());
    logTripStateTransition(
      source,
      summarizeTripState(beforeState),
      summarizeTripState(tripTracker.toJSON())
    );
    return true;
  }
  return false;
}

async function observeTripChargingEvents(events, observedAt) {
  if (!events.some((event) => event.type === "started")) return false;
  return enqueueTrip(() => persistTripMutation(
    () => tripTracker?.observeChargingStarted(observedAt),
    "charging"
  ));
}

async function startTripMonitor() {
  const state = await getRuntimeState();
  tripTracker = new TripSessionTracker(state.trip_monitor);
  const runTripDatabaseCheck = createTripDatabaseMonitor({
    tracker: tripTracker,
    getSnapshot: getDriveMonitorSnapshot,
    getTrip: (segmentIds) => getDriveGroup(segmentIds, {
      pauseMs: tripBoundaryDefaults.inactivityTimeoutMs,
      endpointMeters: 100
    }),
    getRuntimeState: getMonitorState,
    saveState: saveTripMonitorState,
    sendTrip: async (_chatId, event, key) => {
      await sendCompletedTrip(event, key);
      log(`trip notification sent segments=${event.trip.segment_ids.length}`);
    }
  });
  checkTripDatabase = async () => {
    const before = summarizeTripState(tripTracker.toJSON());
    const result = await runTripDatabaseCheck();
    tripLastSuccess = Date.now();
    logTripStateTransition(before.phase === "idle" ? "startup_db" : "database", before, summarizeTripState(tripTracker.toJSON()));
    return result;
  };
  const result = await enqueueTrip(() => checkTripDatabase());
  log(`trip database monitor ready status=${result.status}`);
}

async function startChargingMonitor() {
  const state = await getRuntimeState();
  chargingTracker = new ChargingTracker(state.charging_monitor);
  checkChargingDatabase = createChargingDatabaseMonitor({
    tracker: chargingTracker,
    getLatestProcess: getLatestChargingProcess,
    getRuntimeState: getMonitorState,
    saveState: saveChargingMonitorState,
    sendEvent: async (_chatId, event, key) => {
      await sendChargingEvent(event, key);
      log(`charging ${event.type} notification sent source=database`);
    },
    onEvents: observeTripChargingEvents
  });
  const runChargingCheck = checkChargingDatabase;
  checkChargingDatabase = async () => {
    const result = await runChargingCheck();
    chargingLastSuccess = Date.now();
    return result;
  };
  sentryTracker = createSentryMonitor({
    notify: (kind, context) => {
      sendSentryEvent(kind, context, `${context.carId}:${kind}:${context.at}`)
        .catch((error) => log(`sentry notification failed code=${safeErrorCode(error)}`));
    }
  });
  mqttClient = connect(config.mqttUrl, {
    clientId: `tesla-saving-ticket-${process.pid}`,
    clean: true,
    reconnectPeriod: 3_000,
    connectTimeout: 10_000
  });
  const chargingTopics = [
    "battery_level",
    "plugged_in",
    "charging_state",
    "charge_limit_soc",
    "charger_power",
    "charge_energy_added",
    "time_to_full_charge"
  ].map((field) => `teslamate/cars/+/${field}`);
  const sentryTopics = ["sentry_mode", "state", "locked"].map((field) => `teslamate/cars/+/${field}`);
  const topics = [...new Set([...chargingTopics, ...tripSignalTopics, ...sentryTopics])];

  mqttClient.on("connect", () => {
    mqttClient.subscribe(topics, { qos: 0 }, (error) => {
      if (error) log(`MQTT subscribe failed: ${error.message}`);
      else log("MQTT charging and trip monitors connected");
    });
  });
  mqttClient.on("error", (error) => log(`MQTT error: ${error.message}`));
  mqttClient.on("message", (topic, payload, packet) => {
    if (stopping) return;
    const observedAt = new Date().toISOString();
    const tripSignal = parseVehicleSignalTopic(topic, payload.toString("utf8"));
    if (tripSignal) {
      // Persist independently of the database/Feishu queue so a blocked send
      // cannot prevent a short-lived edge from reaching durable storage.
      signalWrites.enqueue(() => appendTripSignal({
        id: randomUUID(), ...tripSignal, at: observedAt, retained: Boolean(packet?.retain)
      })).then(() => checkTripDatabase && enqueueTrip(checkTripDatabase, 'database'))
        .catch((error) => log(`trip signal check failed code=${safeErrorCode(error)}`));
    }
    const sentrySignal = parseSentryTopic(topic, payload.toString("utf8"));
    if (sentrySignal && sentryTracker) {
      sentryTracker.observe({ ...sentrySignal, at: observedAt });
    }
    const parsed = parseTeslaMateTopic(topic, payload.toString("utf8"));
    if (!parsed) return;
    enqueueCharging(async () => {
      const events = chargingTracker.update(parsed.carId, parsed.field, parsed.value, observedAt);
      if (parsed.field === "charging_state" || events.length > 0) {
        await saveChargingMonitorState(chargingTracker.toJSON());
      }
      await observeTripChargingEvents(events, observedAt);
      await deliverChargingQueue("mqtt", observedAt);
    }).catch((error) => log(`MQTT message failed: ${error.message}`));
  });

  await enqueueCharging(() => checkChargingDatabase())
    .then((result) => log(`charging database monitor ready status=${result.status}`))
    .catch((error) => log(`charging database initial check failed: ${error.message}`));
}

async function boot() {
  log(`worker starting mqtt=${config.mqttUrl} group=${config.notifyGroup}`);
  await refreshReferenceFuelPrices()
    .then((reference) => log(`fuel reference ready date=${reference.display_date} current=${reference.is_current_day}`))
    .catch((error) => log(`fuel reference refresh failed: ${error.message}`));
  ensureTeslaMate().then(() => log("TeslaMate compose services ready")).catch((error) => log(`TeslaMate startup check failed: ${error.message}`));
  await startTripMonitor().catch((error) => log(`trip monitor failed: ${error.message}`));
  await startChargingMonitor().catch((error) => log(`charging monitor failed: ${error.message}`));
  const schedule = () => schedulerQueue.enqueue(async () => {
    await checkScheduledPush();
    await checkDailySummary();
    await checkLowBattery();
    await checkTpms();
    await checkUnlocked();
  }, 'scheduled')
    .catch((error) => log(`scheduler failed code=${safeErrorCode(error)}`));
  schedule();
  every(schedule, 60_000);
  every(() => {
    if (!checkChargingDatabase) return;
    chargingQueue.enqueue(checkChargingDatabase, 'database')
      .catch((error) => log(`charging database check failed: ${error.message}`));
  }, 60_000);
  every(() => {
    if (!checkTripDatabase) return;
    enqueueTrip(checkTripDatabase, 'database')
      .catch((error) => log(`trip database check failed: ${error.message}`));
  }, tripBoundaryDefaults.pollMs);
  every(() => refreshReferenceFuelPrices().catch((error) => log(`fuel reference refresh failed code=${safeErrorCode(error)}`)), 6 * 60 * 60 * 1_000);
  every(reportHealth, 60_000);
}

let tripLastSuccess = null;
let chargingLastSuccess = null;

function every(operation, ms) {
  const timer = setInterval(() => { if (!stopping) operation(); }, ms);
  timer.unref();
  timers.add(timer);
}

async function reportHealth() {
  try {
    const state = await getRuntimeState();
    const pending = state.trip_signal_inbox || [];
    log(`monitor_health consumers=${children.size} mqtt=${Boolean(mqttClient?.connected)}`
      + ` handlers=${processEvent.size}`
      + ` trip_queue=${tripQueue.size} charging_queue=${chargingQueue.size}`
      + ` signal_pending=${pending.length}`
      + ` signal_age_ms=${pending.length ? Math.max(0, Date.now() - Date.parse(pending[0].at)) : 0}`
      + ` trip_success_age_ms=${tripLastSuccess ? Date.now() - tripLastSuccess : -1}`
      + ` charging_success_age_ms=${chargingLastSuccess ? Date.now() - chargingLastSuccess : -1}`);
  } catch (error) { log(`monitor_health failed code=${safeErrorCode(error)}`); }
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log(`worker stopping signal=${signal}`);
  for (const timer of timers) clearInterval(timer);
  for (const child of children) child.kill("SIGTERM");
  mqttClient?.end(true);
  const deadline = setTimeout(() => process.exit(0), 15_000);
  await signalWrites.drain();
  await Promise.all([tripQueue.drain(), chargingQueue.drain(), schedulerQueue.drain(), processEvent.drain()]);
  clearTimeout(deadline);
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("uncaughtException", (error) => log(`uncaught exception: ${error.message}`));
process.on("unhandledRejection", (error) => log(`unhandled rejection: ${error?.message || error}`));

await boot();
