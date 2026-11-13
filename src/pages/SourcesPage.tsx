import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { DataTable } from '../components/DataTable';
import { buildSampleJsonl, buildSampleCsv, downloadText, generateLargeLog, generateLargeLedger } from '../lib/generator';
import { query, tableCount } from '../lib/duckdb';
import type { DuckType } from '../types';

const TYPES: DuckType[] = ['INTEGER', 'BIGINT', 'DOUBLE', 'VARCHAR', 'BOOLEAN', 'TIMESTAMP', 'DATE'];

export function SourcesPage() {
  const { sources, ingestText, updateFieldType, setNotice, notice } = useStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState('');
  const [previewTable, setPreviewTable] = useState('ods_swap_log');
  const [benchN, setBenchN] = useState(5_000_000);
  const [genInfo, setGenInfo] = useState('');
  const [selectedSource, setSelectedSource] = useState<string | null>(null);

  async function handleFiles(files: FileList | File[]) {
    for (const file of Array.from(files)) {
      const kind = file.name.endsWith('.jsonl') || file.name.endsWith('.json') ? 'jsonl' : file.name.endsWith('.csv') ? 'csv' : null;
      if (!kind) {
        setNotice(`跳过 ${file.name}：仅支持 .jsonl / .csv`);
        continue;
      }
      setBusy(`解析导入 ${file.name}…`);
      try {
        const text = await file.text();
        const ds = await ingestText(file.name, kind, text, file.size);
        setNotice(`✅ ${file.name} 导入 ${ds.rowCount.toLocaleString()} 行 → ${ds.targetTable}`);
        setSelectedSource(ds.id);
      } catch (e) {
        setNotice(`❌ ${file.name}: ${(e as Error).message}`);
      } finally {
        setBusy('');
      }
    }
  }

  async function runBenchmark() {
    setBusy(`正在引擎内生成 ${benchN.toLocaleString()} 行日志…`);
    setGenInfo('');
    try {
      const t0 = performance.now();
      const log = await generateLargeLog(benchN);
      const ledger = await generateLargeLedger(5000);
      const total = Math.round(performance.now() - t0);
      setGenInfo(
        `日志 ${log.rows.toLocaleString()} 行（生成 ${log.ms}ms），台账 ${ledger.rows.toLocaleString()} 行（${ledger.ms}ms），总耗时 ${total}ms`,
      );
      setNotice('✅ 测试数据已写入 ODS，可到「管道编排」跑全量');
    } catch (e) {
      setNotice(`❌ 生成失败: ${(e as Error).message}`);
    } finally {
      setBusy('');
    }
  }

  const active = sources.find((s) => s.id === selectedSource) ?? sources[0];

  return (
    <div className="grid">
      <div className="grid cols2">
        <div className="card">
          <h3>① 导入柜子日志 JSONL / 电池台账 CSV</h3>
          <div
            className={`dropzone ${drag ? 'drag' : ''}`}
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              if (e.dataTransfer.files.length) void handleFiles(e.dataTransfer.files);
            }}
          >
            <div style={{ fontSize: 28 }}>📄</div>
            <div>点击选择或拖拽文件到此处</div>
            <div className="muted" style={{ marginTop: 6 }}>
              .jsonl → ods_swap_log ｜ .csv → ods_battery_ledger
            </div>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".jsonl,.json,.csv"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => e.target.files && void handleFiles(e.target.files)}
          />
          <h4>下载样例文件（含字段类型混合，可测试自动推断）</h4>
          <div className="row">
            <button className="small" onClick={() => downloadText('sample_swap_log.jsonl', buildSampleJsonl(2000), 'application/x-ndjson')}>
              生成 2 千行 JSONL
            </button>
            <button className="small" onClick={() => downloadText('sample_battery_ledger.csv', buildSampleCsv(1000), 'text/csv')}>
              生成 1 千行 CSV
            </button>
          </div>
        </div>

        <div className="card">
          <h3>② 性能压测数据（DuckDB 引擎内生成，JS 不持有数据）</h3>
          <p className="muted">
            500 万行日志 + 5 千块电池台账，含约 8% 迟到数据与 1% 脏数据（重复 ID / 空值 / 超范围温度），用于质量规则与性能验证。
          </p>
          <div className="row">
            <label className="muted">日志行数</label>
            <select value={benchN} onChange={(e) => setBenchN(Number(e.target.value))}>
              {[100_000, 1_000_000, 5_000_000].map((n) => (
                <option key={n} value={n}>
                  {n.toLocaleString()}
                </option>
              ))}
            </select>
            <button className="primary" disabled={!!busy} onClick={runBenchmark}>
              生成并写入 ODS
            </button>
          </div>
          {genInfo && <pre className="code" style={{ marginTop: 10 }}>{genInfo}</pre>}
          <TableCounts refreshSignal={`${genInfo}|${sources.length}|${notice}`} />
        </div>
      </div>

      {active && (
        <div className="card">
          <h3>
            ③ 字段类型推断与手动修正 — {active.fileName}
            <span className="pill" style={{ marginLeft: 8 }}>{active.targetTable}</span>
          </h3>
          <div className="muted" style={{ marginBottom: 8 }}>
            基于前 2000 条采样自动推断；手动修改后该字段将锁定（pinned），重新导入不再覆盖。
          </div>
          <table>
            <thead>
              <tr>
                <th>字段</th>
                <th>推断类型</th>
                <th>采样值</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {active.schema.map((f) => (
                <tr key={f.name}>
                  <td><code>{f.name}</code></td>
                  <td>
                    <select
                      value={f.type}
                      onChange={(e) => updateFieldType(active.id, f.name, e.target.value as DuckType)}
                    >
                      {TYPES.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="muted">
                    {String(active.sample.find((r) => r[f.name] !== undefined)?.[f.name] ?? 'NULL').slice(0, 40)}
                  </td>
                  <td>{f.pinned ? <span className="badge ok">已锁定</span> : <span className="muted">自动</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <h3>④ ODS 表数据预览</h3>
        <div className="row" style={{ marginBottom: 10 }}>
          {['ods_swap_log', 'ods_battery_ledger'].map((t) => (
            <button key={t} className={`small ${previewTable === t ? 'primary' : ''}`} onClick={() => setPreviewTable(t)}>
              {t}
            </button>
          ))}
        </div>
        <DataTable sql={`SELECT * FROM ${previewTable}`} />
      </div>
      {busy && <div className="notice">{busy}</div>}
    </div>
  );
}

function TableCounts({ refreshSignal }: { refreshSignal: string }) {
  const [info, setInfo] = useState<Record<string, number>>({});
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const out: Record<string, number> = {};
      for (const t of ['ods_swap_log', 'ods_battery_ledger']) out[t] = await tableCount(t);
      const late = await query(`SELECT count(*)::BIGINT AS n FROM ods_swap_log WHERE source_file='late_injection'`).catch(() => null);
      if (late && !cancelled) out['迟到批次'] = Number(late.rows[0].n);
      if (!cancelled) setInfo(out);
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshSignal]);
  return (
    <div className="grid cols3" style={{ marginTop: 12 }}>
      {Object.entries(info).map(([k, v]) => (
        <div key={k} className="card" style={{ padding: 10 }}>
          <div className="kpi">{v.toLocaleString()}</div>
          <div className="kpi-label">{k}</div>
        </div>
      ))}
    </div>
  );
}
