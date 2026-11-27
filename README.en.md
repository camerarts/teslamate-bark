# teslamate-bark

Turn your [TeslaMate](https://github.com/teslamate-org/teslamate) data into Bark notifications on your phone: trips, charging, sentry events, tire pressure, low battery — plus a daily summary and a monthly report.

![license](https://img.shields.io/badge/license-MIT-blue.svg)
![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)

[简体中文](README.md) · English

---

## Why

TeslaMate records everything, but you don't stare at Grafana all day. What you actually want to know within seconds:

- How far did that trip go, how much energy, how much cheaper than petrol?
- Is charging done, to what level, and what did it cost?
- Is someone touching my car?
- Is a tire punctured?
- Will I have enough charge tomorrow morning?

This service only does that: **subscribe to TeslaMate events, turn them into readable text, push them to Bark.** It does not collect vehicle data and does not replace TeslaMate — it reads TeslaMate's database and MQTT topics.

---

## Notifications

| Notification | Trigger | Level |
|---|---|---|
| Trip finished | A trip is finalized | Passive (no banner) |
| Charging started | Plugged in | Active |
| Almost full | ~15 min before charge limit | Active |
| Charging complete | Charging ends | Active |
| Charging interrupted | Ends 5%+ below the configured limit | Time-sensitive |
| Sentry on / off | Sentry mode toggles | Active |
| Sentry likely triggered | Car wakes from sleep while sentry is on | Time-sensitive + alarm |
| Unlocked while in sentry | Lock goes locked → unlocked | Time-sensitive + alarm |
| Low tire pressure | Any tire below threshold (default 2.6 bar) | Active |
| Low battery, not charging | Evening, parked at home, below threshold | Time-sensitive |
| Daily summary | From 21:00 daily, deferred hourly while driving | Active |
| Monthly report | 1st of each month at 08:00, previous month | Active |

Field-level details and dedupe rules: [docs/notifications.md](docs/notifications.md) (Chinese).

---

## How it works

```
┌─────────────┐        MQTT              ┌──────────────────┐
│  TeslaMate  │ ───────────────────────► │                  │
│             │                          │  teslamate-bark  │
│  PostgreSQL │ ◄─────────────────────── │                  │
└─────────────┘      SQL queries         └────────┬─────────┘
                                                   │ HTTPS
                                                   ▼
                                            ┌─────────────┐
                                            │  Bark App   │
                                            └─────────────┘
```

Two data paths, each with a job:

- **MQTT** answers "what just happened" — low latency, used for charging state and sentry signals.
- **Database** answers "what actually happened" — used to enrich location/energy/cost and to compute daily and monthly aggregates. It also backstops missed MQTT messages.

Because of this, restarts and MQTT gaps don't lose events: the database poller catches up, and idempotency keys prevent duplicates.

---

## Quick start

### Docker (recommended)

```bash
git clone https://github.com/<your-name>/teslamate-bark.git
cd teslamate-bark

cp .env.example .env
# fill in BARK_KEY and TESLAMATE_DATABASE_URL at minimum

docker compose up -d
docker compose logs -f
```

If TeslaMate runs in the same compose project, uncomment the `networks` block at the bottom of `docker-compose.yml` and use service names (`database`, `mosquitto`) in `.env`.

### Node

```bash
npm install
cp .env.example .env
npm start
```

Requires Node.js 22+.

### Verify

```
[2026-11-27T03:37:22.298Z] MQTT charging and trip monitors connected
```

That line means everything is wired up.

---

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `BARK_KEY` | ✅ | — | Bark push key |
| `TESLAMATE_DATABASE_URL` | ✅ | — | PostgreSQL connection string |
| `MQTT_URL` | | `mqtt://127.0.0.1:1883` | TeslaMate MQTT broker |
| `BARK_SERVER` | | `https://api.day.app` | For self-hosted Bark |
| `BARK_CLICK_URL` | | empty | URL opened when tapping a notification |
| `NOTIFY_GROUP` | | `特斯拉小管家` | Notification group name |
| `TIME_ZONE` | | `Asia/Shanghai` | Affects daily/monthly boundaries |
| `TPMS_THRESHOLD_BAR` | | `2.6` | Tire pressure alert threshold |
| `LOW_BATTERY_PERCENT` | | `20` | Low battery threshold |
| `LOW_BATTERY_HOUR` | | `21` | Earliest hour for low battery alerts |
| `DAILY_SUMMARY_HOUR` | | `21` | Daily summary start hour |
| `DEFAULT_ELECTRICITY_PRICE` | | empty | Initial price (per kWh) when none is stored |
| `DATA_DIR` | | `./data` | Runtime state directory |

---

## Design notes

**Trips are silent by default.** 165 trips a month would train you to ignore every notification — including the ones that matter. Trips use `passive`; charging and alerts interrupt you.

**Battery and range come from two places.** TeslaMate does not store range on every position row; the drive's start position is often empty, so the code falls back to `drives.start_ideal_range_km`.

**Tire pressure uses an absolute threshold, not a relative one.** Comparing one tire against the other three catches punctures earlier, but seasonal drift makes all four move together and causes false alarms. The default is deliberately conservative.

**Charging interruption needs the charge limit.** That value only exists in the live data stream, not in the database. After a restart, if it hasn't arrived yet, interruption can't be detected and the message degrades to a normal "charging complete".

**The daily summary yields to driving.** At 21:00, if you're still driving, it waits until 22:00, 23:00, and so on. If you drive past midnight it retries at 00:00 and 01:00 so the day isn't lost.

---

## Development

```bash
npm test
```

Tests cover formatting, dedupe, time boundaries and state machine transitions. No database required.

## Credits

Derived from [tesla-butler](https://github.com/manwithshit/tesla-butler). The state machine and database layer are reused; the Feishu notification path was removed to focus on Bark.

## License

[MIT](LICENSE)
