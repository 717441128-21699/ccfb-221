import { exec, query, tableCount } from './duckdb';
import type { TableModel, MetricVersion, RunRecord, RuleResult, QualityRule } from '../types';
import { runAllRules, qualityGate } from './quality';

export interface PipelineTask {
  id: string;
  label: string;
  layer: 'ODS' | 'DWD' | 'DWS' | 'ADS' | 'DQ';
  /** 质量门之前的任务标记为可阻断点 */
  gate?: boolean;
  run: (ctx: PipelineContext) => Promise<void>;
}

export interface PipelineContext {
  models: TableModel[];
  rules: QualityRule[];
  metricVersions: MetricVersion[];
  runId: string;
  log: (taskId: string, patch: Partial<RunRecord['tasks'][number]>) => void;
  results: RuleResult[];
  forceContinue: boolean;
}

function modelByName(models: TableModel[], name: string): TableModel {
  const m = models.find((x) => x.name === name);
  if (!m) throw new Error(`模型 ${name} 未注册`);
  return m;
}

/** 物化单个模型；OR REPLACE 语义保证重跑幂等，ODS 建表用 IF NOT EXISTS */
async function buildModel(ctx: PipelineContext, name: string): Promise<number> {
  const m = modelByName(ctx.models, name);
  const t0 = performance.now();
  await exec(m.sql);
  return Math.round(performance.now() - t0);
}

/**
 * 指标版本物化：按版本表达式重算 ADS。
 * 先按 metric+version 删除旧分区数据再插入，幂等可重跑。
 */
async function materializeMetrics(ctx: PipelineContext): Promise<void> {
  for (const mv of ctx.metricVersions) {
    await exec(`DELETE FROM ads_metric_daily WHERE metric_id='${mv.metric}' AND version='${mv.version}';`);
    // 表达式作用于 dws_swap_daily，按日 + 站点聚合
    await exec(`
      INSERT INTO ads_metric_daily
      SELECT
        '${mv.metric}' AS metric_id,
        '${mv.version}' AS version,
        event_date,
        station_id,
        CAST(${mv.expression} AS DOUBLE) AS metric_value,
        CURRENT_TIMESTAMP AS calc_time
      FROM dws_swap_daily
      GROUP BY event_date, station_id;`);
  }
}

export function buildTasks(models: TableModel[]): PipelineTask[] {
  return [
    {
      id: 't_ods_ddl',
      label: 'ODS 建表（日志/台账）',
      layer: 'ODS',
      run: async (ctx) => {
        await buildModel(ctx, 'ods_swap_log');
        await buildModel(ctx, 'ods_battery_ledger');
      },
    },
    {
      id: 't_dwd_log',
      label: 'DWD 日志清洗去重（事件时间分区）',
      layer: 'DWD',
      run: (ctx) => buildModel(ctx, 'dwd_swap_log').then(() => undefined),
    },
    {
      id: 't_dwd_ledger',
      label: 'DWD 台账去重',
      layer: 'DWD',
      run: (ctx) => buildModel(ctx, 'dwd_battery_ledger').then(() => undefined),
    },
    {
      id: 't_scd2',
      label: 'SCD2 电池归属缓慢变化维',
      layer: 'DWD',
      run: (ctx) => buildModel(ctx, 'dim_battery_scd2').then(() => undefined),
    },
    {
      id: 't_dq',
      label: '质量校验（唯一/非空/范围/环比）+ 质量门',
      layer: 'DQ',
      gate: true,
      run: async (ctx) => {
        const results = await runAllRules(ctx.rules, ctx.runId);
        ctx.results.push(...results);
        const { blocked, failed } = qualityGate(results, ctx.rules);
        if (blocked && !ctx.forceContinue) {
          const err = new Error(`质量门拦截：${failed.map((f) => f.ruleId).join(', ')} 未通过`) as Error & { blocked?: boolean };
          err.blocked = true;
          throw err;
        }
        if (blocked && ctx.forceContinue) {
          // 强制继续：记录告警但不阻断下游
          ctx.log('t_dq', { message: `强制继续：${failed.map((f) => f.ruleId).join(', ')} 未通过（已忽略）` });
        }
      },
    },
    {
      id: 't_dws_daily',
      label: 'DWS 日换电汇总',
      layer: 'DWS',
      run: (ctx) => buildModel(ctx, 'dws_swap_daily').then(() => undefined),
    },
    {
      id: 't_dws_health',
      label: 'DWS 电池健康度',
      layer: 'DWS',
      run: (ctx) => buildModel(ctx, 'dws_battery_health_daily').then(() => undefined),
    },
    {
      id: 't_ads_metric',
      label: 'ADS 版本化指标物化',
      layer: 'ADS',
      run: async (ctx) => {
        await buildModel(ctx, 'ads_metric_daily');
        await materializeMetrics(ctx);
      },
    },
    {
      id: 't_ads_cabinet',
      label: 'ADS 柜子宽表',
      layer: 'ADS',
      run: (ctx) => buildModel(ctx, 'ads_cabinet_daily').then(() => undefined),
    },
  ];
}

export interface RunOptions {
  models: TableModel[];
  rules: QualityRule[];
  metricVersions: MetricVersion[];
  forceContinue: boolean;
  onTaskUpdate: (taskId: string, patch: Partial<RunRecord['tasks'][number]>) => void;
  onStatus: (status: RunRecord['status']) => void;
}

export async function runPipeline(opts: RunOptions): Promise<RunRecord> {
  const runId = `run_${new Date().getTime()}`;
  const tasks = buildTasks(opts.models);
  const record: RunRecord = {
    id: runId,
    startedAt: new Date().toISOString(),
    status: 'running',
    mode: 'full',
    tasks: tasks.map((t) => ({ taskId: t.id, label: t.label, status: 'running' as const })),
  };
  const ctx: PipelineContext = {
    models: opts.models,
    rules: opts.rules,
    metricVersions: opts.metricVersions,
    runId,
    results: [],
    forceContinue: opts.forceContinue,
    log: (taskId, patch) => {
      const t = record.tasks.find((x) => x.taskId === taskId);
      if (t) Object.assign(t, patch);
      opts.onTaskUpdate(taskId, patch);
    },
  };

  let blocked = false;
  for (let idx = 0; idx < tasks.length; idx++) {
    const task = tasks[idx];
    const t0 = performance.now();
    try {
      await task.run(ctx);
      ctx.log(task.id, { status: 'ok', ms: Math.round(performance.now() - t0) });
    } catch (e) {
      const ms = Math.round(performance.now() - t0);
      const isBlocked = Boolean((e as Error & { blocked?: boolean }).blocked);
      if (isBlocked) blocked = true;
      ctx.log(task.id, {
        status: isBlocked ? 'blocked' : 'failed',
        ms,
        message: (e as Error).message,
      });
      // 任何失败（质量门拦截或 SQL 报错）：后续任务一律标记 blocked，不再执行
      for (const later of tasks.slice(idx + 1)) {
        ctx.log(later.id, { status: 'blocked', message: isBlocked ? '上游质量门未通过' : '上游任务执行失败' });
      }
      record.status = isBlocked ? 'blocked' : 'failed';
      break;
    }
  }
  record.finishedAt = new Date().toISOString();
  if (record.status === 'running') record.status = 'ok';
  opts.onStatus(record.status);
  record.totalRows = await tableCount('ods_swap_log').catch(() => 0);
  return record;
}

/** 迟到数据回补演示：向 ODS 追加一批带旧事件时间、新 ingest 时间的日志 */
export async function injectLateData(n = 5000): Promise<number> {
  await exec(`
    INSERT INTO ods_swap_log
    SELECT
      'LATE_' || lpad(CAST(range AS VARCHAR), 8, '0') AS log_id,
      'CB' || lpad(CAST((hash(range::BIGINT) % 200 + 200) AS VARCHAR), 4, '0') AS cabinet_id,
      'ST001' AS station_id,
      'BT' || lpad(CAST((hash((range + 7)::BIGINT) % 5000) AS VARCHAR), 5, '0') AS battery_id,
      TIMESTAMP '2026-11-05 10:00:00' + (range % 3600) * INTERVAL 1 SECOND AS event_time,
      DATE '2026-11-05' AS event_date,
      'swap' AS swap_type, 60 AS soc_before, 90 AS soc_after,
      32.5 AS temperature, 50.1 AS voltage, 120 AS cycle_cnt,
      FALSE AS is_abnormal,
      CURRENT_TIMESTAMP AS ingest_ts,
      'late_injection' AS source_file
    FROM range(${n});`);
  const r = await query(`SELECT count(*)::BIGINT AS n FROM ods_swap_log WHERE source_file='late_injection'`);
  return Number(r.rows[0].n);
}
