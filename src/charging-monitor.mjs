import { withQueryDeadline } from './query-runtime.mjs';

export async function deliverPendingChargingEvents({
  tracker,
  getRuntimeState,
  saveState,
  sendEvent,
  at = new Date().toISOString()
}) {
  const events = tracker.pendingEvents();
  if (events.length === 0) return { status: "unchanged", events: 0 };
  const state = await getRuntimeState();
  // Bark 模式下没有飞书会话，push_target 由 worker 注入作为投递目标。
  const destination = state.chat_id || state.push_target;
  if (!destination) return { status: "no_chat", events: events.length };
  let delivered = 0;
  let discarded = 0;
  let waiting = 0;
  for (const event of events) {
    if (!tracker.canSend(event, at)) {
      if (tracker.shouldWait(event)) {
        waiting += 1;
        continue;
      }
      tracker.acknowledge(event);
      await saveState(tracker.toJSON());
      discarded += 1;
      continue;
    }
    await sendEvent(destination, event, event.sessionId);
    tracker.acknowledge(event);
    await saveState(tracker.toJSON());
    delivered += 1;
  }
  return {
    status: delivered > 0 ? "delivered" : waiting > 0 ? "waiting" : "discarded",
    events: delivered,
    discarded,
    waiting
  };
}

export function createChargingDatabaseMonitor({
  tracker,
  getLatestProcess,
  getRuntimeState,
  saveState,
  sendEvent,
  onEvents,
  now = () => new Date(),
  timeoutMs = 10_000
}) {
  let running = false;
  return async function checkChargingDatabase() {
    if (running) return { status: "busy", events: 0 };
    running = true;
    try {
      const process = await withQueryDeadline(getLatestProcess, timeoutMs, 'charging database check');
      const observedAt = now().toISOString();
      const before = JSON.stringify(tracker.toJSON());
      const observedEvents = process ? tracker.reconcileProcess(process, observedAt) : [];
      if (observedEvents.length > 0) await onEvents?.(observedEvents, observedAt);
      if (JSON.stringify(tracker.toJSON()) !== before) {
        await saveState(tracker.toJSON());
      }
      const result = await deliverPendingChargingEvents({
        tracker,
        getRuntimeState,
        saveState,
        sendEvent,
        at: observedAt
      });
      if (result.status === "unchanged" && !process) return { status: "empty", events: 0 };
      return result;
    } finally {
      running = false;
    }
  };
}
