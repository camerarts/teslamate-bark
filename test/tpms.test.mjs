import test from "node:test";
import assert from "node:assert/strict";
import { formatTpmsAlert } from "../src/bark.mjs";
import { lowTiresFrom } from "../src/notify.mjs";
import { config } from "../src/config.mjs";

test("胎压低于标准才被挑出来", () => {
  const low = lowTiresFrom({ fl: 2.3, fr: 2.7, rl: 2.59, rr: 2.8 });
  assert.deepEqual(low, [
    { key: "fl", label: "左前", bar: 2.3 },
    { key: "rl", label: "左后", bar: 2.59 }
  ]);
});

test("恰好等于标准值的轮胎不算偏低", () => {
  assert.deepEqual(lowTiresFrom({ fl: 2.6, fr: 2.6, rl: 2.6, rr: 2.6 }), []);
});

test("缺数据的轮位不影响其他轮位判断", () => {
  const low = lowTiresFrom({ fl: null, fr: 2.4, rl: undefined, rr: 2.7 });
  assert.deepEqual(low, [{ key: "fr", label: "右前", bar: 2.4 }]);
});

test("没有任何胎压数据时返回空数组", () => {
  assert.deepEqual(lowTiresFrom(null), []);
});

test("单条轮胎偏低时标题不提数量", () => {
  const { title, body } = formatTpmsAlert({ tires: [{ label: "左前", bar: 2.3 }] });
  assert.equal(title, "🛞 胎压偏低");
  assert.match(body, /左前 2\.30 bar（阈值 2\.60）/);
  assert.match(body, /建议尽快补气/);
});

test("多条轮胎偏低时标题带数量，且按胎压从低到高排列", () => {
  const { title, body } = formatTpmsAlert({
    tires: [{ label: "右后", bar: 2.45 }, { label: "左前", bar: 2.10 }],
    threshold: config.tpmsThresholdBar
  });
  assert.equal(title, "🛞 2 条轮胎胎压偏低");
  const lines = body.split("\n");
  assert.match(lines[0], /左前 2\.10/);
  assert.match(lines[1], /右后 2\.45/);
});
