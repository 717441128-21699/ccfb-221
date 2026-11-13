// Node 侧冒烟测试：用 duckdb-wasm 的 Node 目标验证全部 SQL 逻辑与 500 万行性能。
// 浏览器与 Node 共用同一个 wasm 引擎，SQL 行为一致；仅启动方式不同。
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const duckdb = require(path.join(root, 'node_modules/@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs'));
const fs = require('node:fs');

const DIST = path.join(root, 'node_modules/@duckdb/duckdb-wasm/dist');
const bundles = {
  mvp: {
    mainModule: path.join(DIST, 'duckdb-mvp.wasm'),
    mainWorker: path.join(DIST, 'duckdb-node-mvp.worker.cjs'),
  },
  eh: {
    mainModule: path.join(DIST, 'duckdb-eh.wasm'),
    mainWorker: path.join(DIST, 'duckdb-node-eh.worker.cjs'),
  },
};

const N = Number(process.env.PERF_N ?? 5_000_000);
const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.ERROR);

function timing(label, fn) {
  const t0 = performance.now();
  const r = fn();
  const ms = Math.round(performance.now() - t0);
  console.log(`  ${label.padEnd(38)} ${String(ms).padStart(7)} ms`);
  return ms;
}

const total0 = performance.now();
const db = await duckdb.createDuckDB(bundles, logger, duckdb.NODE_RUNTIME);
// 阻塞式 Node 绑定需要显式 instantiate（内部 readFileSync 加载 wasm），再 open
await db.instantiate(bundles.mvp.mainModule);
// Node 的 mvp/eh wasm 为单线程构建，不能设置 maximumThreads；浏览器 COI 版才支持多线程
db.open({});
const conn = db.connect();
const exec = (sql) => conn.query(sql);

function countOf(table) {
  const t = conn.query(`SELECT count(*)::BIGINT AS n FROM ${table}`);
  return Number(t.toArray()[0].n);
}

console.log(`\n=== 冒烟测试 (N=${N.toLocaleString()}) ===`);

// 1) ODS 建表
const { DEFAULT_MODELS: catalog } = await import('../src/models/catalog.ts');
for (const m of catalog.filter((x) => x.layer === 'ODS')) timing(`DDL ${m.name}`, () => exec(m.sql));

// 2) 引擎内生成 500 万行日志（与浏览器 generator 同款 SQL，去掉参数插值直接内联）
const SEED = 20261114;
const dirty = 0.01;
const genLogSql = `
INSERT INTO ods_swap_log
WITH rng AS (
  SELECT range AS i,
    ((hash((range + ${SEED})::BIGINT) % 100000) / 100000.0) AS r1,
    ((hash((range + ${SEED} * 7)::BIGINT) % 100000) / 100000.0) AS r2,
    ((hash((range + ${SEED} * 13)::BIGINT) % 100000) / 100000.0) AS r3,
    ((hash((range + ${SEED} * 31)::BIGINT) % 100000) / 100000.0) AS r4,
    ((hash((range + ${SEED} * 53)::BIGINT) % 100000) / 100000.0) AS r5
  FROM range(${N})
), base AS (
  SELECT
    'LG' || lpad(CAST(i AS VARCHAR), 10, '0') AS log_id,
    'CB' || lpad(CAST((r1 * 200)::INTEGER AS VARCHAR), 4, '0') AS cabinet_id,
    'ST' || lpad(CAST(((r1 * 40)::INTEGER) AS VARCHAR), 3, '0') AS station_id,
    'BT' || lpad(CAST((r2 * 5000)::INTEGER AS VARCHAR), 5, '0') AS battery_id,
    TIMESTAMP '2026-11-04 00:00:00' + (r3 * 10 * 24 * 3600)::BIGINT * INTERVAL 1 SECOND AS event_time,
    CASE WHEN r4 < 0.85 THEN 'swap' WHEN r4 < 0.95 THEN 'rent' ELSE 'return' END AS swap_type,
    CAST(20 + r5 * 80 AS INTEGER) AS soc_before,
    CAST(10 + r1 * 60 AS INTEGER) AS soc_after,
    round(15 + r2 * 35 + CASE WHEN r3 > 0.995 THEN 25 ELSE 0 END, 2) AS temperature,
    round(44 + r4 * 12, 2) AS voltage,
    CAST(r5 * 800 AS INTEGER) AS cycle_cnt,
    (r3 > 0.992) AS is_abnormal,
    CASE WHEN r2 < ${dirty} THEN 'LG' || lpad(CAST((i % 97) AS VARCHAR), 10, '0')
         ELSE 'LG' || lpad(CAST(i AS VARCHAR), 10, '0') END AS dirty_log_id,
    r1 AS rr1, r3 AS rr3, r5 AS rr5
  FROM rng
)
SELECT
  CASE WHEN rr1 < ${dirty} / 2 THEN NULL ELSE dirty_log_id END AS log_id,
  cabinet_id, station_id, battery_id, event_time,
  CAST(event_time AS DATE) AS event_date, swap_type, soc_before, soc_after,
  CASE WHEN rr5 < ${dirty} THEN round(999, 2) ELSE temperature END AS temperature,
  voltage, cycle_cnt, is_abnormal,
  event_time + CASE WHEN rr3 < 0.08 THEN (1 + (rr5 * 3)::INTEGER) ELSE 0 END * INTERVAL 1 DAY
    + (rr1 * 86400)::BIGINT * INTERVAL 1 SECOND AS ingest_ts,
  'synthetic_${N}' AS source_file
FROM base;`;
timing(`生成并插入 ${N.toLocaleString()} 行日志`, () => exec(genLogSql));
console.log(`    ods_swap_log 实际行数: ${countOf('ods_swap_log').toLocaleString()}`);

// 台账
const genLedgerSql = `
INSERT INTO ods_battery_ledger
WITH rng AS (
  SELECT range AS i,
    ((hash((range + ${SEED} * 91)::BIGINT) % 100000) / 100000.0) AS r1,
    ((hash((range + ${SEED} * 71)::BIGINT) % 100000) / 100000.0) AS r2
  FROM range(5000)
), moves AS (
  SELECT battery_id, cabinet_id, station_id, change_time, change_type FROM (
    SELECT 'BT' || lpad(CAST(i AS VARCHAR), 5, '0') AS battery_id,
      'CB' || lpad(CAST((r1 * 200)::INTEGER AS VARCHAR), 4, '0') AS cabinet_id,
      'ST' || lpad(CAST((r1 * 40)::INTEGER AS VARCHAR), 3, '0') AS station_id,
      TIMESTAMP '2026-11-01 00:00:00' + (r2 * 30 * 86400)::BIGINT * INTERVAL 1 SECOND AS change_time,
      CASE WHEN r2 < 0.5 THEN 'cabinet_change' ELSE 'station_change' END AS change_type,
      row_number() OVER (PARTITION BY i ORDER BY change_time) AS rn
    FROM rng, UNNEST(generate_series(1, 1 + (r1 * 3)::INTEGER))
  ) WHERE rn <= 3
)
SELECT battery_id, cabinet_id, station_id, change_time,
  CAST(change_time AS DATE) AS change_date, change_type,
  CURRENT_TIMESTAMP AS ingest_ts, 'synthetic_ledger' AS source_file
FROM moves;`;
timing('生成台账（5000 电池 × 多次变动）', () => exec(genLedgerSql));

// 3) 逐层执行 DWD/DWS/ADS
const order = ['dwd_swap_log', 'dwd_battery_ledger', 'dim_battery_scd2', 'dws_swap_daily', 'dws_battery_health_daily', 'ads_cabinet_daily'];
for (const name of order) {
  const m = catalog.find((x) => x.name === name);
  timing(`构建 ${name}`, () => exec(m.sql));
}

// 4) 指标版本物化
timing('ads_metric_daily 建表', () => exec(catalog.find((x) => x.name === 'ads_metric_daily').sql));
const metrics = [
  ['daily_swap_cnt', 'v1', 'sum(swap_cnt)'],
  ['daily_swap_cnt', 'v2', 'sum(real_swap_cnt)'],
  ['abnormal_rate', 'v1', 'round(sum(abnormal_cnt) * 100.0 / nullif(sum(swap_cnt), 0), 2)'],
];
for (const [metric, version, expr] of metrics) {
  timing(`物化指标 ${metric}@${version}`, () =>
    exec(`INSERT INTO ads_metric_daily
      SELECT '${metric}', '${version}', event_date, station_id,
             CAST(${expr} AS DOUBLE), CURRENT_TIMESTAMP
      FROM dws_swap_daily GROUP BY event_date, station_id`),
  );
}

// 5) 质量规则（期望：脏数据导致部分失败）
const checks = {
  'log_id 唯一': `SELECT count(*)::BIGINT AS n FROM (SELECT log_id FROM dwd_swap_log WHERE log_id IS NOT NULL GROUP BY log_id HAVING count(*)>1)`,
  '温度范围[-40,80]': `SELECT count(*)::BIGINT AS n FROM dwd_swap_log WHERE temperature IS NOT NULL AND (temperature < -40 OR temperature > 80)`,
  '电池ID非空': `SELECT count(*)::BIGINT AS n FROM dwd_swap_log WHERE battery_id IS NULL`,
};
console.log('\n=== 质量规则（脏数据应被检出）===');
for (const [name, sql] of Object.entries(checks)) {
  const v = Number(conn.query(sql).toArray()[0].n);
  console.log(`  ${name.padEnd(20)} 失败行数: ${v.toLocaleString()} ${v > 0 ? '⛔ 拦截' : '✅'}`);
}

// 6) SCD2 任意时间点查询正确性
console.log('\n=== SCD2 校验 ===');
const oneBattery = String(conn.query('SELECT min(battery_id) AS b FROM dim_battery_scd2').toArray()[0].b);
const scdRows = countOf('dim_battery_scd2');
const point = conn.query(`SELECT cabinet_id, station_id, valid_from, valid_to FROM dim_battery_scd2
  WHERE battery_id='${oneBattery}' AND TIMESTAMP '2026-11-10 12:00:00' >= valid_from
    AND TIMESTAMP '2026-11-10 12:00:00' < valid_to`);
console.log(`  电池 ${oneBattery} SCD2 切片总数: ${scdRows}`);
console.log(`  2026-11-10 12:00 归属: ${JSON.stringify(point.toArray()[0] ? point.toArray()[0].toArray().map(String) : null)}`);
const overlap = Number(conn.query(`SELECT count(*)::BIGINT AS n FROM dim_battery_scd2 a JOIN dim_battery_scd2 b
  ON a.battery_id=b.battery_id AND a.valid_from < b.valid_to AND b.valid_from < a.valid_to
  AND a.valid_from <> b.valid_from`).toArray()[0].n);
console.log(`  时间区间重叠数（应为 0）: ${overlap}`);

// 7) 指标版本对比行数
const cmp = conn.query(`SELECT version, count(*)::BIGINT AS n FROM ads_metric_daily GROUP BY version ORDER BY version`);
console.log('\n=== 指标版本 ===');
for (const r of cmp.toArray()) console.log(`  版本 ${r.version}: ${Number(r.n).toLocaleString()} 行`);

// 7b) 环比突变规则（dws 已聚合，检查能否正常执行）
const mom = conn.query(`
  WITH daily AS (SELECT event_date, station_id, sum(swap_cnt) AS v FROM dws_swap_daily GROUP BY event_date, station_id),
  lagged AS (SELECT event_date, station_id, v, lag(v) OVER (PARTITION BY station_id ORDER BY event_date) AS prev_v FROM daily)
  SELECT count(*)::BIGINT AS n FROM lagged WHERE prev_v IS NOT NULL AND prev_v > 0 AND abs(v-prev_v)*1.0/prev_v > 0.5`);
console.log(`  环比突变站点-日期数: ${Number(mom.toArray()[0].n)}`);

// 8) 幂等性：重跑全部 OR REPLACE 模型，行数必须不变
const before = countOf('dwd_swap_log');
for (const name of order) exec(catalog.find((x) => x.name === name).sql);
const after = countOf('dwd_swap_log');
console.log(`\n=== 幂等重跑 ===\n  dwd_swap_log 重跑前 ${before.toLocaleString()} / 重跑后 ${after.toLocaleString()} ${before === after ? '✅ 一致' : '⛔ 不一致'}`);

const totalMs = Math.round(performance.now() - total0);
console.log(`\n=== 总耗时: ${(totalMs / 1000).toFixed(2)}s ===`);
db.disconnect();
process.exit(0);
