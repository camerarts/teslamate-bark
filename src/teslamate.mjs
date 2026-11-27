import pg from "pg";
import { config, projectPath } from "./config.mjs";
import { runFile } from "./lib/process.mjs";
import { groupDriveSegments } from "./trip-sessions.mjs";
import { createQueryRunner } from './query-runtime.mjs';

// 远程数据库适配：原实现通过 `docker compose exec database psql` 查询本地栈，
// 这里改为直连 TESLAMATE_DATABASE_URL 指向的 PostgreSQL（见 .env.remote）。
let pool;

function getPool() {
  if (!config.teslamateDatabaseUrl) {
    throw Object.assign(new Error("TESLAMATE_DATABASE_URL 未配置（见 .env.remote）"), { code: "DB_NOT_CONFIGURED" });
  }
  if (!pool) {
    pool = new pg.Pool({
      connectionString: config.teslamateDatabaseUrl,
      max: 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      application_name: "tesla-butler"
    });
    pool.on("error", error => process.stderr.write(`[${new Date().toISOString()}] db_pool_error ${JSON.stringify({ message: error.message })}\n`));
  }
  return pool;
}

// 复刻 psql -t -A 的输出形态：只保留列值、按行拼接，供 createQueryRunner 做 JSON.parse。
// pg 会把 json/jsonb 列解析成对象，必须重新序列化成文本，否则 JSON.parse 会拿到 [object Object]。
async function runSql(sql, timeout, signal) {
  if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
  const client = await getPool().connect();
  let released = false;
  let failed = false;
  const release = destroy => {
    if (released) return;
    released = true;
    client.release(destroy);
  };
  // 中止时直接断开套接字，让服务端终止语句，避免慢查询继续占用连接。
  const onAbort = () => {
    client.connection?.stream?.destroy(Object.assign(new Error("aborted"), { name: "AbortError" }));
    release(true);
  };
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  try {
    await client.query("BEGIN READ ONLY");
    // PG 18 对高 cost 查询默认启用 JIT，但本项目的查询结果集都很小（几十行），
    // 编译开销反而成为瓶颈：实测同一条汇总查询 JIT 编译 3.1s、实际执行仅 0.38s。
    await client.query("SET LOCAL jit = off");
    await client.query(`SET LOCAL statement_timeout='${Math.max(1, timeout - 2_000)}ms'`);
    const result = await client.query(sql);
    await client.query("COMMIT");
    return result.rows.map(row => {
      const value = Object.values(row)[0];
      if (value === null || value === undefined) return "";
      return typeof value === "object" ? JSON.stringify(value) : String(value);
    }).join("\n");
  } catch (error) {
    // 事务已进入 aborted 状态或连接不可信：必须销毁连接，不能归还连接池。
    // 否则坏连接被反复取出，后续所有查询都会连锁失败（DB_PROCESS_FAILED）。
    failed = true;
    if (error && typeof error === "object" && error.stderr === undefined) error.stderr = String(error.message || "");
    throw error;
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
    release(failed);
  }
}

const queryRunner = createQueryRunner({
  run: async (sql, _args, options = {}) => ({ stdout: await runSql(sql, options.timeout ?? 30_000, options.signal) }),
  log: event => process.stderr.write(`[${new Date().toISOString()}] db_query ${JSON.stringify(event)}\n`)
});

async function sqlJson(sql, timeout = 30_000, { signal, name = 'query' } = {}) {
  return queryRunner(sql, [], { timeout, signal }, name);
}

export async function getLatestChargingProcess({ signal } = {}) {
  return sqlJson(`
    SELECT COALESCE((
      SELECT json_build_object(
        'id', cp.id,
        'car_id', cp.car_id,
        'start_at', cp.start_date,
        'end_at', cp.end_date,
        'start_battery_level', cp.start_battery_level,
        'end_battery_level', cp.end_battery_level,
        'charge_energy_added', cp.charge_energy_added,
        'duration_min', cp.duration_min,
        'latest_battery_level', latest.battery_level,
        'latest_charger_power', latest.charger_power,
        'latest_charge_energy_added', latest.charge_energy_added,
        'latest_sample_at', latest.date
      )
      FROM charging_processes cp
      LEFT JOIN LATERAL (
        SELECT c.date, c.battery_level, c.charger_power, c.charge_energy_added
        FROM charges c
        WHERE c.charging_process_id = cp.id
        ORDER BY c.date DESC, c.id DESC
        LIMIT 1
      ) latest ON true
      ORDER BY cp.id DESC
      LIMIT 1
    ), 'null'::json);
  `, 8_000, { signal, name: 'charging_snapshot' });
}

export async function getRecentChargingProcesses({ before = new Date(), days = 7, limit = 20 } = {}) {
  const safeBefore = new Date(before);
  if (!Number.isFinite(safeBefore.getTime())) throw new Error("invalid charging lookup time");
  const safeDays = Math.max(1, Math.min(31, Math.trunc(Number(days) || 7)));
  const safeLimit = Math.max(1, Math.min(50, Math.trunc(Number(limit) || 20)));
  const beforeIso = safeBefore.toISOString();
  const beforeUtc = teslaMateUtcNaiveSqlExpression(beforeIso, "invalid charging lookup time");
  return sqlJson(`
    SELECT COALESCE(json_agg(row_to_json(recent) ORDER BY recent.end_at DESC), '[]'::json)
    FROM (
      SELECT
        cp.id,
        cp.start_date AS start_at,
        cp.end_date AS end_at,
        cp.start_battery_level,
        cp.end_battery_level,
        COALESCE(cp.charge_energy_added, latest.charge_energy_added) AS charge_energy_added
      FROM charging_processes cp
      LEFT JOIN LATERAL (
        SELECT c.charge_energy_added
        FROM charges c
        WHERE c.charging_process_id = cp.id
        ORDER BY c.date DESC, c.id DESC
        LIMIT 1
      ) latest ON true
      WHERE cp.end_date IS NOT NULL
        AND cp.end_date <= ${beforeUtc} + interval '10 minutes'
        AND cp.end_date >= ${beforeUtc} - interval '${safeDays} days'
      ORDER BY cp.end_date DESC
      LIMIT ${safeLimit}
    ) recent;
  `, 3_000);
}

// 充电会话的补充信息：平均功率、地点、充电类型、续航增量。
// 这些字段 MQTT 快照里没有，只在推送前按需查一次，失败不影响主流程。
export async function getChargingContext(processId) {
  const id = Math.trunc(Number(processId));
  if (!Number.isInteger(id) || id <= 0) return null;
  return sqlJson(`
    SELECT COALESCE((
      SELECT json_build_object(
        'id', cp.id,
        'location', COALESCE(NULLIF(a.road, ''), NULLIF(a.name, ''), NULLIF(a.display_name, '')),
        'address', NULLIF(a.display_name, ''),
        'avg_power_kw', (SELECT round(avg(c.charger_power)::numeric, 1) FROM charges c WHERE c.charging_process_id = cp.id),
        'max_power_kw', (SELECT max(c.charger_power) FROM charges c WHERE c.charging_process_id = cp.id),
        'fast_charge', (SELECT bool_or(c.fast_charger_present) FROM charges c WHERE c.charging_process_id = cp.id),
        'fast_charger_type', (SELECT max(c.fast_charger_type) FROM charges c WHERE c.charging_process_id = cp.id),
        'start_rated_range_km', cp.start_rated_range_km,
        'end_rated_range_km', cp.end_rated_range_km,
        'start_battery_level', cp.start_battery_level,
        'end_battery_level', cp.end_battery_level,
        'start_at', cp.start_date,
        'end_at', cp.end_date,
        'charge_energy_added', cp.charge_energy_added,
        'duration_min', cp.duration_min
      )
      FROM charging_processes cp
      LEFT JOIN addresses a ON a.id = cp.address_id
      WHERE cp.id = ${id}
    ), 'null'::json);
  `, 5_000, { name: 'charging_context' });
}

export async function ensureTeslaMate() {
  // 本地不再编排 compose 栈，这里只做远程连通性探测。
  const client = await getPool().connect();
  try {
    await client.query("SELECT 1");
  } finally {
    client.release();
  }
}

export async function getCollectionStatus() {
  return sqlJson(`
    SELECT json_build_object(
      'cars', (SELECT count(*) FROM cars),
      'drives', (SELECT count(*) FROM drives),
      'positions', (SELECT count(*) FROM positions),
      'charging_processes', (SELECT count(*) FROM charging_processes),
      'latest_drive_at', (SELECT max(end_date) FROM drives),
      'latest_position_at', (SELECT max(date) FROM positions)
    );
  `);
}

export async function getLatestTrip() {
  // TeslaMate v4 起 positions 的 drive_id 索引改为 BRIN，按行程取点位会退化为大范围扫描；
  // 且优化器会把 LATERAL 摊到全部行程上再排序。用 MATERIALIZED 先锁定单条行程，
  // 实测从 95s 降到 ~15ms。
  return sqlJson(`
    WITH latest AS MATERIALIZED (
      SELECT id FROM drives WHERE end_date IS NOT NULL ORDER BY end_date DESC LIMIT 1
    )
    SELECT COALESCE((
      SELECT json_build_object(
        'id', d.id,
        'start_at', d.start_date,
        'end_at', d.end_date,
        'distance_km', round(d.distance::numeric, 1),
        'duration_min', d.duration_min,
        'start_road', NULLIF(sa.road, ''),
        'end_road', NULLIF(ea.road, ''),
        'start_area', NULLIF(sa.city, ''),
        'end_area', NULLIF(ea.city, ''),
        'estimated_kwh', CASE
          WHEN e.valid_segments > 0 THEN round(greatest(e.net_kwh, 0)::numeric, 2)
          WHEN c.efficiency IS NOT NULL
            AND d.start_ideal_range_km IS NOT NULL
            AND d.end_ideal_range_km IS NOT NULL
          THEN round((greatest(d.start_ideal_range_km - d.end_ideal_range_km, 0) * c.efficiency / 1000)::numeric, 2)
          ELSE NULL
        END,
        'drawn_kwh', CASE WHEN e.valid_segments > 0 THEN round(e.drawn_kwh::numeric, 2) ELSE NULL END,
        'regenerated_kwh', CASE WHEN e.valid_segments > 0 THEN round(e.regenerated_kwh::numeric, 2) ELSE NULL END,
        'energy_source', CASE
          WHEN e.valid_segments > 0 THEN 'power_integration'
          WHEN c.efficiency IS NOT NULL
            AND d.start_ideal_range_km IS NOT NULL
            AND d.end_ideal_range_km IS NOT NULL
          THEN 'range_efficiency'
          ELSE 'unavailable'
        END
      )
      FROM drives d
      JOIN latest l ON l.id = d.id
      JOIN cars c ON c.id = d.car_id
      LEFT JOIN addresses sa ON sa.id = d.start_address_id
      LEFT JOIN addresses ea ON ea.id = d.end_address_id
      LEFT JOIN LATERAL (
        SELECT
          count(*) AS valid_segments,
          sum(average_power * seconds / 3600) AS net_kwh,
          sum(greatest(average_power, 0) * seconds / 3600) AS drawn_kwh,
          sum(greatest(-average_power, 0) * seconds / 3600) AS regenerated_kwh
        FROM (
          SELECT
            EXTRACT(EPOCH FROM (lead(p.date) OVER (ORDER BY p.date) - p.date)) AS seconds,
            (p.power::float8 + lead(p.power::float8) OVER (ORDER BY p.date)) / 2 AS average_power
          FROM positions p
          WHERE p.drive_id = d.id AND p.power IS NOT NULL
        ) segments
        WHERE seconds > 0 AND seconds <= 10 AND average_power IS NOT NULL
      ) e ON true
    ), 'null'::json);
  `);
}

function teslaMateUtcNaiveSqlExpression(value, errorMessage) {
  const raw = String(value ?? "").trim();
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw) ? raw : `${raw}Z`;
  const timestamp = new Date(normalized);
  if (!raw || !Number.isFinite(timestamp.getTime())) {
    throw new Error(errorMessage);
  }
  return `('${timestamp.toISOString()}'::timestamptz AT TIME ZONE 'UTC')`;
}

export function driveEnergyTimelineSincePredicate(value) {
  return `d.start_date >= ${teslaMateUtcNaiveSqlExpression(value, "invalid drive energy timeline start")}`;
}

export async function getDriveEnergyTimeline({ since = null, driveIds = null } = {}) {
  const selection = [];
  if (since !== null && since !== undefined) {
    selection.push(driveEnergyTimelineSincePredicate(since));
  }
  if (driveIds !== null && driveIds !== undefined) {
    const values = Array.isArray(driveIds) ? driveIds : [driveIds];
    selection.push(values.length > 0 ? `d.id IN (${driveIdsSql(values)})` : "false");
  }
  const selectionClause = selection.length > 0 ? `AND (${selection.join(" OR ")})` : "";
  return sqlJson(`
    WITH selected_drives AS MATERIALIZED (
      SELECT d.*, c.efficiency
      FROM drives d
      JOIN cars c ON c.id = d.car_id
      WHERE d.end_date IS NOT NULL ${selectionClause}
    ), ordered_power AS (
      -- 同 getPeriodTrips：LATERAL 保证按行程走 drive_id 索引，避免退出成全表扫描。
      SELECT x.drive_id, x.seconds, x.average_power
      FROM selected_drives d
      CROSS JOIN LATERAL (
        SELECT
          p.drive_id,
          EXTRACT(EPOCH FROM (lead(p.date) OVER (ORDER BY p.date, p.id) - p.date)) AS seconds,
          (p.power::float8 + lead(p.power::float8) OVER (ORDER BY p.date, p.id)) / 2 AS average_power
        FROM positions p
        WHERE p.drive_id = d.id AND p.power IS NOT NULL
      ) x
    ), drive_power AS (
      SELECT
        drive_id,
        count(*) FILTER (WHERE seconds > 0 AND seconds <= 10 AND average_power IS NOT NULL) AS valid_segments,
        sum(average_power * seconds / 3600) FILTER (
          WHERE seconds > 0 AND seconds <= 10 AND average_power IS NOT NULL
        ) AS net_kwh
      FROM ordered_power
      GROUP BY drive_id
    ), timeline AS (
      SELECT
        d.id AS drive_id,
        d.car_id,
        d.start_date AS start_at,
        d.end_date AS end_at,
        CASE
          WHEN p.valid_segments > 0 THEN round(greatest(p.net_kwh, 0)::numeric, 3)
          WHEN d.efficiency IS NOT NULL
            AND d.start_ideal_range_km IS NOT NULL
            AND d.end_ideal_range_km IS NOT NULL
          THEN round((greatest(d.start_ideal_range_km - d.end_ideal_range_km, 0) * d.efficiency / 1000)::numeric, 3)
          ELSE NULL
        END AS estimated_kwh,
        CASE
          WHEN p.valid_segments > 0 THEN 'power_integration'
          WHEN d.efficiency IS NOT NULL
            AND d.start_ideal_range_km IS NOT NULL
            AND d.end_ideal_range_km IS NOT NULL
          THEN 'range_efficiency'
          ELSE 'unavailable'
        END AS energy_source
      FROM selected_drives d
      LEFT JOIN drive_power p ON p.drive_id = d.id
    )
    SELECT COALESCE(json_agg(row_to_json(timeline) ORDER BY start_at, drive_id), '[]'::json)
    FROM timeline;
  `, 30_000);
}

export async function getTeslaMateCarCount() {
  return Number(await sqlJson("SELECT count(*) FROM cars;", 3_000));
}

function driveIdsSql(driveIds) {
  const ids = [...new Set((driveIds || []).map(Number))];
  if (ids.length === 0 || ids.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw new Error("invalid drive ids");
  }
  return ids.join(",");
}

export async function getDriveMonitorSnapshot({ signal } = {}) {
  return sqlJson(`
    WITH recent AS (
      SELECT d.*
      FROM drives d
      WHERE d.end_date IS NOT NULL
      ORDER BY d.id DESC
      LIMIT 50
    ), ordered AS (
      SELECT r.*, lag(r.end_date) OVER (PARTITION BY r.car_id ORDER BY r.start_date) AS previous_end
      FROM recent r
    ), completed AS (
      SELECT
        d.id, d.car_id, d.start_date AS start_at, d.end_date AS end_at,
        round(d.distance::numeric, 2) AS distance_km, d.duration_min,
        NULLIF(sa.road, '') AS start_road, NULLIF(ea.road, '') AS end_road,
        -- road 经常为空但 display_name 有完整地址，模板里用它兜底显示。
        NULLIF(sa.display_name, '') AS start_display, NULLIF(ea.display_name, '') AS end_display,
        sp.latitude::float8 AS start_lat, sp.longitude::float8 AS start_lng,
        ep.latitude::float8 AS end_lat, ep.longitude::float8 AS end_lng,
        EXISTS (
          SELECT 1 FROM charging_processes cp
          WHERE d.previous_end IS NOT NULL
            AND cp.car_id = d.car_id
            AND cp.start_date >= d.previous_end
            AND cp.start_date <= d.start_date
        ) AS charging_between
      FROM ordered d
      LEFT JOIN addresses sa ON sa.id = d.start_address_id
      LEFT JOIN addresses ea ON ea.id = d.end_address_id
      LEFT JOIN positions sp ON sp.id = d.start_position_id
      LEFT JOIN positions ep ON ep.id = d.end_position_id
    ), active AS (
      SELECT d.id, d.car_id, d.start_date AS start_at,
             p.latitude::float8 AS start_lat, p.longitude::float8 AS start_lng,
             EXISTS (
               SELECT 1 FROM charging_processes cp
               WHERE cp.car_id = d.car_id
                 AND cp.start_date >= COALESCE((
                   SELECT max(previous.end_date) FROM drives previous
                   WHERE previous.car_id = d.car_id
                     AND previous.end_date IS NOT NULL
                     AND previous.end_date <= d.start_date
                 ), d.start_date)
                 AND cp.start_date <= d.start_date
             ) AS charging_between
      FROM drives d
      LEFT JOIN positions p ON p.id = d.start_position_id
      WHERE d.end_date IS NULL
      ORDER BY d.id DESC
      LIMIT 1
    )
    SELECT json_build_object(
      'completed', COALESCE((SELECT json_agg(row_to_json(c) ORDER BY c.start_at) FROM completed c), '[]'::json),
      'active', (SELECT row_to_json(a) FROM active a)
    );
  `, 8_000, { signal, name: 'trip_snapshot' });
}

export async function getTripInsightHistory(limit = 50) {
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(Number(limit) || 50)));
  return sqlJson(`
    WITH recent AS (
      SELECT d.*
      FROM drives d
      WHERE d.end_date IS NOT NULL
      ORDER BY d.end_date DESC
      LIMIT ${safeLimit}
    ), drives_ordered AS (
      SELECT r.*, lag(r.end_date) OVER (PARTITION BY r.car_id ORDER BY r.start_date) AS previous_end
      FROM recent r
    ), position_intervals AS (
      SELECT
        p.drive_id,
        p.date AS sample_at,
        p.id AS sample_id,
        p.speed::float8 AS speed,
        lead(p.speed::float8) OVER (PARTITION BY p.drive_id ORDER BY p.date, p.id) AS next_speed,
        EXTRACT(EPOCH FROM (
          lead(p.date) OVER (PARTITION BY p.drive_id ORDER BY p.date, p.id) - p.date
        )) AS seconds,
        (p.power::float8 + lead(p.power::float8) OVER (
          PARTITION BY p.drive_id ORDER BY p.date, p.id
        )) / 2 AS average_power
      FROM positions p
      JOIN recent d ON d.id = p.drive_id
    ), interval_flags AS (
      SELECT *,
        CASE WHEN seconds > 0 AND seconds <= 3 AND speed IS NOT NULL AND next_speed IS NOT NULL
          THEN ((next_speed - speed) / 3.6) / seconds >= 2.0 ELSE false END AS accel_hit,
        CASE WHEN seconds > 0 AND seconds <= 3 AND speed IS NOT NULL AND next_speed IS NOT NULL
          THEN ((next_speed - speed) / 3.6) / seconds <= -2.5 ELSE false END AS decel_hit
      FROM position_intervals
    ), event_edges AS (
      SELECT *,
        lag(accel_hit, 1, false) OVER (PARTITION BY drive_id ORDER BY sample_at, sample_id) AS previous_accel_hit,
        lead(accel_hit, 1, false) OVER (PARTITION BY drive_id ORDER BY sample_at, sample_id) AS next_accel_hit,
        lag(decel_hit, 1, false) OVER (PARTITION BY drive_id ORDER BY sample_at, sample_id) AS previous_decel_hit,
        lead(decel_hit, 1, false) OVER (PARTITION BY drive_id ORDER BY sample_at, sample_id) AS next_decel_hit
      FROM interval_flags
    ), metrics AS (
      SELECT
        drive_id,
        COALESCE(sum(seconds) FILTER (WHERE seconds > 0 AND seconds <= 3), 0) AS observed_seconds,
        COALESCE(sum(seconds) FILTER (
          WHERE seconds > 0 AND seconds <= 3 AND speed = 0 AND next_speed = 0
        ), 0) AS stopped_seconds,
        count(*) FILTER (WHERE accel_hit AND next_accel_hit AND NOT previous_accel_hit) AS strong_accel_count,
        count(*) FILTER (WHERE decel_hit AND next_decel_hit AND NOT previous_decel_hit) AS strong_decel_count,
        sum(greatest(average_power, 0) * seconds / 3600) FILTER (
          WHERE seconds > 0 AND seconds <= 10 AND average_power IS NOT NULL
        ) AS drawn_kwh,
        sum(greatest(-average_power, 0) * seconds / 3600) FILTER (
          WHERE seconds > 0 AND seconds <= 10 AND average_power IS NOT NULL
        ) AS regenerated_kwh
      FROM event_edges
      GROUP BY drive_id
    ), result AS (
      SELECT
        d.id, d.car_id, d.start_date AS start_at, d.end_date AS end_at,
        round(d.distance::numeric, 2) AS distance_km,
        d.duration_min,
        EXTRACT(EPOCH FROM (d.end_date - d.start_date)) AS duration_seconds,
        sp.latitude::float8 AS start_lat, sp.longitude::float8 AS start_lng,
        ep.latitude::float8 AS end_lat, ep.longitude::float8 AS end_lng,
        EXISTS (
          SELECT 1 FROM charging_processes cp
          WHERE d.previous_end IS NOT NULL
            AND cp.car_id = d.car_id
            AND cp.start_date >= d.previous_end
            AND cp.start_date <= d.start_date
        ) AS charging_between,
        COALESCE(m.observed_seconds, 0) AS observed_seconds,
        COALESCE(m.stopped_seconds, 0) AS stopped_seconds,
        COALESCE(m.strong_accel_count, 0) AS strong_accel_count,
        COALESCE(m.strong_decel_count, 0) AS strong_decel_count,
        m.drawn_kwh,
        m.regenerated_kwh,
        d.ascent::float8 AS ascent_m
      FROM drives_ordered d
      LEFT JOIN positions sp ON sp.id = d.start_position_id
      LEFT JOIN positions ep ON ep.id = d.end_position_id
      LEFT JOIN metrics m ON m.drive_id = d.id
    )
    SELECT COALESCE(json_agg(row_to_json(result) ORDER BY start_at), '[]'::json)
    FROM result;
  `, 15_000);
}

export async function getDriveGroup(driveIds, options = {}) {
  const ids = driveIdsSql(driveIds);
  const segments = await sqlJson(`
    SELECT COALESCE(json_agg(row_to_json(x) ORDER BY x.start_at), '[]'::json)
    FROM (
      SELECT
        d.id, d.car_id, d.start_date AS start_at, d.end_date AS end_at,
        round(d.distance::numeric, 2) AS distance_km, d.duration_min,
        NULLIF(sa.road, '') AS start_road, NULLIF(ea.road, '') AS end_road,
        -- road 经常为空但 display_name 有完整地址，模板里用它兜底显示。
        NULLIF(sa.display_name, '') AS start_display, NULLIF(ea.display_name, '') AS end_display,
        sp.latitude::float8 AS start_lat, sp.longitude::float8 AS start_lng,
        ep.latitude::float8 AS end_lat, ep.longitude::float8 AS end_lng,
        sp.battery_level AS start_battery_level,
        ep.battery_level AS end_battery_level,
        round(d.start_ideal_range_km::numeric, 1) AS start_range_km,
        round(d.end_ideal_range_km::numeric, 1) AS end_range_km,
        CASE
          WHEN e.valid_segments > 0 THEN round(greatest(e.net_kwh, 0)::numeric, 2)
          WHEN c.efficiency IS NOT NULL
            AND d.start_ideal_range_km IS NOT NULL
            AND d.end_ideal_range_km IS NOT NULL
          THEN round((greatest(d.start_ideal_range_km - d.end_ideal_range_km, 0) * c.efficiency / 1000)::numeric, 2)
          ELSE NULL
        END AS estimated_kwh,
        CASE WHEN e.valid_segments > 0 THEN round(e.drawn_kwh::numeric, 2) ELSE NULL END AS drawn_kwh,
        CASE WHEN e.valid_segments > 0 THEN round(e.regenerated_kwh::numeric, 2) ELSE NULL END AS regenerated_kwh,
        CASE
          WHEN e.valid_segments > 0 THEN 'power_integration'
          WHEN c.efficiency IS NOT NULL
            AND d.start_ideal_range_km IS NOT NULL
            AND d.end_ideal_range_km IS NOT NULL
          THEN 'range_efficiency'
          ELSE 'unavailable'
        END AS energy_source
      FROM drives d
      JOIN cars c ON c.id = d.car_id
      LEFT JOIN addresses sa ON sa.id = d.start_address_id
      LEFT JOIN addresses ea ON ea.id = d.end_address_id
      LEFT JOIN positions sp ON sp.id = d.start_position_id
      LEFT JOIN positions ep ON ep.id = d.end_position_id
      LEFT JOIN LATERAL (
        SELECT count(*) AS valid_segments,
               sum(average_power * seconds / 3600) AS net_kwh,
               sum(greatest(average_power, 0) * seconds / 3600) AS drawn_kwh,
               sum(greatest(-average_power, 0) * seconds / 3600) AS regenerated_kwh
        FROM (
          SELECT EXTRACT(EPOCH FROM (lead(p.date) OVER (ORDER BY p.date) - p.date)) AS seconds,
                 (p.power::float8 + lead(p.power::float8) OVER (ORDER BY p.date)) / 2 AS average_power
          FROM positions p
          WHERE p.drive_id = d.id AND p.power IS NOT NULL
        ) samples
        WHERE seconds > 0 AND seconds <= 10 AND average_power IS NOT NULL
      ) e ON true
      WHERE d.id IN (${ids}) AND d.end_date IS NOT NULL
    ) x;
  `);
  const expectedIds = ids.split(",").map(Number);
  if (segments.length !== expectedIds.length) throw new Error("one or more drive segments are unavailable");
  const groups = groupDriveSegments(segments, options);
  if (groups.length !== 1) throw new Error("drive segments do not form one trip");
  return groups[0];
}

export async function getLatestTripGroup() {
  const snapshot = await getDriveMonitorSnapshot();
  const group = groupDriveSegments(snapshot.completed).at(-1);
  return group ? getDriveGroup(group.segment_ids) : null;
}

export async function getDriveGroupRoute(driveIds) {
  const ids = driveIdsSql(driveIds);
  return sqlJson(`
    WITH sampled AS (
      SELECT p.latitude::float8 AS lat, p.longitude::float8 AS lng, p.drive_id,
             p.date AS at, p.power::float8 AS power_kw,
             row_number() OVER (PARTITION BY p.drive_id ORDER BY p.date) AS point_no
      FROM positions p
      WHERE p.drive_id IN (${ids})
    )
    SELECT COALESCE(json_agg(json_build_object(
      'lat', lat, 'lng', lng, 'drive_id', drive_id, 'at', at, 'power_kw', power_kw
    ) ORDER BY at) FILTER (WHERE point_no = 1 OR point_no % 3 = 0), '[]'::json)
    FROM sampled;
  `);
}

export async function getLatestTripRoute() {
  return sqlJson(`
    WITH latest_drive AS (
      SELECT id FROM drives WHERE end_date IS NOT NULL ORDER BY end_date DESC LIMIT 1
    ), sampled AS (
      SELECT p.latitude::float8 AS lat, p.longitude::float8 AS lng, p.drive_id,
             p.date AS at, p.power::float8 AS power_kw,
             row_number() OVER (ORDER BY p.date) AS point_no
      FROM positions p
      JOIN latest_drive d ON d.id = p.drive_id
    )
    SELECT COALESCE(json_agg(json_build_object(
      'lat', lat, 'lng', lng, 'drive_id', drive_id, 'at', at, 'power_kw', power_kw
    ) ORDER BY point_no) FILTER (WHERE point_no = 1 OR point_no % 3 = 0), '[]'::json)
    FROM sampled;
  `);
}

export async function getDriveRoute(driveId) {
  const id = Number(driveId);
  if (!Number.isInteger(id) || id <= 0) throw new Error("invalid drive id");
  return sqlJson(`
    WITH sampled AS (
      SELECT p.latitude::float8 AS lat, p.longitude::float8 AS lng, p.drive_id,
             p.date AS at, p.power::float8 AS power_kw,
             row_number() OVER (ORDER BY p.date) AS point_no
      FROM positions p
      WHERE p.drive_id = ${id}
    )
    SELECT COALESCE(json_agg(json_build_object(
      'lat', lat, 'lng', lng, 'drive_id', drive_id, 'at', at, 'power_kw', power_kw
    ) ORDER BY point_no) FILTER (WHERE point_no = 1 OR point_no % 3 = 0), '[]'::json)
    FROM sampled;
  `);
}

export async function getVehicleOverview({ signal } = {}) {
  return sqlJson(`
    SELECT json_build_object(
      'model', COALESCE(NULLIF(c.marketing_name, ''), NULLIF(c.model, ''), '特斯拉'),
      'trim', NULLIF(c.trim_badging, ''),
      'state', (
        SELECT s.state::text FROM states s
        WHERE s.car_id = c.id ORDER BY s.start_date DESC LIMIT 1
      ),
      'battery_level', p.battery_level,
      'usable_battery_level', p.usable_battery_level,
      'rated_range_km', round(p.rated_battery_range_km::numeric, 0),
      'ideal_range_km', round(p.ideal_battery_range_km::numeric, 0),
      'odometer_km', round(p.odometer::numeric, 0),
      'inside_temp_c', p.inside_temp,
      'outside_temp_c', p.outside_temp,
      'is_climate_on', p.is_climate_on,
      'updated_at', p.date
    )
    FROM cars c
    LEFT JOIN LATERAL (
      SELECT * FROM positions p0
      WHERE p0.car_id = c.id ORDER BY p0.date DESC LIMIT 1
    ) p ON true
    ORDER BY c.display_priority, c.id
    LIMIT 1;
  `, 30_000, { signal, name: 'vehicle_overview' });
}

function periodBounds(period) {
  if (!new Set(["day", "previous_day", "week", "month", "previous_week", "previous_month"]).has(period)) {
    throw new Error(`unsupported period: ${period}`);
  }
  const unit = period === "day" || period === "previous_day"
    ? "day"
    : period === "week" || period === "previous_week" ? "week" : "month";
  const lowerOffset = period === "previous_month"
    ? " - interval '1 month'"
    : period === "previous_week"
      ? " - interval '1 week'"
      : period === "previous_day" ? " - interval '1 day'" : "";
  const upperClause = period === "previous_month" || period === "previous_week" || period === "previous_day"
    ? "AND d.start_date < b.until_utc"
    : "";
  return { unit, lowerOffset, upperClause };
}

export async function getPeriodTrips(period) {
  const { unit, lowerOffset, upperClause } = periodBounds(period);
  return sqlJson(`
    WITH bounds AS MATERIALIZED (
      SELECT
        ((((date_trunc('${unit}', now() AT TIME ZONE 'Asia/Shanghai'))${lowerOffset}) AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'UTC') AS since_utc,
        (((date_trunc('${unit}', now() AT TIME ZONE 'Asia/Shanghai')) AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'UTC') AS until_utc
    ), selected_drives AS MATERIALIZED (
      SELECT d.*, c.efficiency
      FROM drives d
      JOIN cars c ON c.id = d.car_id
      CROSS JOIN bounds b
      WHERE d.end_date IS NOT NULL AND d.start_date >= b.since_utc ${upperClause}
    ), ordered_power AS (
      -- 用 LATERAL 强制按行程逐条走 drive_id 索引。若写成普通 JOIN，优化器会把
      -- 实际 3.7k 行估成 361 万行，转而全表扫 positions（923 万行 / ~970MB）。
      SELECT x.drive_id, x.seconds, x.average_power
      FROM selected_drives d
      CROSS JOIN LATERAL (
        SELECT
          p.drive_id,
          EXTRACT(EPOCH FROM (lead(p.date) OVER (ORDER BY p.date) - p.date)) AS seconds,
          (p.power::float8 + lead(p.power::float8) OVER (ORDER BY p.date)) / 2 AS average_power
        FROM positions p
        WHERE p.drive_id = d.id AND p.power IS NOT NULL
      ) x
    ), drive_power AS (
      SELECT
        drive_id,
        count(*) AS valid_segments,
        sum(average_power * seconds / 3600) AS net_kwh,
        sum(greatest(average_power, 0) * seconds / 3600) AS drawn_kwh,
        sum(greatest(-average_power, 0) * seconds / 3600) AS regenerated_kwh
      FROM ordered_power
      WHERE seconds > 0 AND seconds <= 10 AND average_power IS NOT NULL
      GROUP BY drive_id
    ), drive_energy AS (
      SELECT
        d.id,
        CASE
          WHEN p.valid_segments > 0 THEN greatest(p.net_kwh, 0)
          WHEN d.efficiency IS NOT NULL
            AND d.start_ideal_range_km IS NOT NULL
            AND d.end_ideal_range_km IS NOT NULL
          THEN greatest(d.start_ideal_range_km - d.end_ideal_range_km, 0) * d.efficiency / 1000
          ELSE NULL
        END AS estimated_kwh,
        CASE WHEN p.valid_segments > 0 THEN p.drawn_kwh ELSE NULL END AS drawn_kwh,
        CASE WHEN p.valid_segments > 0 THEN p.regenerated_kwh ELSE NULL END AS regenerated_kwh,
        CASE
          WHEN p.valid_segments > 0 THEN 'power_integration'
          WHEN d.efficiency IS NOT NULL
            AND d.start_ideal_range_km IS NOT NULL
            AND d.end_ideal_range_km IS NOT NULL
          THEN 'range_efficiency'
          ELSE 'unavailable'
        END AS energy_source
      FROM selected_drives d
      LEFT JOIN drive_power p ON p.drive_id = d.id
    )
    SELECT json_build_object(
      'period_start_at', (SELECT since_utc FROM bounds),
      'period_end_at', ${period === "previous_month" || period === "previous_week"
        ? "(SELECT until_utc FROM bounds)"
        : "(now() AT TIME ZONE 'UTC')"},
      'trip_count', count(d.id),
      'drive_ids', COALESCE(
        json_agg(d.id ORDER BY d.start_date) FILTER (WHERE d.id IS NOT NULL),
        '[]'::json
      ),
      'distance_km', round(COALESCE(sum(d.distance), 0)::numeric, 1),
      'duration_min', COALESCE(sum(d.duration_min), 0),
      'average_distance_km', round(COALESCE(avg(d.distance), 0)::numeric, 1),
      'max_speed_kmh', COALESCE(max(d.speed_max), 0),
      'estimated_kwh', CASE
        WHEN count(d.id) > 0 AND bool_and(e.estimated_kwh IS NOT NULL)
        THEN round(COALESCE(sum(e.estimated_kwh), 0)::numeric, 2)
        ELSE NULL
      END,
      'drawn_kwh', CASE
        WHEN count(d.id) > 0 AND bool_and(e.drawn_kwh IS NOT NULL)
        THEN round(COALESCE(sum(e.drawn_kwh), 0)::numeric, 2)
        ELSE NULL
      END,
      'regenerated_kwh', CASE
        WHEN count(d.id) > 0 AND bool_and(e.regenerated_kwh IS NOT NULL)
        THEN round(COALESCE(sum(e.regenerated_kwh), 0)::numeric, 2)
        ELSE NULL
      END,
      'energy_source', CASE
        WHEN count(d.id) = 0 THEN 'unavailable'
        WHEN bool_and(e.energy_source = 'power_integration') THEN 'power_integration'
        WHEN bool_and(e.energy_source <> 'unavailable') THEN 'mixed'
        ELSE 'unavailable'
      END
    )
    FROM selected_drives d
    LEFT JOIN drive_energy e ON e.id = d.id;
  `);
}

// 周期内的充电汇总。月报用它作为电费基数：实际充进电池的电量，而不是行驶净耗电。
// 车辆当前状态：电量、是否在充电、是否在行驶、是否停在家围栏内。
// 全部走数据库判断，不依赖 MQTT 缓存，容器重启后依然准确。
export async function getVehiclePulse() {
  return sqlJson(`
    WITH latest AS (
      SELECT p.battery_level, p.date, p.latitude::float8 AS lat, p.longitude::float8 AS lng
      FROM positions p
      WHERE p.battery_level IS NOT NULL
      ORDER BY p.id DESC
      LIMIT 1
    )
    SELECT COALESCE((
      SELECT json_build_object(
        'battery_level', l.battery_level,
        'at', l.date,
        'charging', EXISTS (SELECT 1 FROM charging_processes cp WHERE cp.end_date IS NULL),
        'driving', EXISTS (SELECT 1 FROM drives d WHERE d.end_date IS NULL),
        'at_home', EXISTS (
          SELECT 1
          FROM geofences g
          WHERE lower(g.name) = 'home'
            AND g.latitude IS NOT NULL
            AND g.longitude IS NOT NULL
            AND 6371000 * 2 * asin(sqrt(
              power(sin(radians((l.lat - g.latitude) / 2)), 2)
              + cos(radians(g.latitude)) * cos(radians(l.lat))
              * power(sin(radians((l.lng - g.longitude) / 2)), 2)
            )) <= g.radius
        )
      )
      FROM latest l
    ), 'null'::json);
  `, 8_000, { name: 'vehicle_pulse' });
}

// 停车后的熄火状态。
//
// TeslaMate 不记录锁车状态（positions 无 locked 列，MQTT 也不发布），
// 但车辆行为本身是个可靠信号：锁车后约 15 分钟内必然进入 offline/asleep，
// 未锁车时车机保持唤醒等待无钥匙进入，会一直停留在 online。
//
// 实测本车 90 天 198 次真正停车，排除充电后 100% 在 30 分钟内休眠；
// 仅有的 27 次「超过 30 分钟仍 online」全部发生在充电过程中。
// 所以「停车 30 分钟仍 online 且不在充电」基本等价于「没锁车」。
export async function getParkingState() {
  return sqlJson(`
    WITH last_drive AS (
      SELECT id, end_date
      FROM drives
      WHERE end_date IS NOT NULL AND end_date <= now()
      ORDER BY end_date DESC
      LIMIT 1
    ), cur_state AS (
      SELECT state::text AS state, start_date
      FROM states
      ORDER BY start_date DESC
      LIMIT 1
    )
    SELECT COALESCE((
      SELECT json_build_object(
        'drive_id', d.id,
        'parked_at', d.end_date,
        'parked_minutes', round(extract(epoch from (now() - d.end_date)) / 60),
        'state', s.state,
        'state_minutes', round(extract(epoch from (now() - s.start_date)) / 60),
        'driving', EXISTS (SELECT 1 FROM drives x WHERE x.end_date IS NULL),
        'charging', EXISTS (SELECT 1 FROM charging_processes cp WHERE cp.end_date IS NULL),
        -- 刚充完电车辆还会醒一阵，用它排除误判
        'charge_ended_minutes', (
          SELECT round(extract(epoch from (now() - max(cp.end_date))) / 60)
          FROM charging_processes cp
          WHERE cp.end_date IS NOT NULL AND cp.end_date > now() - interval '3 hours'
        )
      )
      FROM last_drive d
      CROSS JOIN cur_state s
    ), 'null'::json);
  `, 8_000, { name: 'parking_state' });
}

// 最近一次有胎压数据的记录。用车龄（秒）判断新鲜度，避免时区转换出错。
export async function getLatestTpms() {
  return sqlJson(`
    WITH latest AS (
      SELECT p.tpms_pressure_fl AS fl,
             p.tpms_pressure_fr AS fr,
             p.tpms_pressure_rl AS rl,
             p.tpms_pressure_rr AS rr,
             extract(epoch FROM ((now() AT TIME ZONE 'UTC') - p.date)) AS age_seconds
      FROM positions p
      WHERE p.tpms_pressure_fl IS NOT NULL
        AND p.date > (now() AT TIME ZONE 'UTC') - interval '2 days'
      ORDER BY p.id DESC
      LIMIT 1
    )
    SELECT COALESCE((
      SELECT json_build_object(
        'fl', l.fl, 'fr', l.fr, 'rl', l.rl, 'rr', l.rr,
        'age_seconds', l.age_seconds
      )
      FROM latest l
    ), 'null'::json);
  `, 8_000, { name: 'latest_tpms' });
}

export async function getPeriodCharging(period) {
  const { unit, lowerOffset } = periodBounds(period);
  const exclusiveUpper = period === "previous_month" || period === "previous_week"
    ? "AND cp.start_date < b.until_utc" : "";
  return sqlJson(`
    WITH bounds AS MATERIALIZED (
      SELECT
        ((((date_trunc('${unit}', now() AT TIME ZONE 'Asia/Shanghai'))${lowerOffset}) AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'UTC') AS since_utc,
        (((date_trunc('${unit}', now() AT TIME ZONE 'Asia/Shanghai')) AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'UTC') AS until_utc
    )
    SELECT COALESCE((
      SELECT json_build_object(
        'sessions', count(*),
        'kwh', coalesce(round(sum(cp.charge_energy_added)::numeric, 1), 0),
        'minutes', coalesce(round(sum(cp.duration_min)::numeric, 0), 0)
      )
      FROM charging_processes cp
      CROSS JOIN bounds b
      WHERE cp.end_date IS NOT NULL
        AND cp.start_date >= b.since_utc ${exclusiveUpper}
    ), 'null'::json);
  `, 8_000, { name: 'period_charging' });
}

export async function getPeriodRouteCandidates(period) {
  const { unit, lowerOffset, upperClause } = periodBounds(period);
  return sqlJson(`
    WITH bounds AS MATERIALIZED (
      SELECT
        ((((date_trunc('${unit}', now() AT TIME ZONE 'Asia/Shanghai'))${lowerOffset}) AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'UTC') AS since_utc,
        (((date_trunc('${unit}', now() AT TIME ZONE 'Asia/Shanghai')) AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'UTC') AS until_utc
    )
    SELECT COALESCE(json_agg(json_build_object(
      'id', d.id,
      'start_at', d.start_date,
      'end_at', d.end_date,
      'distance_km', round(d.distance::numeric, 1),
      'start_lat', sp.latitude::float8,
      'start_lng', sp.longitude::float8,
      'end_lat', ep.latitude::float8,
      'end_lng', ep.longitude::float8,
      'start_road', NULLIF(sa.road, ''),
      'end_road', NULLIF(ea.road, ''),
      'start_display', NULLIF(sa.display_name, ''),
      'end_display', NULLIF(ea.display_name, '')
    ) ORDER BY d.end_date) FILTER (WHERE d.id IS NOT NULL), '[]'::json)
    FROM drives d
    CROSS JOIN bounds b
    LEFT JOIN positions sp ON sp.id = d.start_position_id
    LEFT JOIN positions ep ON ep.id = d.end_position_id
    LEFT JOIN addresses sa ON sa.id = d.start_address_id
    LEFT JOIN addresses ea ON ea.id = d.end_address_id
    WHERE d.end_date IS NOT NULL AND d.start_date >= b.since_utc ${upperClause};
  `);
}

export async function getPeriodRoute(period) {
  const { unit, lowerOffset, upperClause } = periodBounds(period);
  return sqlJson(`
    WITH bounds AS MATERIALIZED (
      SELECT
        ((((date_trunc('${unit}', now() AT TIME ZONE 'Asia/Shanghai'))${lowerOffset}) AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'UTC') AS since_utc,
        (((date_trunc('${unit}', now() AT TIME ZONE 'Asia/Shanghai')) AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'UTC') AS until_utc
    ), sampled AS (
      SELECT p.latitude::float8 AS lat, p.longitude::float8 AS lng, p.drive_id,
             row_number() OVER (PARTITION BY p.drive_id ORDER BY p.date) AS point_no
      FROM positions p
      JOIN drives d ON d.id = p.drive_id
      CROSS JOIN bounds b
      WHERE d.end_date IS NOT NULL AND d.start_date >= b.since_utc ${upperClause}
    )
    SELECT COALESCE(json_agg(json_build_object(
      'lat', lat, 'lng', lng, 'drive_id', drive_id
    ) ORDER BY drive_id, point_no) FILTER (WHERE point_no = 1 OR point_no % 5 = 0), '[]'::json)
    FROM sampled;
  `);
}

// TeslaMate v4 起把 positions 的索引策略改成了 BRIN（按物理范围索引，体积很小）。
// 本项目几乎全部查询都是「按 drive_id 取一段点位」或「按 car_id 取最新一条」，
// BRIN 对这两种访问没有选择性，会退化成全表扫描：实测 923 万行耗时 20~95 秒。
// 下面在启动期补齐 B-tree 索引。CONCURRENTLY 不阻塞 TeslaMate 写入，
// 已存在且有效则直接跳过；失败只记录不退出，推送功能不受影响。
const REQUIRED_INDEXES = [
  {
    name: "positions_drive_id_btree_index",
    sql: "CREATE INDEX CONCURRENTLY IF NOT EXISTS positions_drive_id_btree_index ON public.positions USING btree (drive_id)"
  },
  {
    name: "positions_car_id_date_desc_index",
    sql: "CREATE INDEX CONCURRENTLY IF NOT EXISTS positions_car_id_date_desc_index ON public.positions USING btree (car_id, date DESC)"
  }
];

export async function ensureIndexes({ log = () => {} } = {}) {
  const client = await getPool().connect();
  const created = [];
  const failed = [];
  try {
    // 建索引可能耗时数分钟，显式解除超时限制。
    await client.query("SET statement_timeout = 0");
    const { rows } = await client.query(`
      SELECT ic.relname AS name, i.indisvalid AS valid
      FROM pg_index i
      JOIN pg_class ic ON ic.oid = i.indexrelid
      JOIN pg_class it ON it.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = it.relnamespace
      WHERE it.relname = 'positions' AND n.nspname = 'public'
    `);
    const state = new Map(rows.map(row => [row.name, row.valid]));
    for (const index of REQUIRED_INDEXES) {
      if (state.get(index.name) === true) continue;
      // 上一次 CONCURRENTLY 中断会留下 INVALID 索引，必须先删除再重建。
      if (state.has(index.name)) {
        await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${index.name}`);
      }
      try {
        await client.query(index.sql);
        created.push(index.name);
        log(`已补齐索引 ${index.name}`);
      } catch (error) {
        failed.push({ name: index.name, message: error.message });
        log(`索引 ${index.name} 创建失败：${error.message}（不影响推送，可手动执行 ${index.sql}）`);
      }
    }
  } finally {
    client.release();
  }
  return { created, failed };
}
