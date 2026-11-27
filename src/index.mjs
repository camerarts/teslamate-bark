// 程序入口：先校验配置，再初始化默认电价，最后启动监控。
// 用动态 import 是为了让配置错误在连 MQTT 之前就报出来。
import { assertConfig, config } from "./config.mjs";
import { log } from "./logger.mjs";

try {
  assertConfig();
} catch (error) {
  log(`配置错误：${error.message}`);
  process.exit(1);
}

// 只在状态文件里还没有电价时才写入，避免覆盖用户后来改过的值。
if (Number.isFinite(config.defaultElectricityPrice) && config.defaultElectricityPrice > 0) {
  const { getPricingSettings, setDefaultElectricityRate } = await import("./store.mjs");
  const settings = await getPricingSettings().catch(() => null);
  if (settings && settings.default_rate_history.length === 0) {
    await setDefaultElectricityRate(config.defaultElectricityPrice, { source: "env" });
    log(`默认电价初始化为 ${config.defaultElectricityPrice} 元/度（来自 DEFAULT_ELECTRICITY_PRICE）`);
  }
}

await import("./worker.mjs");
