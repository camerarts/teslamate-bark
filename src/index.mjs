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

// 后台补齐索引，不阻塞推送启动：建索引可能要几分钟，期间推送照常工作。
if (config.ensureIndexes) {
  import("./teslamate.mjs")
    .then(module => module.ensureIndexes({ log }))
    .then(result => {
      if (result.created.length > 0) log(`索引补齐完成：${result.created.join("、")}`);
    })
    .catch(error => log(`索引检查跳过：${error.message}`));
}

await import("./worker.mjs");
