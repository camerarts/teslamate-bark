import test from "node:test";
import assert from "node:assert/strict";
import { formatUnlockedAlert } from "../src/bark.mjs";
import { unlockedAlertFor } from "../src/schedule.mjs";

test("未锁提醒文案带上停车时长和位置", () => {
  const home = formatUnlockedAlert({ parked_minutes: 34, at_home: true });
  assert.equal(home.title, "🔓 车辆可能没锁");
  assert.match(home.body, /34 分钟/);
  assert.match(home.body, /家附近/);

  const outside = formatUnlockedAlert({ parked_minutes: 41, at_home: false });
  assert.match(outside.body, /停在外面/);
});

test("缺停车时长时不显示 undefined", () => {
  const { body } = formatUnlockedAlert({});
  assert.ok(!body.includes("undefined"));
  assert.ok(!body.includes("NaN"));
});

test("停车不足阈值不提醒", () => {
  assert.equal(unlockedAlertFor({
    parked_minutes: 25, state: "online", state_minutes: 24,
    driving: false, charging: false
  }, 30), null);
});

test("阈值可配置", () => {
  assert.equal(unlockedAlertFor({
    parked_minutes: 25, state: "online", state_minutes: 24,
    driving: false, charging: false
  }, 20)?.parked_minutes, 25);
});

test("阈值设为 0 表示关闭未锁提醒", () => {
  const parking = {
    driving: false, charging: false, parked_minutes: 90,
    state: "online", state_minutes: 88, charge_ended_minutes: 300
  };
  assert.equal(unlockedAlertFor(parking, 0), null);
  assert.ok(unlockedAlertFor(parking, 30));
});
