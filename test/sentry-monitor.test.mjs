import test from "node:test";
import assert from "node:assert/strict";
import { createSentryMonitor, parseSentryTopic } from "../src/sentry-monitor.mjs";

function createHarness({ cooldownMs = 3 * 60 * 1_000 } = {}) {
  const events = [];
  let clock = 1_700_000_000_000;
  const monitor = createSentryMonitor({
    notify: (kind, context) => events.push({ kind, carId: context.carId, at: context.at }),
    now: () => new Date(clock).toISOString(),
    nowMs: () => clock,
    cooldownMs
  });
  return { monitor, events, advance: (ms) => { clock += ms; } };
}

test("parseSentryTopic 只接受哨兵相关的三种主题", () => {
  assert.deepEqual(parseSentryTopic("teslamate/cars/1/sentry_mode", "true"), { carId: "1", field: "sentry", value: true });
  assert.deepEqual(parseSentryTopic("teslamate/cars/2/state", "asleep"), { carId: "2", field: "state", value: "asleep" });
  assert.deepEqual(parseSentryTopic("teslamate/cars/1/locked", "false"), { carId: "1", field: "locked", value: false });
  assert.equal(parseSentryTopic("teslamate/cars/1/state", ""), null);
  assert.equal(parseSentryTopic("teslamate/cars/1/battery_level", "80"), null);
  assert.equal(parseSentryTopic("teslamate/cars/1/sentry_mode", "maybe"), null);
});

test("首次观测只建立基线，不推送", () => {
  const { monitor, events } = createHarness();
  monitor.observe({ carId: "1", field: "sentry", value: true });
  monitor.observe({ carId: "1", field: "state", value: "asleep" });
  monitor.observe({ carId: "1", field: "locked", value: true });
  assert.equal(events.length, 0);
});

test("哨兵开启与关闭各推送一次", () => {
  const { monitor, events } = createHarness();
  monitor.observe({ carId: "1", field: "sentry", value: false });
  monitor.observe({ carId: "1", field: "sentry", value: true });
  monitor.observe({ carId: "1", field: "sentry", value: true });
  monitor.observe({ carId: "1", field: "sentry", value: false });
  assert.deepEqual(events.map((event) => event.kind), ["enabled", "disabled"]);
});

test("哨兵开启期间被唤醒算作疑似触发，冷却期内不重复推送", () => {
  const { monitor, events, advance } = createHarness({ cooldownMs: 60_000 });
  monitor.observe({ carId: "1", field: "sentry", value: true });
  monitor.observe({ carId: "1", field: "state", value: "asleep" });
  monitor.observe({ carId: "1", field: "state", value: "online" });
  monitor.observe({ carId: "1", field: "state", value: "asleep" });
  monitor.observe({ carId: "1", field: "state", value: "online" });
  assert.deepEqual(events.map((event) => event.kind), ["triggered"]);
  advance(61_000);
  monitor.observe({ carId: "1", field: "state", value: "asleep" });
  monitor.observe({ carId: "1", field: "state", value: "online" });
  assert.deepEqual(events.map((event) => event.kind), ["triggered", "triggered"]);
});

test("哨兵未开启时唤醒不推送", () => {
  const { monitor, events } = createHarness();
  monitor.observe({ carId: "1", field: "sentry", value: false });
  monitor.observe({ carId: "1", field: "state", value: "asleep" });
  monitor.observe({ carId: "1", field: "state", value: "online" });
  assert.equal(events.length, 0);
});

test("哨兵开启期间车辆被解锁会推送", () => {
  const { monitor, events } = createHarness();
  monitor.observe({ carId: "1", field: "sentry", value: true });
  monitor.observe({ carId: "1", field: "locked", value: true });
  monitor.observe({ carId: "1", field: "locked", value: false });
  assert.deepEqual(events.map((event) => event.kind), ["unlocked"]);
});

test("多辆车各自维护状态，互不干扰", () => {
  const { monitor, events } = createHarness();
  monitor.observe({ carId: "1", field: "sentry", value: false });
  monitor.observe({ carId: "2", field: "sentry", value: false });
  monitor.observe({ carId: "1", field: "sentry", value: true });
  assert.deepEqual(events.map((event) => event.carId), ["1"]);
});
