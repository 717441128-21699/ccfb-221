import { tableFromArrays } from 'apache-arrow';
import type { DuckType, FieldSchema } from '../types';

// ---------- 文本解析 ----------

/** 解析单行 JSON，失败返回 null */
export function parseJsonLine(line: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(line);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 解析 JSONL 文本，返回记录数组与坏行数量 */
export function parseJsonl(text: string): { records: Record<string, unknown>[]; badLines: number } {
  const records: Record<string, unknown>[] = [];
  let badLines = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const rec = parseJsonLine(line);
    if (rec) records.push(rec);
    else badLines++;
  }
  return { records, badLines };
}

/** 支持引号/转义的轻量 CSV 行解析 */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

export function parseCsv(text: string): { records: Record<string, string>[]; headers: string[]; badLines: number } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (!lines.length) return { records: [], headers: [], badLines: 0 };
  const headers = parseCsvLine(lines[0]).map((h) => h.trim());
  const records: Record<string, string>[] = [];
  let badLines = 0;
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    if (cells.length !== headers.length) {
      badLines++;
      continue;
    }
    const rec: Record<string, string> = {};
    headers.forEach((h, idx) => (rec[h] = cells[idx]));
    records.push(rec);
  }
  return { records, headers, badLines };
}

// ---------- 类型推断 ----------

const ISO_TS = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const INT_RE = /^-?\d+$/;
const NUM_RE = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;
const BOOL_RE = /^(true|false)$/i;

function inferScalar(v: unknown): DuckType | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'boolean') return 'BOOLEAN';
  if (typeof v === 'number') return Number.isInteger(v) ? 'BIGINT' : 'DOUBLE';
  const s = String(v).trim();
  if (ISO_TS.test(s)) return 'TIMESTAMP';
  if (ISO_DATE.test(s)) return 'DATE';
  if (BOOL_RE.test(s)) return 'BOOLEAN';
  if (INT_RE.test(s)) return 'BIGINT';
  if (NUM_RE.test(s)) return 'DOUBLE';
  return 'VARCHAR';
}

const TYPE_RANK: Record<DuckType, number> = {
  INTEGER: 2, BIGINT: 2, DOUBLE: 3, BOOLEAN: 1, TIMESTAMP: 4, DATE: 4, VARCHAR: 9,
};

function mergeType(a: DuckType, b: DuckType): DuckType {
  if (a === b) return a;
  if ((a === 'INTEGER' || a === 'BIGINT') && (b === 'INTEGER' || b === 'BIGINT')) return 'BIGINT';
  if ((a === 'BIGINT' || a === 'INTEGER' || a === 'DOUBLE') && (b === 'BIGINT' || b === 'INTEGER' || b === 'DOUBLE')) return 'DOUBLE';
  return 'VARCHAR';
}

/** 基于前 N 条记录做字段类型自动推断 */
export function inferSchema(records: Record<string, unknown>[], sampleSize = 2000): FieldSchema[] {
  const fieldNames: string[] = [];
  const seen = new Set<string>();
  const sample = records.slice(0, sampleSize);
  for (const rec of sample) {
    for (const k of Object.keys(rec)) {
      if (!seen.has(k)) {
        seen.add(k);
        fieldNames.push(k);
      }
    }
  }
  return fieldNames.map((name) => {
    let inferred: DuckType | null = null;
    for (const rec of sample) {
      const t = inferScalar(rec[name]);
      if (!t) continue;
      inferred = inferred ? mergeType(inferred, t) : t;
    }
    return { name, type: inferred ?? 'VARCHAR', nullable: true };
  });
}

// ---------- Arrow 构建 ----------

function coerceValue(v: unknown, type: DuckType): unknown {
  if (v === null || v === undefined || v === '') return null;
  const s = typeof v === 'string' ? v.trim() : v;
  switch (type) {
    case 'INTEGER':
    case 'BIGINT': {
      const n = typeof s === 'number' ? s : Number(s);
      return Number.isFinite(n) ? n : null;
    }
    case 'DOUBLE': {
      const n = typeof s === 'number' ? s : Number(s);
      return Number.isFinite(n) ? n : null;
    }
    case 'BOOLEAN':
      if (typeof s === 'boolean') return s;
      return /^(true|1|yes|y)$/i.test(String(s));
    case 'TIMESTAMP':
    case 'DATE': {
      const d = s instanceof Date ? s : new Date(String(s));
      // tableFromArrays 遇到 Date[] 会自动推断为 TimestampMillisecond
      return Number.isNaN(d.getTime()) ? null : d;
    }
    default:
      return String(s);
  }
}

/**
 * 按给定 schema 把记录数组构建为 Arrow Table。
 * 时间类型用 Date 数组，arrow 自动推断为 TimestampMilli；DuckDB 落表时再 CAST 为 TIMESTAMP/DATE。
 */
export function recordsToArrow(records: Record<string, unknown>[], schema: FieldSchema[]): import('apache-arrow').Table {
  const arrays: Record<string, readonly unknown[]> = {};
  for (const f of schema) {
    const col = new Array(records.length);
    for (let i = 0; i < records.length; i++) {
      col[i] = coerceValue(records[i]?.[f.name], f.type);
    }
    arrays[f.name] = col;
  }
  return tableFromArrays(arrays);
}
