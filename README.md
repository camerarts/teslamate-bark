# teslamate-bark

把 [TeslaMate](https://github.com/teslamate-org/teslamate) 的数据变成手机上的 Bark 推送：行程结束、充电完成、哨兵异动、胎压偏低、低电量提醒，外加每天一条小结和每月一份驾驶报告。

![license](https://img.shields.io/badge/license-MIT-blue.svg)
![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)

---

## 它解决什么问题

TeslaMate 数据很全，但你不会一直盯着 Grafana 看。真正需要在几秒钟内知道的只有几件事：

- 这趟开了多远、耗了多少电、比我开油车省多少
- 充完了没有、充到多少、花了多少钱
- 有没有人不该动我的车
- 轮胎有没有被扎
- 明早出门够不够电

这个项目只做这件事：**订阅 TeslaMate 的事件，翻译成人话，推到 Bark。**

它不采集车辆数据，也不替代 TeslaMate。它读 TeslaMate 写的数据库和 MQTT 主题。

---

## 通知清单

| 通知 | 触发条件 | 推送级别 |
|---|---|---|
| 行程结束 | 一段行程结束并入库 | 静默（不弹窗）|
| 开始充电 | 插枪开始充电 | 正常 |
| 即将充满 | 距离设定上限约 15 分钟 | 正常 |
| 充电完成 | 充电结束 | 正常 |
| 充电意外中断 | 结束电量比设定上限低 5% 以上 | 时效性 |
| 哨兵已开启 / 已关闭 | 哨兵开关状态变化 | 正常 |
| 哨兵疑似被触发 | 哨兵期间车辆从休眠被唤醒 | 时效性 + 警报音 |
| 哨兵期间被解锁 | 哨兵期间车锁由锁止变解锁 | 时效性 + 警报音 |
| 胎压偏低 | 任一轮胎低于阈值（默认 2.6 bar）| 正常 |
| 低电量未充电 | 夜间、停在家、电量低于阈值且未插枪 | 时效性 |
| 每日小结 | 每天 21:00 起；还在开车就每小时顺延 | 正常 |
| 月度报告 | 每月 1 号 08:00，统计上一个自然月 | 正常 |

每条通知的字段、文案与去重规则见 [docs/notifications.md](docs/notifications.md)。

---

## 工作原理

```
┌─────────────┐     MQTT (实时信号)      ┌──────────────────┐
│  TeslaMate  │ ───────────────────────► │                  │
│             │                          │  teslamate-bark  │
│  PostgreSQL │ ◄─────────────────────── │                  │
└─────────────┘   SQL (补全/兜底/统计)    └────────┬─────────┘
                                                   │ HTTPS
                                                   ▼
                                            ┌─────────────┐
                                            │  Bark App   │
                                            └─────────────┘
```

两条数据通路各有分工：

- **MQTT** 负责「刚刚发生了什么」，延迟低，用于充电状态、哨兵信号这类需要即时反应的场景。
- **数据库** 负责「事情的全貌」，用于补全地点、电量、费用，以及每日/月度统计；也作为 MQTT 丢消息后的兜底轮询。

这种双通路设计的好处是：容器重启、MQTT 断连、消息遗漏，都不会导致事件丢失——数据库轮询会把落下的补回来，而幂等键保证不会重复推送。

---

## 快速开始

### 前置条件

1. 已经跑起来的 TeslaMate（含 PostgreSQL 与 Mosquitto）
2. 手机装了 [Bark](https://apps.apple.com/app/bark-customed-notifications/id1403753865)，拿到推送 key

### 方式一：Docker（推荐）

```bash
git clone https://github.com/camerarts/teslamate-bark.git
cd teslamate-bark

cp .env.example .env
# 编辑 .env，至少填 BARK_KEY 和 TESLAMATE_DATABASE_URL

docker compose up -d
docker compose logs -f
```

如果 TeslaMate 和本服务在同一个 compose 项目里，把 `docker-compose.yml` 末尾的 `networks` 注释打开，并把 `.env` 里的主机名改成服务名（如 `database`、`mosquitto`）。

### 方式二：直接跑 Node

```bash
npm install
cp .env.example .env   # 填好配置
npm start
```

需要 Node.js 22 以上。

### 验证配置

启动日志会打印连接目标和通知分组：

```
[2026-11-27T03:37:20.835Z] worker starting mqtt=mqtt://127.0.0.1:1883 group=特斯拉小管家
[2026-11-27T03:37:21.258Z] TeslaMate compose services ready
[2026-11-27T03:37:22.298Z] MQTT charging and trip monitors connected
```

看到 `MQTT ... monitors connected` 就说明通了。之后开车或充电时会自动推送，不需要额外操作。

---

## 配置项

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `BARK_KEY` | ✅ | — | Bark 推送 key |
| `TESLAMATE_DATABASE_URL` | ✅ | — | PostgreSQL 连接串 |
| `MQTT_URL` | | `mqtt://127.0.0.1:1883` | TeslaMate 的 MQTT 地址 |
| `BARK_SERVER` | | `https://api.day.app` | 自建 Bark 时修改 |
| `BARK_CLICK_URL` | | 空 | 点击通知跳转的地址 |
| `NOTIFY_GROUP` | | `特斯拉小管家` | 通知分组名 |
| `TIME_ZONE` | | `Asia/Shanghai` | 影响小结与月报的日期归属 |
| `TPMS_THRESHOLD_BAR` | | `2.6` | 胎压提醒阈值 |
| `LOW_BATTERY_PERCENT` | | `20` | 低电量提醒阈值 |
| `LOW_BATTERY_HOUR` | | `21` | 低电量提醒起始小时 |
| `DAILY_SUMMARY_HOUR` | | `21` | 每日小结起始小时 |
| `DEFAULT_ELECTRICITY_PRICE` | | 空 | 首次启动时初始化的电价（元/度）|
| `DATA_DIR` | | `./data` | 状态文件目录，容器里一般是 `/data` |

完整说明见 [docs/configuration.md](docs/configuration.md)。

---

## 通知长什么样

**行程结束**（静默推送，不打扰）

```
🚗 行程结束 · 2.6 km
🕐 08:21 → 08:26 · 5 分钟
📍 海天路 → 小港街道
⚡ 0.34 kWh · 131 Wh/km · ¥0.12
🔋 电量 93% → 92% · 续航 362 → 359 km
⛽ 油车 ¥1.28–1.65 · 省 ¥1.16
```

**充电意外中断**（本该充到 95%，充到 62% 就断了）

```
⚠️ 充电意外中断
🔋 62% / 目标 95%
⚡ 已充 18.20 kWh · 2 小时 10 分
📍 小港街道
👉 请检查充电桩或插枪状态
```

**每日小结**

```
📅 11 月 27 日小结
🚗 2 趟 · 8.0 km
⏱ 24 分钟
⚡ 1.4 度 · 电费 ¥0.50
🔋 当前电量 92%
```

**月度报告**

```
📊 10 月驾驶报告
🚗 165 趟 · 1,746 km
⏱ 56 小时 15 分 · 均速 31 km/h
⚡ 行驶能耗 243.6 度
⛽ 油车 ¥859–1,107 · 省 ¥746
🔌 充电 10 次 · 314.9 度
💰 预估电费 ¥113.36（0.36 元/度）
```

**胎压偏低**

```
🛞 胎压偏低
⚠️ 左后 2.42 bar（阈值 2.60）
👉 建议尽快补气
```

---

## 设计取舍

几个刻意的决定，理解它们能少踩坑：

**行程推送默认静默。** 一个月 165 趟行程，如果每趟都弹窗，你会开始无视所有通知——包括真正重要的那些。行程用 `passive` 级别进通知中心，充电和告警才打扰你。

**电量与续航用「起点位置 + drives 表」两处取数。** TeslaMate 并不在每条位置记录里都存续航，起点那条经常是空的，必须回退到 `drives.start_ideal_range_km`。

**胎压用绝对阈值，不做相对比较。** 相对比较（某条比其余三条低 0.25 bar）能更早发现扎钉，但换季时四条会同时涨落，容易误报。默认给了保守的绝对阈值，你可以按需改。

**充电中断判定依赖设定上限。** 这个值只存在于实时数据流里，数据库不存。如果容器重启后还没收到该数据，就无法判断中断，会退化成普通的「充电完成」——这是已知取舍。

**每日小结会避让驾驶。** 21:00 若还在开车，就等到 22:00、23:00……直到停车；如果一直开到跨零点，会在次日 0 点、1 点各补发一次，避免整天的数据丢失。

---

## 开发

```bash
npm test          # 全部单元测试
npm test -- --watch
```

测试覆盖文案渲染、去重、时间边界、状态机迁移等纯逻辑，不依赖真实数据库。

```
src/
├── index.mjs              入口：校验配置 → 初始化电价 → 启动监控
├── config.mjs             环境变量读取与校验
├── notify.mjs             事件 → 文案 → 推送
├── bark.mjs               Bark 协议与各类消息模板
├── worker.mjs             MQTT 订阅、数据库轮询、定时调度
├── charging.mjs           充电状态机
├── sentry-monitor.mjs     哨兵信号推断
├── trip-session.mjs       行程边界判定
├── trip-monitor.mjs       行程数据库监控
├── teslamate.mjs          所有 SQL 查询
├── schedule.mjs           月报/小结的触发时机
├── store.mjs              运行时状态持久化
├── daily-summary.mjs      每日小结模板
└── monthly-report.mjs     月度报告模板
```

---

## 常见问题

**收不到推送？**
先看 `docker compose logs`：没有 `MQTT ... monitors connected` 说明 MQTT 没连上；有连接但没推送，检查 Bark key 是否填对（用浏览器打开 `https://api.day.app/<你的key>/测试/内容` 验证）。

**行程推送没有声音、没有弹窗？**
这是设计如此。行程用 `passive` 级别，只进通知中心。想要弹窗可以改 `src/notify.mjs` 里 `sendCompletedTrip` 的 `level`。

**电费全是 ¥0.00？**
没有配置电价。设 `DEFAULT_ELECTRICITY_PRICE` 后删掉 `data/processed/` 重新启动，或在状态文件里补一条电价记录。

**数据库连不上？**
容器里不能用 `127.0.0.1`，要写 TeslaMate 的 compose 服务名（如 `database`）。手动跑 Node 时如果不在一台机器上，确认 5432 端口可达。

---

## 致谢

本项目从 [tesla-butler](https://github.com/manwithshit/tesla-butler) 衍生而来，保留了其经过验证的状态机与数据库层，移除了飞书通知路径，聚焦 Bark 单一通道。

## License

[MIT](LICENSE)
