import * as duckdb from '@duckdb/duckdb-wasm';
import type * as arrow from 'apache-arrow';
// Vite 会把 ?url 资源打包并给出最终可访问 URL
import ehWasm from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import ehWorkerUrl from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';
import coiWasm from '@duckdb/duckdb-wasm/dist/duckdb-coi.wasm?url';
import coiWorkerUrl from '@duckdb/duckdb-wasm/dist/duckdb-browser-coi.worker.js?url';
import coiPthreadWorkerUrl from '@duckdb/duckdb-wasm/dist/duckdb-browser-coi.pthread.worker.js?url';

export interface QueryColumn {
  name: string;
  type: string;
}

export interface QueryResult {
  columns: QueryColumn[];
  rows: Record<string, unknown>[];
  rowCount: number;
  ms: number;
}

let dbInstance: duckdb.AsyncDuckDB | null = null;
let connInstance: duckdb.AsyncDuckDBConnection | null = null;
let initPromise: Promise<{ db: duckdb.AsyncDuckDB; mode: string }> | null = null;
let queryChain: Promise<unknown> = Promise.resolve();

function crossOriginIsolated(): boolean {
  return typeof globalThis !== 'undefined' && (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
}

/** 初始化 DuckDB；优先多线程 COI，失败自动降级单线程 EH */
export async function initDuckDB(): Promise<{ db: duckdb.AsyncDuckDB; mode: string }> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
    let db: duckdb.AsyncDuckDB;
    let mode: string;
    if (crossOriginIsolated()) {
      try {
        const worker = new Worker(coiWorkerUrl);
        db = new duckdb.AsyncDuckDB(logger, worker);
        await db.instantiate(coiWasm, coiPthreadWorkerUrl);
        mode = 'COI 多线程';
      } catch (e) {
        console.warn('COI 初始化失败，降级 EH 单线程:', e);
        const worker = new Worker(ehWorkerUrl);
        db = new duckdb.AsyncDuckDB(logger, worker);
        await db.instantiate(ehWasm);
        mode = 'EH 单线程(降级)';
      }
    } else {
      const worker = new Worker(ehWorkerUrl);
      db = new duckdb.AsyncDuckDB(logger, worker);
      await db.instantiate(ehWasm);
      mode = 'EH 单线程';
    }
    await db.open({ maximumThreads: navigator.hardwareConcurrency ? Math.min(4, navigator.hardwareConcurrency) : 4 });
    connInstance = await db.connect();
    // 内存与执行参数（COI 下线程才真正并行）；3GB 上限给窗口去重留足空间
    await connInstance!
      .query(`SET memory_limit='3GB'; SET threads=4; SET preserve_insertion_order=false;`)
      .catch(() => undefined);
    dbInstance = db;
    return { db, mode };
  })();
  return initPromise;
}

export function getDB(): duckdb.AsyncDuckDB {
  if (!dbInstance) throw new Error('DuckDB 尚未初始化');
  return dbInstance;
}

async function conn(): Promise<duckdb.AsyncDuckDBConnection> {
  await initDuckDB();
  return connInstance!;
}

function arrowToRows(table: arrow.Table): QueryResult {
  const columns: QueryColumn[] = table.schema.fields.map((f) => ({ name: f.name, type: String(f.type) }));
  const rows: Record<string, unknown>[] = [];
  const names = table.schema.names.map((n) => String(n));
  for (const row of table.toArray()) {
    const obj: Record<string, unknown> = {};
    const rec = row as unknown as Record<string, unknown>;
    for (const name of names) {
      const v = rec[name];
      obj[name] = v instanceof Date ? v.toISOString() : v === null ? null : v;
    }
    rows.push(obj);
  }
  return { columns, rows, rowCount: table.numRows, ms: 0 };
}

/** 串行化执行 SQL，避免同一连接上的并发写冲突 */
export async function query(sql: string): Promise<QueryResult> {
  const run = queryChain.then(async () => {
    const c = await conn();
    const t0 = performance.now();
    const table = await c.query(sql);
    const ms = Math.round(performance.now() - t0);
    return { ...arrowToRows(table), ms };
  });
  queryChain = run.catch(() => undefined);
  return run;
}

/** 执行不需要结果集的 SQL，返回耗时毫秒 */
export async function exec(sql: string): Promise<number> {
  const r = await query(sql);
  return r.ms;
}

/** 把 Arrow 表注册为临时视图（大批量导入的零拷贝路径） */
export async function registerArrow(name: string, table: arrow.Table): Promise<void> {
  const run = queryChain.then(async () => {
    const c = await conn();
    await c.insertArrowTable(table, { name, create: true });
  });
  queryChain = run.catch(() => undefined);
  await run;
}

export async function dropView(name: string): Promise<void> {
  await exec(`DROP VIEW IF EXISTS ${name};`).catch(() => undefined);
}

export async function tableExists(name: string): Promise<boolean> {
  const r = await query(`SELECT count(*)::INTEGER AS n FROM information_schema.tables WHERE table_name='${name}'`);
  return Number(r.rows[0].n) > 0;
}

export async function tableCount(name: string): Promise<number> {
  if (!(await tableExists(name))) return 0;
  const r = await query(`SELECT count(*)::BIGINT AS n FROM ${name}`);
  return Number(r.rows[0].n);
}

/** 列出当前库中的用户表与字段 */
export async function listTables(): Promise<{ name: string; columns: QueryColumn[]; rowCount: number }[]> {
  const tables = await query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema='main' ORDER BY table_name`);
  const out: { name: string; columns: QueryColumn[]; rowCount: number }[] = [];
  for (const t of tables.rows) {
    const name = String(t.table_name);
    const cols = await query(`
      SELECT column_name AS name, data_type AS type
      FROM information_schema.columns WHERE table_name='${name}' ORDER BY ordinal_position`);
    let rowCount = 0;
    try {
      rowCount = Number((await query(`SELECT count(*)::BIGINT AS n FROM "${name}"`)).rows[0].n);
    } catch {
      rowCount = 0;
    }
    out.push({
      name,
      columns: cols.rows.map((r) => ({ name: String(r.name), type: String(r.type) })),
      rowCount,
    });
  }
  return out;
}
