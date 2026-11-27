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

#### 从哪里获取

**最省事的办法**：运行 `./scripts/install-existing.sh --dry-run`，它会自动探测并打印（密码已打码）：

```
TESLAMATE_DATABASE_URL=postgresql://teslamate:***@database:5432/teslamate
```

**手工拼**：三个部分分别来自 TeslaMate 的 compose 文件

```yaml
environment:
  - POSTGRES_USER=teslamate      # → 用户名
  - POSTGRES_PASSWORD=xxxxx      # → 密码
  - POSTGRES_DB=teslamate        # → 数据库名
```

主机填**数据库的 compose 服务名**（通常是 `database`），端口 `5432`。

**实在不知道密码**：直接从容器里读

```bash
docker inspect <数据库容器名> --format '{{range .Config.Env}}{{println .}}{{end}}' | grep POSTGRES_
```

#### 两个常见坑

**不要写 `127.0.0.1`。** 在容器里 `127.0.0.1` 指的是容器自己，连不上数据库。要用服务名，或者宿主机内网 IP。

**TeslaMate 的数据库通常没有映射到宿主机端口。** 所以从宿主机上的普通进程连不上，必须让本服务也加入同一个 Docker 网络（`docker-compose.existing.yml` 已经处理了这一点）。

#### 权限建议

建议为本服务单独建只读账号，而不是直接用 `teslamate` 超级用户，见 [SECURITY.md](../SECURITY.md)。

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
| `UNLOCK_ALERT_MINUTES` | `30` | 停车超过这么多分钟车辆仍未休眠时，提醒可能没锁车。设为 `0` 关闭该提醒 |
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

## 索引自检（TeslaMate v4 及以上）

TeslaMate v4 把 `positions` 表按 `drive_id`、`car_id` 的 B-tree 索引换成了 BRIN
（`positions_drive_id_date_timestamp_minmax_multi_ops_index` 等）。
BRIN 体积只有几百 KB，对 TeslaMate 自己按时间范围取数据够用，
但本项目大量执行「按一趟行程取点位」「按车取最新一条」这类查询，
BRIN 在这些访问上没有选择性，会退化成整表扫描。

实测（923 万行 `positions`）：

| 查询 | 仅有 BRIN | 补齐 B-tree |
|---|---|---|
| 最新行程 | 95 秒 | 40 毫秒 |
| 每日小结统计 | 18 秒 | 44 毫秒 |
| 当前车辆状态 | 22 秒 | 22 毫秒 |

程序启动时会在后台检查并补齐这两个索引，**不阻塞推送**，缺权限只记录告警：

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS positions_drive_id_btree_index
  ON public.positions USING btree (drive_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS positions_car_id_date_desc_index
  ON public.positions USING btree (car_id, date DESC);
```

`CONCURRENTLY` 不会阻塞 TeslaMate 写入，但建索引期间会占用额外的磁盘与 IO：
`positions` 每百万行约需 30 MB 空间，建议留出 500 MB 余量。

如果使用的是只读账号（推荐做法），自动建索引会因权限不足而跳过。
此时请用数据库管理员账号手动执行上面的 SQL，或把 `ENSURE_INDEXES` 设为 `false`
关闭自检，避免每次启动重复尝试。

> v3 及更早版本无需处理，其默认索引已经是 B-tree。

