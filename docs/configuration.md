# 配置说明

配置优先级：**真实环境变量 > 项目根目录的 `.env` 文件 > 代码内置默认值**。

`.env` 已在 `.gitignore` 中排除，可以放心存放凭证。

## 必填项

### `BARK_KEY`

Bark App 首页给出的推送地址形如 `https://api.day.app/AbCdEf123456/`，其中 `AbCdEf123456` 就是 key。

验证方式：浏览器打开

```
https://api.day.app/<你的key>/测试/这是一条测试推送
```

手机上收到即说明 key 正确。

### `TESLAMATE_DATABASE_URL`

标准 PostgreSQL 连接串：

```
postgresql://用户名:密码@主机:端口/数据库名
```

**容器部署时不要写 `127.0.0.1`**——那是容器自己。应写 TeslaMate 的 compose 服务名，例如：

```
postgresql://teslamate:password@database:5432/teslamate
```

如果 TeslaMate 与本服务不在同一个 compose 项目，需要把它们接到同一个 Docker 网络，或使用宿主机的内网地址。

建议用只读账号，见 [SECURITY.md](../SECURITY.md)。

## 连接

| 变量 | 默认 | 说明 |
|---|---|---|
| `MQTT_URL` | `mqtt://127.0.0.1:1883` | TeslaMate 的 Mosquitto 地址。容器里同样要用服务名，如 `mqtt://mosquitto:1883` |

MQTT 只用于订阅，不需要发布权限。

## 推送

| 变量 | 默认 | 说明 |
|---|---|---|
| `BARK_SERVER` | `https://api.day.app` | 自建 Bark 服务端地址，末尾不要带斜杠 |
| `BARK_CLICK_URL` | 空 | 点击通知打开的地址。填你的 TeslaMate 或 Grafana 面板地址，收到「行程结束」点一下就能看轨迹 |
| `NOTIFY_GROUP` | `特斯拉小管家` | Bark 的 `group` 字段，用于在 App 内归类、批量清理 |

## 阈值

| 变量 | 默认 | 说明 |
|---|---|---|
| `TPMS_THRESHOLD_BAR` | `2.6` | 胎压提醒阈值。**注意这不是标准胎压**（Model Y 约 2.9），而是「怀疑扎钉」的下限。调到 2.9 会因季节波动频繁误报 |
| `LOW_BATTERY_PERCENT` | `20` | 低于此值且在家未充电时提醒 |
| `LOW_BATTERY_HOUR` | `21` | 早于此小时不提醒，避免白天误报 |
| `DAILY_SUMMARY_HOUR` | `21` | 小结起始小时。设成 20 则 20:00 开始尝试 |

## 费用

| 变量 | 默认 | 说明 |
|---|---|---|
| `DEFAULT_ELECTRICITY_PRICE` | 空 | 首次启动且状态文件里没有电价时，用此值初始化（元/度）。之后不会被覆盖 |

费用只用于推送里的估算，不影响 TeslaMate 自己的记账。

## 数据目录

| 变量 | 默认 | 说明 |
|---|---|---|
| `DATA_DIR` | `./data` | 状态文件目录，容器里默认 `/data`。**必须持久化**，否则重启后去重记录丢失，可能重复推送 |
| `DATA_ROOT` | 项目根目录 | 整体迁移运行目录时使用，`DATA_DIR` 未指定则取 `<DATA_ROOT>/data` |

目录内会产生：

```
data/processed/runtime-state.json    # 监控状态、已推送记录、行程信号队列
data/processed/reference-fuel-prices.json  # 油价缓存
```

## 完整示例

```bash
# 必填
BARK_KEY=AbCdEf123456
TESLAMATE_DATABASE_URL=postgresql://teslamate_ro:secret@database:5432/teslamate

# 连接
MQTT_URL=mqtt://mosquitto:1883

# 推送
BARK_CLICK_URL=https://teslamate.example.com
NOTIFY_GROUP=我的 Model Y

# 阈值（按需）
TPMS_THRESHOLD_BAR=2.6
LOW_BATTERY_PERCENT=25
DAILY_SUMMARY_HOUR=21

# 费用
DEFAULT_ELECTRICITY_PRICE=0.36

# 数据
DATA_DIR=/data
```
