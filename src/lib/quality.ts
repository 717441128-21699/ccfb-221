import type { QualityRule, RuleResult } from '../types';
import { query, exec } from './duckdb';

export const DEFAULT_RULES: QualityRule[] = [
  { id: 'rq_log_id_unique', name: '日志ID唯一', table: 'dwd_swap_log', field: 'log_id', type: 'unique', enabled: true },
  { id: 'rq_battery_notnull', name: '电池ID非空', table: 'dwd_swap_log', field: 'battery_id', type: 'not_null', enabled: true },
  { id: 'rq_temp_range', name: '温度范围[-40,80]', table: 'dwd_swap_log', field: 'temperature', type: 'range', enabled: true, params: { min: -40, max: 80 } },
  { id: 'rq_soc_range', name: 'SOC范围[0,100]', table: 'dwd_swap_log', field: 'soc_after', type: 'range', enabled: true, params: { min: 0, max: 100 } },
  { id: 'rq_voltage_range', name: '电压范围[0,72]', table: 'dwd_swap_log', field: 'voltage', type: 'range', enabled: true, params: { min: 0, max: 72 } },
  { id: 'rq_swap_mom', name: '日换电量环比突变±50%', table: 'dws_swap_daily', field: 'swap_cnt', type: 'mom_spike', enabled: true, params: { spikeRatio: 0.5 } },
];

function buildCheckSql(rule: QualityRule): string {
  const t = rule.table;
  const f = rule.field;
  switch (rule.type) {
    case 'unique':
      return `SELECT count(*)::BIGINT AS failed FROM (SELECT ${f} FROM ${t} WHERE ${f} IS NOT NULL GROUP BY ${f} HAVING count(*) > 1)`;
    case 'not_null':
      return `SELECT count(*)::BIGINT AS failed FROM ${t} WHERE ${f} IS NULL`;
    case 'range':
      return `SELECT count(*)::BIGINT AS failed FROM ${t}
        WHERE ${f} IS NOT NULL AND (${f} < ${rule.params?.min ?? 'NULL'} OR ${f} > ${rule.params?.max ?? 'NULL'})`;
    case 'mom_spike': {
      // 按站点日聚合后与前一日对比，超出 spikeRatio 视为突变
      const ratio = rule.params?.spikeRatio ?? 0.5;
      return `
        WITH daily AS (
          SELECT event_date, station_id, sum(${f}) AS v
          FROM ${t} GROUP BY event_date, station_id
        ),
        lagged AS (
          SELECT event_date, station_id, v,
                 lag(v) OVER (PARTITION BY station_id ORDER BY event_date) AS prev_v
          FROM daily
        )
        SELECT count(*)::BIGINT AS failed FROM lagged
        WHERE prev_v IS NOT NULL AND prev_v > 0
          AND abs(v - prev_v) * 1.0 / prev_v > ${ratio}`;
    }
  }
}

/** 执行单条质量规则；目标表不存在等异常被捕获为失败结果，不向上抛错 */
export async function runRule(rule: QualityRule): Promise<RuleResult> {
  let checkedRows = 0;
  try {
    const total = await query(`SELECT count(*)::BIGINT AS n FROM ${rule.table}`);
    checkedRows = Number(total.rows[0].n);
    const r = await query(buildCheckSql(rule));
    const failedRows = Number(r.rows[0].failed);
    return {
      ruleId: rule.id,
      passed: failedRows === 0,
      checkedRows,
      failedRows,
      detail:
        rule.type === 'mom_spike'
          ? `检查 ${checkedRows} 行聚合序列，${failedRows} 个站点-日期环比突变超阈值`
          : `检查 ${checkedRows} 行，${failedRows} 行不满足 ${rule.type} 约束`,
    };
  } catch (e) {
    return { ruleId: rule.id, passed: false, checkedRows, failedRows: -1, detail: `规则执行失败: ${(e as Error).message}` };
  }
}

/** 执行全部启用规则，并把结果写入 dq_result 审计表 */
export async function runAllRules(rules: QualityRule[], batchId: string): Promise<RuleResult[]> {
  await exec(`CREATE TABLE IF NOT EXISTS dq_result (
    batch_id VARCHAR, rule_id VARCHAR, rule_name VARCHAR, target_table VARCHAR,
    target_field VARCHAR, rule_type VARCHAR, passed BOOLEAN,
    checked_rows BIGINT, failed_rows BIGINT, detail VARCHAR, checked_at TIMESTAMP
  );`);
  const results: RuleResult[] = [];
  for (const rule of rules.filter((r) => r.enabled)) {
    const res = await runRule(rule);
    results.push(res);
    await exec(`INSERT INTO dq_result VALUES (
      '${batchId}', '${rule.id}', '${rule.name.replace(/'/g, "''")}', '${rule.table}', '${rule.field}',
      '${rule.type}', ${res.passed}, ${res.checkedRows}, ${res.failedRows},
      '${res.detail.replace(/'/g, "''")}', CURRENT_TIMESTAMP)`);
  }
  return results;
}

/** 质量门：任一启用规则不通过即阻断下游 */
export function qualityGate(results: RuleResult[], rules: QualityRule[]): { blocked: boolean; failed: RuleResult[] } {
  const enabledIds = new Set(rules.filter((r) => r.enabled).map((r) => r.id));
  const failed = results.filter((r) => enabledIds.has(r.ruleId) && !r.passed);
  return { blocked: failed.length > 0, failed };
}
