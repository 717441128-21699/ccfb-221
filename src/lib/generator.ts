import { query, exec } from './duckdb';
import { DEFAULT_MODELS } from '../models/catalog';

// 固定随机种子，保证演示可复现
const SEED = 20261114;

/** 确保 ODS 表已创建（生成数据前调用，幂等） */
async function ensureOdsTables(): Promise<void> {
  for (const name of ['ods_swap_log', 'ods_battery_ledger']) {
    const model = DEFAULT_MODELS.find((m) => m.name === name);
    if (model) await exec(model.sql);
  }
}

/**
 * 大批量日志生成：完全在 DuckDB 引擎内用 range 生成，JS 侧不持有数据。
 * 事件时间跨度 10 天，约 8% 数据的 ingest_ts 落在事件日之后（模拟迟到日志）。
 * 写入前清空目标表，保证全量重跑幂等。
 */
export async function generateLargeLog(n: number, opts?: { dirtyRatio?: number }): Promise<{ rows: number; ms: number }> {
  const dirty = opts?.dirtyRatio ?? 0.01;
  await ensureOdsTables();
  const t0 = performance.now();
  await exec('DELETE FROM ods_swap_log;');
  const sql = `
  INSERT INTO ods_swap_log
  WITH rng AS (
    SELECT range AS i,
           ((hash((range + ${SEED})::BIGINT) % 100000) / 100000.0) AS r1,
           ((hash((range + ${SEED} * 7)::BIGINT) % 100000) / 100000.0) AS r2,
           ((hash((range + ${SEED} * 13)::BIGINT) % 100000) / 100000.0) AS r3,
           ((hash((range + ${SEED} * 31)::BIGINT) % 100000) / 100000.0) AS r4,
           ((hash((range + ${SEED} * 53)::BIGINT) % 100000) / 100000.0) AS r5
    FROM range(${n})
  ),
  base AS (
    SELECT
      'LG' || lpad(CAST(i AS VARCHAR), 10, '0')                                AS log_id,
      'CB' || lpad(CAST((r1 * 200)::INTEGER AS VARCHAR), 4, '0')               AS cabinet_id,
      'ST' || lpad(CAST(((r1 * 40)::INTEGER) AS VARCHAR), 3, '0')              AS station_id,
      'BT' || lpad(CAST((r2 * 5000)::INTEGER AS VARCHAR), 5, '0')              AS battery_id,
      TIMESTAMP '2026-11-04 00:00:00'
        + (r3 * 10 * 24 * 3600)::BIGINT * INTERVAL 1 SECOND                    AS event_time,
      CASE WHEN r4 < 0.85 THEN 'swap' WHEN r4 < 0.95 THEN 'rent' ELSE 'return' END AS swap_type,
      CAST(20 + r5 * 80 AS INTEGER)                                             AS soc_before,
      CAST(10 + r1 * 60 AS INTEGER)                                             AS soc_after,
      round(15 + r2 * 35 + CASE WHEN r3 > 0.995 THEN 25 ELSE 0 END, 2)         AS temperature,
      round(44 + r4 * 12, 2)                                                    AS voltage,
      CAST(r5 * 800 AS INTEGER)                                                 AS cycle_cnt,
      (r3 > 0.992)                                                              AS is_abnormal,
      -- 1% 脏数据：重复 log_id / 空主键 / 超范围温度
      CASE WHEN r2 < ${dirty} THEN 'LG' || lpad(CAST((i % 97) AS VARCHAR), 10, '0')
           ELSE 'LG' || lpad(CAST(i AS VARCHAR), 10, '0') END                  AS dirty_log_id,
      r1 AS rr1, r3 AS rr3, r5 AS rr5
    FROM rng
  )
  SELECT
    CASE WHEN rr1 < ${dirty} / 2 THEN NULL ELSE dirty_log_id END               AS log_id,
    cabinet_id, station_id, battery_id,
    event_time,
    CAST(event_time AS DATE)                                                    AS event_date,
    swap_type,
    soc_before, soc_after,
    CASE WHEN rr5 < ${dirty} THEN round(999, 2) ELSE temperature END           AS temperature,
    voltage, cycle_cnt, is_abnormal,
    -- 8% 迟到：ingest 比 event 晚 1~3 天，其余当日入库
    event_time + CASE WHEN rr3 < 0.08 THEN (1 + (rr5 * 3)::INTEGER) ELSE 0 END * INTERVAL 1 DAY
      + (rr1 * 86400)::BIGINT * INTERVAL 1 SECOND                              AS ingest_ts,
    'synthetic_${n}'                                                            AS source_file
  FROM base;`;
  await exec(sql);
  const ms = Math.round(performance.now() - t0);
  const r = await query('SELECT count(*)::BIGINT AS n FROM ods_swap_log');
  return { rows: Number(r.rows[0].n), ms };
}

/** 台账生成：每块电池 1~3 次换柜/换站记录，全部在引擎内生成 */
export async function generateLargeLedger(batteries = 5000): Promise<{ rows: number; ms: number }> {
  await ensureOdsTables();
  const t0 = performance.now();
  await exec('DELETE FROM ods_battery_ledger;').catch(() => undefined);
  await exec(`
  INSERT INTO ods_battery_ledger
  WITH rng AS (
    SELECT range AS i,
           ((hash((range + ${SEED} * 91)::BIGINT) % 100000) / 100000.0) AS r1,
           ((hash((range + ${SEED} * 71)::BIGINT) % 100000) / 100000.0) AS r2
    FROM range(${batteries})
  ),
  moves AS (
    SELECT battery_id, cabinet_id, station_id, change_time, change_type FROM (
      SELECT
        'BT' || lpad(CAST(i AS VARCHAR), 5, '0') AS battery_id,
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
  FROM moves;`);
  const ms = Math.round(performance.now() - t0);
  const r = await query('SELECT count(*)::BIGINT AS n FROM ods_battery_ledger');
  return { rows: Number(r.rows[0].n), ms };
}

// ---------- 小批量 JS 生成（供下载样例文件 / 页面预览） ----------

function pad(n: number, w: number): string {
  return String(n).padStart(w, '0');
}

/** 生成 n 条 JSONL 文本，结构与 ODS 日志一致 */
export function buildSampleJsonl(n: number): string {
  const lines: string[] = [];
  let seed = SEED;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < n; i++) {
    const r1 = rand();
    const r2 = rand();
    const r3 = rand();
    const r4 = rand();
    const event = new Date(Date.UTC(2026, 10, 4) + Math.floor(r3 * 10) * 86400000 + Math.floor(r1 * 86400) * 1000);
    const ingest = new Date(event.getTime() + (r3 < 0.1 ? (1 + Math.floor(r4 * 3)) * 86400000 : 3600000));
    lines.push(
      JSON.stringify({
        log_id: `LG${pad(i, 10)}`,
        cabinet_id: `CB${pad(Math.floor(r1 * 200), 4)}`,
        station_id: `ST${pad(Math.floor(r1 * 40), 3)}`,
        battery_id: `BT${pad(Math.floor(r2 * 5000), 5)}`,
        event_time: event.toISOString().replace('T', ' ').slice(0, 19),
        swap_type: r4 < 0.85 ? 'swap' : r4 < 0.95 ? 'rent' : 'return',
        soc_before: 20 + Math.floor(r2 * 80),
        soc_after: 10 + Math.floor(r1 * 60),
        temperature: Math.round((15 + r2 * 35) * 100) / 100,
        voltage: Math.round((44 + r4 * 12) * 100) / 100,
        cycle_cnt: Math.floor(rand() * 800),
        is_abnormal: r3 > 0.99,
        ingest_ts: ingest.toISOString().replace('T', ' ').slice(0, 19),
      }),
    );
  }
  return lines.join('\n');
}

/** 生成台账 CSV 文本 */
export function buildSampleCsv(n: number): string {
  let seed = SEED + 99;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const rows = ['battery_id,cabinet_id,station_id,change_time,change_type'];
  for (let i = 0; i < n; i++) {
    const r1 = rand();
    const r2 = rand();
    const t = new Date(Date.UTC(2026, 10, 1) + Math.floor(r2 * 30) * 86400000);
    rows.push(
      `BT${pad(i, 5)},CB${pad(Math.floor(r1 * 200), 4)},ST${pad(Math.floor(r1 * 40), 3)},${t
        .toISOString()
        .replace('T', ' ')
        .slice(0, 19)},${r2 < 0.5 ? 'cabinet_change' : 'station_change'}`,
    );
  }
  return rows.join('\n');
}

export function downloadText(filename: string, text: string, mime = 'text/plain'): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
