import { create } from 'zustand';
import type { DataSource, FieldSchema, TableModel, QualityRule, MetricVersion, RunRecord, LayerName } from './types';
import { DEFAULT_MODELS, DEFAULT_METRIC_VERSIONS } from './models/catalog';
import { DEFAULT_RULES } from './lib/quality';
import { parseJsonl, parseCsv, inferSchema, recordsToArrow } from './lib/parsing';
import { registerArrow, dropView, exec, query } from './lib/duckdb';

const LS_KEY = 'swap-lake-state-v1';

interface Persisted {
  models: TableModel[];
  rules: QualityRule[];
  metricVersions: MetricVersion[];
}

function loadPersisted(): Persisted {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Persisted;
      if (p.models?.length && p.rules?.length && p.metricVersions?.length) return p;
    }
  } catch {
    /* ignore */
  }
  return {
    models: DEFAULT_MODELS,
    rules: DEFAULT_RULES,
    metricVersions: DEFAULT_METRIC_VERSIONS.map((v) => ({ ...v, createdAt: new Date().toISOString() })),
  };
}

interface StoreState {
  ready: boolean;
  dbMode: string;
  activeTab: string;
  sources: DataSource[];
  models: TableModel[];
  rules: QualityRule[];
  metricVersions: MetricVersion[];
  runs: RunRecord[];
  running: boolean;
  notice: string;

  setReady: (mode: string) => void;
  setTab: (tab: string) => void;
  setNotice: (n: string) => void;
  persist: () => void;

  updateFieldType: (sourceId: string, fieldName: string, type: FieldSchema['type']) => void;
  saveImport: (ds: DataSource) => Promise<void>;
  ingestText: (fileName: string, kind: 'jsonl' | 'csv', text: string, sizeBytes: number) => Promise<DataSource>;

  updateModelSql: (name: string, sql: string) => void;
  resetModels: () => void;
  updateRule: (id: string, patch: Partial<QualityRule>) => void;
  addRule: (rule: QualityRule) => void;
  removeRule: (id: string) => void;
  saveMetricVersion: (mv: MetricVersion) => void;
  activateMetric: (id: string) => void;
  addRun: (run: RunRecord) => void;
  setRunning: (v: boolean) => void;
}

function targetTableFor(kind: 'jsonl' | 'csv'): string {
  return kind === 'jsonl' ? 'ods_swap_log' : 'ods_battery_ledger';
}

/** 把记录按 schema 落地到 ODS：临时视图 → INSERT SELECT，类型由 Arrow 决定 */
async function loadIntoOds(table: string, schema: FieldSchema[], records: Record<string, unknown>[], sourceFile: string) {
  const arrow = recordsToArrow(records, schema);
  const view = `tmp_ingest_${Math.floor(performance.now())}`;
  await registerArrow(view, arrow);
  const cols = schema.map((f) => f.name);
  const selectList = cols
    .map((c) => {
      const lower = c.toLowerCase();
      if (lower === 'event_date' || lower === 'change_date') return `CAST(${c} AS DATE)`;
      if (lower === 'ingest_ts') return `COALESCE(CAST(${c} AS TIMESTAMP), CURRENT_TIMESTAMP)`;
      return c;
    })
    .join(', ');
  const extra = table === 'ods_swap_log' ? ', ingest_ts, source_file' : ', ingest_ts, source_file';
  const hasIngest = cols.some((c) => c.toLowerCase() === 'ingest_ts');
  const ingestExpr = hasIngest ? 'ingest_ts' : 'CURRENT_TIMESTAMP';
  await exec(`
    INSERT INTO ${table} (${cols.join(', ')}${extra})
    SELECT ${selectList}, ${ingestExpr}, '${sourceFile.replace(/'/g, "''")}' FROM ${view}`);
  await dropView(view);
}

export const useStore = create<StoreState>((set, get) => {
  const initial = loadPersisted();
  return {
    ready: false,
    dbMode: '',
    activeTab: 'sources',
    sources: [],
    models: initial.models,
    rules: initial.rules,
    metricVersions: initial.metricVersions,
    runs: [],
    running: false,
    notice: '',

    setReady: (mode) => set({ ready: true, dbMode: mode }),
    setTab: (tab) => set({ activeTab: tab }),
    setNotice: (notice) => set({ notice }),
    persist: () => {
      const { models, rules, metricVersions } = get();
      localStorage.setItem(LS_KEY, JSON.stringify({ models, rules, metricVersions }));
    },

    updateFieldType: (sourceId, fieldName, type) =>
      set((s) => ({
        sources: s.sources.map((ds) =>
          ds.id === sourceId
            ? { ...ds, schema: ds.schema.map((f) => (f.name === fieldName ? { ...f, type, pinned: true } : f)) }
            : ds,
        ),
      })),

    saveImport: async (ds) => {
      // 重新按（可能被手动修改过的）schema 落地
      const records = ds.sample.length ? ds.sample : [];
      if (records.length) {
        await loadIntoOds(ds.targetTable, ds.schema, records, ds.fileName);
      }
      set((s) => ({ sources: [ds, ...s.sources].slice(0, 50) }));
    },

    ingestText: async (fileName, kind, text, sizeBytes) => {
      const parsed = kind === 'jsonl' ? parseJsonl(text) : parseCsv(text);
      const records = parsed.records as Record<string, unknown>[];
      if (!records.length) throw new Error('文件中没有可解析的记录');
      const targetTable = targetTableFor(kind);
      // 确保 ODS 表存在
      const model = get().models.find((m) => m.name === targetTable);
      if (model) await exec(model.sql);
      const schema = inferSchema(records);
      await loadIntoOds(targetTable, schema, records, fileName);
      const cnt = await query(`SELECT count(*)::BIGINT AS n FROM ${targetTable}`);
      const ds: DataSource = {
        id: `ds_${Date.now()}`,
        fileName,
        kind,
        targetTable,
        rowCount: records.length,
        sizeBytes,
        importedAt: new Date().toISOString(),
        schema,
        sample: records.slice(0, 50),
        status: 'imported',
      };
      set((s) => ({ sources: [ds, ...s.sources].slice(0, 50) }));
      void cnt;
      return ds;
    },

    updateModelSql: (name, sql) => {
      set((s) => ({ models: s.models.map((m) => (m.name === name ? { ...m, sql } : m)) }));
      get().persist();
    },
    resetModels: () => {
      set({ models: DEFAULT_MODELS, rules: DEFAULT_RULES });
      get().persist();
    },

    updateRule: (id, patch) => {
      set((s) => ({ rules: s.rules.map((r) => (r.id === id ? { ...r, ...patch } : r)) }));
      get().persist();
    },
    addRule: (rule) => {
      set((s) => ({ rules: [...s.rules, rule] }));
      get().persist();
    },
    removeRule: (id) => {
      set((s) => ({ rules: s.rules.filter((r) => r.id !== id) }));
      get().persist();
    },

    saveMetricVersion: (mv) => {
      set((s) => {
        const exists = s.metricVersions.some((x) => x.id === mv.id);
        return {
          metricVersions: exists
            ? s.metricVersions.map((x) => (x.id === mv.id ? mv : x))
            : [...s.metricVersions, mv],
        };
      });
      get().persist();
    },
    activateMetric: (id) => {
      set((s) => ({
        metricVersions: s.metricVersions.map((m) =>
          m.id === id ? { ...m, active: true } : m.metric === s.metricVersions.find((x) => x.id === id)?.metric ? { ...m, active: false } : m,
        ),
      }));
      get().persist();
    },

    addRun: (run) => set((s) => ({ runs: [run, ...s.runs].slice(0, 20) })),
    setRunning: (running) => set({ running }),
  };
});

export const LAYER_COLORS: Record<LayerName, string> = {
  ODS: '#2563eb',
  DWD: '#0891b2',
  DWS: '#7c3aed',
  ADS: '#d97706',
};
