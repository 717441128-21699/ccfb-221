import { useState } from 'react';
import { useStore } from '../store';
import { runPipeline, injectLateData, buildTasks } from '../lib/pipeline';
import type { RunRecord } from '../types';
import { DataTable } from '../components/DataTable';
import { query } from '../lib/duckdb';

export function PipelinePage() {
  const { models, rules, metricVersions, addRun, setRunning, running, setNotice } = useStore();
  const [force, setForce] = useState(false);
  const [run, setRun] = useState<RunRecord | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [lateInfo, setLateInfo] = useState('');
  const [showLate, setShowLate] = useState(false);

  const taskDefs = buildTasks(models);

  async function runAll() {
    setRunning(true);
    setRun(null);
    const t0 = performance.now();
    const live: RunRecord = {
      id: `run_${t0}`,
      startedAt: new Date().toISOString(),
      status: 'running',
      mode: 'full',
      tasks: taskDefs.map((t) => ({ taskId: t.id, label: t.label, status: 'running' as const })),
    };
    setRun({ ...live });
    try {
      const record = await runPipeline({
        models,
        rules,
        metricVersions,
        forceContinue: force,
        onTaskUpdate: (taskId, patch) => {
          live.tasks = live.tasks.map((t) => (t.taskId === taskId ? { ...t, ...patch } : t));
          setRun({ ...live, tasks: [...live.tasks] });
        },
        onStatus: () => undefined,
      });
      const ms = Math.round(performance.now() - t0);
      setElapsed(ms);
      setRun(record);
      addRun(record);
      setNotice(
        record.status === 'ok'
          ? `✅ 全量管道完成，总耗时 ${(ms / 1000).toFixed(2)}s`
          : record.status === 'blocked'
            ? `⛔ 质量门拦截，耗时 ${(ms / 1000).toFixed(2)}s（可勾选强制继续）`
            : `❌ 管道失败，耗时 ${(ms / 1000).toFixed(2)}s`,
      );
    } finally {
      setRunning(false);
    }
  }

  async function injectLate() {
    try {
      const n = await injectLateData(5000);
      setLateInfo(`已注入 ${n.toLocaleString()} 条 event_date=2026-11-05 的迟到日志（ingest_ts=当前时间）`);
      setShowLate(true);
      setNotice('迟到数据已进入 ODS，重新运行管道即按事件时间回补到 11-05 分区，且重跑幂等');
    } catch (e) {
      setNotice(`❌ ${(e as Error).message}`);
    }
  }

  const statusOf = (id: string) => run?.tasks.find((t) => t.taskId === id);

  return (
    <div className="grid">
      <div className="card">
        <h3>管道编排（ODS → DWD → 质量门 → DWS → ADS）</h3>
        <div className="row">
          <button className="primary" disabled={running} onClick={runAll}>
            {running ? '运行中…' : '▶ 运行全量管道（幂等可重跑）'}
          </button>
          <label className="row" style={{ gap: 6 }}>
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
            <span className="muted">质量门失败时强制继续（仅用于演示对比）</span>
          </label>
          <button data-testid="inject-late" disabled={running} onClick={injectLate}>
            🕐 注入 5 千条迟到数据
          </button>
          {elapsed > 0 && (
            <span className="pill">
              上次全量耗时 <strong style={{ color: 'var(--accent)' }}>{(elapsed / 1000).toFixed(2)}s</strong>
            </span>
          )}
        </div>
        {lateInfo && <div className="muted" style={{ marginTop: 8 }}>{lateInfo}</div>}
      </div>

      <div className="grid cols2">
        <div className="card">
          <h3>任务 DAG 与执行状态</h3>
          {taskDefs.map((t, idx) => {
            const st = statusOf(t.id);
            const status = st?.status ?? 'skipped';
            return (
              <div key={t.id} className="task-line">
                <span className="badge {t.gate ? 'DQ' : t.layer}">{t.gate ? 'DQ门' : t.layer}</span>
                <span>
                  {idx + 1}. {t.label}
                </span>
                <span className="ms">
                  {st?.ms !== undefined && `${st.ms} ms`}
                  <span className={`badge ${status}`} style={{ marginLeft: 10 }}>
                    {label(status)}
                  </span>
                </span>
              </div>
            );
          })}
          {run?.status === 'blocked' && (
            <pre className="code" style={{ color: 'var(--red)', marginTop: 10 }}>
              下游 DWS/ADS 任务已被质量门阻断，未执行。修复数据或勾选「强制继续」后重跑。
            </pre>
          )}
          {run?.tasks.some((t) => t.message) && (
            <div style={{ marginTop: 8 }}>
              {run.tasks.filter((t) => t.message).map((t) => (
                <div key={t.taskId} className="muted" style={{ color: t.status === 'blocked' ? 'var(--red)' : 'var(--amber)' }}>
                  ⚠ {t.label}: {t.message}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card">
          <h3>分层表行数与分区</h3>
          <LayerStats runId={run?.id} />
        </div>
      </div>

      {showLate && (
        <div className="card">
          <h3>迟到回补验证：2026-11-05 分区数据（重跑前后对比）</h3>
          <DataTable
            sql={`SELECT event_date, count(*) AS rows_in_partition,
                  count_if(source_file='late_injection') AS late_rows,
                  max(ingest_ts) AS last_ingest
                FROM ods_swap_log WHERE event_date = DATE '2026-11-05' GROUP BY event_date`}
          />
          <div className="muted" style={{ marginTop: 8 }}>
            迟到日志 event_time 在 11-05、ingest_ts 在今天；管道按 event_date 分区聚合，重跑后该分区自动回补，OR REPLACE 语义保证不会重复累计。
          </div>
        </div>
      )}

      <div className="card">
        <h3>SCD2 任意时间点归属查询</h3>
        <ScdExplorer />
      </div>
    </div>
  );
}

function label(s: string): string {
  return { running: '运行中', ok: '成功', failed: '失败', blocked: '阻断', skipped: '待运行' }[s] ?? s;
}

function LayerStats({ runId }: { runId?: string }) {
  const tables = [
    'ods_swap_log',
    'ods_battery_ledger',
    'dwd_swap_log',
    'dwd_battery_ledger',
    'dim_battery_scd2',
    'dws_swap_daily',
    'dws_battery_health_daily',
    'ads_metric_daily',
    'ads_cabinet_daily',
  ];
  // 只统计实际已创建的表，未建表（被质量门阻断时）显示为未创建
  const sql = `WITH wanted(name) AS (VALUES ${tables.map((t) => `('${t}')`).join(',')}),
    stat AS (
      SELECT t.table_name AS name,
             (SELECT count(*) FROM information_schema.columns c WHERE c.table_name = t.table_name) AS col_cnt
      FROM information_schema.tables t
      WHERE t.table_schema = 'main' AND t.table_name IN (${tables.map((t) => `'${t}'`).join(',')})
    )
    SELECT w.name AS 表名,
      CASE WHEN s.name IS NULL THEN '未创建(被阻断)' ELSE '已建表 · ' || s.col_cnt || ' 列' END AS 状态,
      CASE WHEN w.name LIKE '%ledger%' THEN 'change_date'
           WHEN w.name LIKE '%scd%' THEN 'valid_from ~ valid_to'
           ELSE 'event_date' END AS 分区键
    FROM wanted w LEFT JOIN stat s ON w.name = s.name
    ORDER BY w.name`;
  return <DataTable key={runId ?? 'idle'} sql={sql} />;
}

function ScdExplorer() {
  const [battery, setBattery] = useState('BT00001');
  const [ts, setTs] = useState('2026-11-10 12:00:00');
  const [submitted, setSubmitted] = useState<{ b: string; t: string } | null>(null);

  return (
    <div>
      <div className="row">
        <label className="muted">电池 ID</label>
        <input value={battery} onChange={(e) => setBattery(e.target.value)} style={{ width: 140 }} />
        <label className="muted">查询时间点</label>
        <input value={ts} onChange={(e) => setTs(e.target.value)} style={{ width: 200 }} />
        <button className="small primary" data-testid="scd-query" onClick={() => setSubmitted({ b: battery, t: ts })}>
          查询归属
        </button>
        <button
          className="small"
          data-testid="scd-pick"
          onClick={async () => {
            const r = await query('SELECT min(battery_id) AS b FROM dim_battery_scd2');
            if (r.rows[0].b) setBattery(String(r.rows[0].b));
          }}
        >
          取一个存在的电池ID
        </button>
      </div>
      {submitted && (
        <div style={{ marginTop: 10 }}>
          <DataTable
            sql={`SELECT battery_id, cabinet_id, station_id, change_type,
                    valid_from, valid_to, is_current
                  FROM dim_battery_scd2
                  WHERE battery_id='${submitted.b.replace(/'/g, '')}'
                    AND TIMESTAMP '${submitted.t.replace(/'/g, '')}' >= valid_from
                    AND TIMESTAMP '${submitted.t.replace(/'/g, '')}' < valid_to`}
            title="该时间点的有效归属"
          />
          <h4 style={{ marginTop: 14 }}>该电池全历史 SCD2 切片</h4>
          <DataTable
            sql={`SELECT * FROM dim_battery_scd2 WHERE battery_id='${submitted.b.replace(/'/g, '')}' ORDER BY valid_from`}
          />
        </div>
      )}
    </div>
  );
}
