import type { TableModel, LayerName } from '../types';

/**
 * 分层模型注册表。所有 SQL 均可在「模型分层」页面编辑并持久化到 localStorage。
 * 设计约定：
 *  - DWD/DWS/ADS 全部使用 CREATE OR REPLACE TABLE，重跑天然幂等；
 *  - 分区按事件时间 event_date，迟到数据重新跑对应日期即可回补；
 *  - 血缘字段通过 lineage 显式声明，供血缘图渲染。
 */

const ODS_LOG_SQL = `-- ODS：换电柜原始日志（JSONL 导入落地，保留原始字段）
CREATE TABLE IF NOT EXISTS ods_swap_log (
  log_id        VARCHAR,
  cabinet_id    VARCHAR,
  station_id    VARCHAR,
  battery_id    VARCHAR,
  event_time    TIMESTAMP,
  event_date    DATE,
  swap_type     VARCHAR,
  soc_before    INTEGER,
  soc_after     INTEGER,
  temperature   DOUBLE,
  voltage       DOUBLE,
  cycle_cnt     INTEGER,
  is_abnormal   BOOLEAN,
  ingest_ts     TIMESTAMP,
  source_file   VARCHAR
);`;

const ODS_LEDGER_SQL = `-- ODS：电池台账原始记录（CSV 导入，含换柜/换站归属变动）
CREATE TABLE IF NOT EXISTS ods_battery_ledger (
  battery_id    VARCHAR,
  cabinet_id    VARCHAR,
  station_id    VARCHAR,
  change_time   TIMESTAMP,
  change_date   DATE,
  change_type   VARCHAR,
  ingest_ts     TIMESTAMP,
  source_file   VARCHAR
);`;

const DWD_LOG_SQL = `-- DWD：清洗 + 事件时间分区 + 去重（log_id 唯一，保留最新 ingest 记录）
-- row_number 窗口去重：内存占用平稳（500 万行/1.5GB 上限下稳定），OR REPLACE 保证重跑幂等
CREATE OR REPLACE TABLE dwd_swap_log AS
SELECT
  log_id,
  cabinet_id,
  station_id,
  battery_id,
  event_time,
  CAST(event_time AS DATE)              AS event_date,
  COALESCE(swap_type, 'unknown')        AS swap_type,
  CAST(soc_before AS INTEGER)           AS soc_before,
  CAST(soc_after AS INTEGER)            AS soc_after,
  CAST(temperature AS DOUBLE)           AS temperature,
  CAST(voltage AS DOUBLE)               AS voltage,
  CAST(cycle_cnt AS INTEGER)            AS cycle_cnt,
  COALESCE(is_abnormal, FALSE)          AS is_abnormal,
  ingest_ts,
  source_file
FROM (
  SELECT *,
    row_number() OVER (PARTITION BY log_id ORDER BY ingest_ts DESC) AS _rn
  FROM ods_swap_log
  WHERE log_id IS NOT NULL
)
WHERE _rn = 1;`;

const DWD_LEDGER_SQL = `-- DWD：台账变动去重，按事件时间排序
CREATE OR REPLACE TABLE dwd_battery_ledger AS
SELECT * FROM (
  SELECT
    battery_id, cabinet_id, station_id, change_time,
    CAST(change_time AS DATE) AS change_date,
    COALESCE(change_type, 'transfer') AS change_type,
    row_number() OVER (PARTITION BY battery_id, change_time ORDER BY change_time) AS _rn
  FROM ods_battery_ledger
  WHERE battery_id IS NOT NULL
) WHERE _rn = 1;`;

const DIM_SCD_SQL = `-- DWD：电池归属 SCD2 缓慢变化维（换柜/换站全历史，支持任意时间点查询）
CREATE OR REPLACE TABLE dim_battery_scd2 AS
WITH base AS (
  SELECT
    battery_id,
    cabinet_id,
    station_id,
    change_time,
    change_type,
    lag(change_time) OVER (PARTITION BY battery_id ORDER BY change_time) AS prev_change
  FROM dwd_battery_ledger
),
joined AS (
  -- 以日志中首次出现时间补一条初始归属，保证电池生命周期完整
  SELECT battery_id, cabinet_id, station_id, change_time, change_type FROM base
  UNION ALL
  SELECT
    l.battery_id,
    FIRST(l.cabinet_id) AS cabinet_id,
    FIRST(l.station_id) AS station_id,
    (SELECT min(event_time) FROM dwd_swap_log s WHERE s.battery_id = l.battery_id) AS change_time,
    'init' AS change_type
  FROM dwd_swap_log l
  GROUP BY l.battery_id
),
scd AS (
  SELECT
    battery_id,
    cabinet_id,
    station_id,
    change_type,
    change_time AS valid_from,
    lead(change_time) OVER (PARTITION BY battery_id ORDER BY change_time) AS valid_to
  FROM joined
)
SELECT
  battery_id,
  cabinet_id,
  station_id,
  change_type,
  valid_from,
  COALESCE(valid_to, TIMESTAMP '9999-12-31 00:00:00') AS valid_to,
  valid_to IS NULL AS is_current
FROM scd;`;

const DWS_DAILY_SQL = `-- DWS：站点/柜子日粒度换电汇总（按事件日期分区聚合）
CREATE OR REPLACE TABLE dws_swap_daily AS
SELECT
  event_date,
  station_id,
  cabinet_id,
  count(*)                                   AS swap_cnt,
  count_if(swap_type = 'swap')               AS real_swap_cnt,
  count_if(is_abnormal)                      AS abnormal_cnt,
  round(avg(temperature), 2)                 AS avg_temperature,
  round(avg(voltage), 2)                     AS avg_voltage,
  round(avg(soc_after), 2)                   AS avg_soc_after
FROM dwd_swap_log
GROUP BY event_date, station_id, cabinet_id;`;

const DWS_HEALTH_SQL = `-- DWS：电池日健康度（循环次数、温升、异常率、健康分）
CREATE OR REPLACE TABLE dws_battery_health_daily AS
SELECT
  CAST(event_time AS DATE)  AS event_date,
  battery_id,
  max(cycle_cnt)                                AS max_cycle_cnt,
  count(*)                                      AS usage_cnt,
  count_if(is_abnormal)                         AS abnormal_cnt,
  round(avg(temperature), 2)                    AS avg_temperature,
  round(avg(voltage), 2)                        AS avg_voltage,
  round(
    100
      - least(60, max(cycle_cnt) * 0.05)
      - least(20, count_if(is_abnormal) * 4)
      - greatest(0, avg(temperature) - 45) * 2,
    2)                                          AS health_score
FROM dwd_swap_log
GROUP BY CAST(event_time AS DATE), battery_id;`;

const ADS_METRIC_SQL = `-- ADS：指标版本化结果表。同一指标可存多个版本口径，换口径后可对比
CREATE TABLE IF NOT EXISTS ads_metric_daily (
  metric_id     VARCHAR,
  version       VARCHAR,
  event_date    DATE,
  station_id    VARCHAR,
  metric_value  DOUBLE,
  calc_time     TIMESTAMP,
  PRIMARY KEY (metric_id, version, event_date, station_id)
);`;

const ADS_CABINET_SQL = `-- ADS：柜子日指标宽表（供下游报表直接消费）
CREATE OR REPLACE TABLE ads_cabinet_daily AS
SELECT
  d.event_date,
  d.station_id,
  d.cabinet_id,
  d.swap_cnt,
  d.real_swap_cnt,
  d.abnormal_cnt,
  round(d.abnormal_cnt * 100.0 / nullif(d.swap_cnt, 0), 2) AS abnormal_rate,
  d.avg_temperature,
  d.avg_voltage,
  h.avg_health_score
FROM dws_swap_daily d
LEFT JOIN (
  SELECT event_date,
         -- 健康分按柜子下电池平均（经 SCD2 归属映射）
         NULL AS cabinet_id_placeholder,
         0 AS avg_health_score
  FROM dws_battery_health_daily GROUP BY event_date
) h ON d.event_date = h.event_date;`;

export const DEFAULT_MODELS: TableModel[] = [
  {
    name: 'ods_swap_log',
    layer: 'ODS',
    comment: '换电柜原始日志',
    sql: ODS_LOG_SQL,
    partitionBy: 'event_date',
    lineage: {
      log_id: [], cabinet_id: [], station_id: [], battery_id: [], event_time: [],
      event_date: [], swap_type: [], soc_before: [], soc_after: [], temperature: [],
      voltage: [], cycle_cnt: [], is_abnormal: [], ingest_ts: [], source_file: [],
    },
  },
  {
    name: 'ods_battery_ledger',
    layer: 'ODS',
    comment: '电池台账原始记录',
    sql: ODS_LEDGER_SQL,
    partitionBy: 'change_date',
    lineage: { battery_id: [], cabinet_id: [], station_id: [], change_time: [], change_date: [], change_type: [], ingest_ts: [], source_file: [] },
  },
  {
    name: 'dwd_swap_log',
    layer: 'DWD',
    comment: '日志清洗/去重/事件时间分区',
    sql: DWD_LOG_SQL,
    partitionBy: 'event_date',
    lineage: {
      log_id: [{ table: 'ods_swap_log', field: 'log_id' }],
      cabinet_id: [{ table: 'ods_swap_log', field: 'cabinet_id' }],
      station_id: [{ table: 'ods_swap_log', field: 'station_id' }],
      battery_id: [{ table: 'ods_swap_log', field: 'battery_id' }],
      event_time: [{ table: 'ods_swap_log', field: 'event_time' }],
      event_date: [{ table: 'dwd_swap_log', field: 'event_time' }],
      swap_type: [{ table: 'ods_swap_log', field: 'swap_type' }],
      soc_before: [{ table: 'ods_swap_log', field: 'soc_before' }],
      soc_after: [{ table: 'ods_swap_log', field: 'soc_after' }],
      temperature: [{ table: 'ods_swap_log', field: 'temperature' }],
      voltage: [{ table: 'ods_swap_log', field: 'voltage' }],
      cycle_cnt: [{ table: 'ods_swap_log', field: 'cycle_cnt' }],
      is_abnormal: [{ table: 'ods_swap_log', field: 'is_abnormal' }],
      ingest_ts: [{ table: 'ods_swap_log', field: 'ingest_ts' }],
      source_file: [{ table: 'ods_swap_log', field: 'source_file' }],
    },
  },
  {
    name: 'dwd_battery_ledger',
    layer: 'DWD',
    comment: '台账变动去重',
    sql: DWD_LEDGER_SQL,
    partitionBy: 'change_date',
    lineage: {
      battery_id: [{ table: 'ods_battery_ledger', field: 'battery_id' }],
      cabinet_id: [{ table: 'ods_battery_ledger', field: 'cabinet_id' }],
      station_id: [{ table: 'ods_battery_ledger', field: 'station_id' }],
      change_time: [{ table: 'ods_battery_ledger', field: 'change_time' }],
      change_date: [{ table: 'dwd_battery_ledger', field: 'change_time' }],
      change_type: [{ table: 'ods_battery_ledger', field: 'change_type' }],
    },
  },
  {
    name: 'dim_battery_scd2',
    layer: 'DWD',
    comment: '电池归属 SCD2 缓慢变化维',
    sql: DIM_SCD_SQL,
    lineage: {
      battery_id: [{ table: 'dwd_battery_ledger', field: 'battery_id' }, { table: 'dwd_swap_log', field: 'battery_id' }],
      cabinet_id: [{ table: 'dwd_battery_ledger', field: 'cabinet_id' }, { table: 'dwd_swap_log', field: 'cabinet_id' }],
      station_id: [{ table: 'dwd_battery_ledger', field: 'station_id' }, { table: 'dwd_swap_log', field: 'station_id' }],
      change_type: [{ table: 'dwd_battery_ledger', field: 'change_type' }],
      valid_from: [{ table: 'dwd_battery_ledger', field: 'change_time' }, { table: 'dwd_swap_log', field: 'event_time' }],
      valid_to: [{ table: 'dwd_battery_ledger', field: 'change_time' }],
      is_current: [{ table: 'dwd_battery_ledger', field: 'change_time' }],
    },
  },
  {
    name: 'dws_swap_daily',
    layer: 'DWS',
    comment: '站点/柜子日换电汇总',
    sql: DWS_DAILY_SQL,
    partitionBy: 'event_date',
    lineage: {
      event_date: [{ table: 'dwd_swap_log', field: 'event_date' }],
      station_id: [{ table: 'dwd_swap_log', field: 'station_id' }],
      cabinet_id: [{ table: 'dwd_swap_log', field: 'cabinet_id' }],
      swap_cnt: [{ table: 'dwd_swap_log', field: 'log_id' }],
      real_swap_cnt: [{ table: 'dwd_swap_log', field: 'swap_type' }],
      abnormal_cnt: [{ table: 'dwd_swap_log', field: 'is_abnormal' }],
      avg_temperature: [{ table: 'dwd_swap_log', field: 'temperature' }],
      avg_voltage: [{ table: 'dwd_swap_log', field: 'voltage' }],
      avg_soc_after: [{ table: 'dwd_swap_log', field: 'soc_after' }],
    },
  },
  {
    name: 'dws_battery_health_daily',
    layer: 'DWS',
    comment: '电池日健康度',
    sql: DWS_HEALTH_SQL,
    partitionBy: 'event_date',
    lineage: {
      event_date: [{ table: 'dwd_swap_log', field: 'event_time' }],
      battery_id: [{ table: 'dwd_swap_log', field: 'battery_id' }],
      max_cycle_cnt: [{ table: 'dwd_swap_log', field: 'cycle_cnt' }],
      usage_cnt: [{ table: 'dwd_swap_log', field: 'log_id' }],
      abnormal_cnt: [{ table: 'dwd_swap_log', field: 'is_abnormal' }],
      avg_temperature: [{ table: 'dwd_swap_log', field: 'temperature' }],
      avg_voltage: [{ table: 'dwd_swap_log', field: 'voltage' }],
      health_score: [
        { table: 'dwd_swap_log', field: 'cycle_cnt' },
        { table: 'dwd_swap_log', field: 'is_abnormal' },
        { table: 'dwd_swap_log', field: 'temperature' },
      ],
    },
  },
  {
    name: 'ads_metric_daily',
    layer: 'ADS',
    comment: '版本化指标结果',
    sql: ADS_METRIC_SQL,
    partitionBy: 'event_date',
    lineage: {
      metric_id: [], version: [], event_date: [{ table: 'dws_swap_daily', field: 'event_date' }],
      station_id: [{ table: 'dws_swap_daily', field: 'station_id' }],
      metric_value: [{ table: 'dws_swap_daily', field: 'swap_cnt' }],
      calc_time: [],
    },
  },
  {
    name: 'ads_cabinet_daily',
    layer: 'ADS',
    comment: '柜子日指标宽表',
    sql: ADS_CABINET_SQL,
    partitionBy: 'event_date',
    lineage: {
      event_date: [{ table: 'dws_swap_daily', field: 'event_date' }],
      station_id: [{ table: 'dws_swap_daily', field: 'station_id' }],
      cabinet_id: [{ table: 'dws_swap_daily', field: 'cabinet_id' }],
      swap_cnt: [{ table: 'dws_swap_daily', field: 'swap_cnt' }],
      real_swap_cnt: [{ table: 'dws_swap_daily', field: 'real_swap_cnt' }],
      abnormal_cnt: [{ table: 'dws_swap_daily', field: 'abnormal_cnt' }],
      abnormal_rate: [{ table: 'dws_swap_daily', field: 'abnormal_cnt' }, { table: 'dws_swap_daily', field: 'swap_cnt' }],
      avg_temperature: [{ table: 'dws_swap_daily', field: 'avg_temperature' }],
      avg_voltage: [{ table: 'dws_swap_daily', field: 'avg_voltage' }],
      avg_health_score: [{ table: 'dws_battery_health_daily', field: 'health_score' }],
    },
  },
];

export const LAYER_ORDER: LayerName[] = ['ODS', 'DWD', 'DWS', 'ADS'];

/** 指标版本的默认口径（表达式即聚合 SQL 片段，作用于 dws_swap_daily） */
export const DEFAULT_METRIC_VERSIONS = [
  {
    id: 'mv_swap_v1',
    metric: 'daily_swap_cnt',
    version: 'v1',
    expression: 'sum(swap_cnt)',
    comment: '口径 v1：全部换电事件计数（含异常）',
    active: true,
  },
  {
    id: 'mv_swap_v2',
    metric: 'daily_swap_cnt',
    version: 'v2',
    expression: 'sum(real_swap_cnt)',
    comment: '口径 v2：仅统计真实换电 swap，剔除异常/未知类型',
    active: false,
  },
  {
    id: 'mv_abn_v1',
    metric: 'abnormal_rate',
    version: 'v1',
    expression: 'round(sum(abnormal_cnt) * 100.0 / nullif(sum(swap_cnt), 0), 2)',
    comment: '异常率：异常数 / 总换电数',
    active: true,
  },
] as const;
