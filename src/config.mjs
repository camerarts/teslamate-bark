import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(srcDir, "..");
// DATA_ROOT 用于把整个运行目录搬到别处（容器里通常是 /data），
// DATA_DIR 可以再单独指定状态文件位置。
const rootDir = process.env.DATA_ROOT || projectRoot;
const dataDir = process.env.DATA_DIR || path.join(rootDir, "data");

// 配置优先级：真实环境变量 > 项目根目录的 .env。
// .env 已被 .gitignore 排除，避免把 Bark key 和数据库密码提交进仓库。
function loadDotEnv() {
  let text;
  try {
    text = fs.readFileSync(path.join(rootDir, ".env"), "utf8");
  } catch {
    return;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length > 1 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadDotEnv();

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

export const config = Object.freeze({
  root: rootDir,
  dataDir,
  timeZone: process.env.TIME_ZONE || "Asia/Shanghai",

  mqttUrl: process.env.MQTT_URL || "mqtt://127.0.0.1:1883",
  teslamateDatabaseUrl: process.env.TESLAMATE_DATABASE_URL || "",

  barkKey: process.env.BARK_KEY || "",
  barkServer: process.env.BARK_SERVER || "https://api.day.app",
  // 点击通知跳转的地址，通常指向你的 TeslaMate 或 Grafana 面板。
  barkClickUrl: process.env.BARK_CLICK_URL || "",
  notifyGroup: process.env.NOTIFY_GROUP || "特斯拉小管家",
  // 首次启动若状态文件里没有电价，用这个值初始化，避免费用行一直是空的。
  defaultElectricityPrice: numberFromEnv("DEFAULT_ELECTRICITY_PRICE", NaN),

  // 告警阈值，全部可通过环境变量调整，无需改代码。
  tpmsThresholdBar: numberFromEnv("TPMS_THRESHOLD_BAR", 2.6),
  lowBatteryPercent: numberFromEnv("LOW_BATTERY_PERCENT", 20),
  lowBatteryHour: numberFromEnv("LOW_BATTERY_HOUR", 21),
  dailySummaryHour: numberFromEnv("DAILY_SUMMARY_HOUR", 21),

  // TeslaMate v4+ 把 positions 的索引换成了 BRIN，按行程/按车查询会退化成全表扫描。
  // 默认在启动期自动补齐 B-tree 索引；没有建索引权限时可设为 false 关闭。
  ensureIndexes: process.env.ENSURE_INDEXES !== "false"
});

export function projectPath(...parts) {
  return path.join(config.root, ...parts);
}

// 运行时状态与缓存统一放在 DATA_DIR 下，容器部署时挂载这个目录即可持久化。
export function dataPath(...parts) {
  return path.join(config.dataDir, ...parts);
}

// 启动时校验，避免跑到第一次推送才发现缺配置。
export function assertConfig() {
  const missing = [];
  if (!config.teslamateDatabaseUrl) missing.push("TESLAMATE_DATABASE_URL");
  if (!config.barkKey) missing.push("BARK_KEY");
  if (missing.length > 0) {
    throw new Error(`缺少必需配置：${missing.join("、")}。请复制 .env.example 为 .env 并填写。`);
  }
}
