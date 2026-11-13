// 全局领域类型定义

export type LayerName = 'ODS' | 'DWD' | 'DWS' | 'ADS';

export type DuckType = 'INTEGER' | 'BIGINT' | 'DOUBLE' | 'VARCHAR' | 'BOOLEAN' | 'TIMESTAMP' | 'DATE';

export interface FieldSchema {
  name: string;
  type: DuckType;
  /** 用户手动指定过的类型，不再参与自动推断 */
  pinned?: boolean;
  nullable?: boolean;
  comment?: string;
}

export interface DataSource {
  id: string;
  fileName: string;
  kind: 'jsonl' | 'csv';
  /** 解析出来的目标表（ODS 层） */
  targetTable: string;
  rowCount: number;
  sizeBytes: number;
  importedAt: string;
  schema: FieldSchema[];
  /** 采样的原始记录，供页面展示 */
  sample: Record<string, unknown>[];
  status: 'imported';
}

export interface TableModel {
  name: string;
  layer: LayerName;
  comment: string;
  /** 建表/生成表的 SQL（DWS/ADS 为 INSERT 或 CTAS 模板） */
  sql: string;
  /** 分区字段（事件时间分区），没有则为空 */
  partitionBy?: string;
  /** 血缘：该表字段由哪些上游表字段计算而来 */
  lineage: Record<string, { table: string; field: string }[]>;
  builtAt?: string;
  rowCount?: number;
}

export type RuleType = 'unique' | 'not_null' | 'range' | 'mom_spike';

export interface QualityRule {
  id: string;
  name: string;
  table: string;
  field: string;
  type: RuleType;
  enabled: boolean;
  /** range: [min,max]；mom_spike: 环比最大允许变化比例，如 0.5 表示 ±50% */
  params?: { min?: number; max?: number; spikeRatio?: number };
}

export interface RuleResult {
  ruleId: string;
  passed: boolean;
  checkedRows: number;
  failedRows: number;
  detail: string;
}

export interface RunRecord {
  id: string;
  startedAt: string;
  finishedAt?: string;
  /** 按任务维度记录耗时毫秒与状态 */
  tasks: { taskId: string; label: string; status: 'running' | 'ok' | 'failed' | 'blocked' | 'skipped'; ms?: number; message?: string }[];
  status: 'running' | 'ok' | 'failed' | 'blocked';
  mode: 'full' | 'incremental';
  totalRows?: number;
}

export interface MetricVersion {
  id: string;
  metric: string;
  version: string;
  /** 指标计算 SQL 片段（聚合表达式） */
  expression: string;
  comment: string;
  createdAt: string;
  active: boolean;
}
