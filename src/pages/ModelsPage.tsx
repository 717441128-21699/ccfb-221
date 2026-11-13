import { useMemo, useState } from 'react';
import { useStore, LAYER_COLORS } from '../store';
import { LAYER_COLORS as LC } from '../store';
import type { LayerName, TableModel, MetricVersion } from '../types';
import { query, exec } from '../lib/duckdb';
import { DataTable } from '../components/DataTable';

const LAYERS: LayerName[] = ['ODS', 'DWD', 'DWS', 'ADS'];

export function ModelsPage() {
  const { models, updateModelSql, resetModels, setNotice } = useStore();
  const [selected, setSelected] = useState(models[0]?.name ?? '');
  const [draft, setDraft] = useState(models[0]?.sql ?? '');
  const [previewKey, setPreviewKey] = useState(0);

  const model = models.find((m) => m.name === selected);

  function pick(m: TableModel) {
    setSelected(m.name);
    setDraft(m.sql);
  }

  function save() {
    updateModelSql(selected, draft);
    setNotice(`已保存 ${selected} 的 SQL（持久化到浏览器本地）`);
  }

  async function validate() {
    try {
      await query(`EXPLAIN ${draft.replace(/;+\s*$/, '')}`);
      setNotice('✅ SQL 语法校验通过（EXPLAIN 成功，未实际执行）');
    } catch (e) {
      setNotice(`❌ SQL 错误: ${(e as Error).message}`);
    }
  }

  async function applySingle() {
    try {
      await exec(draft);
      setNotice(`✅ 已单独执行 ${selected}`);
      setPreviewKey((k) => k + 1);
    } catch (e) {
      setNotice(`❌ 执行失败: ${(e as Error).message}`);
    }
  }

  const grouped = useMemo(
    () => LAYERS.map((l) => ({ layer: l, items: models.filter((m) => m.layer === l) })),
    [models],
  );

  return (
    <div className="split">
      <div className="card">
        <h3>分层模型</h3>
        {grouped.map((g) => (
          <div key={g.layer} style={{ marginBottom: 12 }}>
            <div style={{ color: LC[g.layer], fontWeight: 700, marginBottom: 4 }}>
              {g.layer}
              <span className="muted" style={{ fontWeight: 400, marginLeft: 6 }}>
                {layerDesc(g.layer)}
              </span>
            </div>
            {g.items.map((m) => (
              <div
                key={m.name}
                onClick={() => pick(m)}
                style={{
                  padding: '7px 9px',
                  borderRadius: 7,
                  cursor: 'pointer',
                  marginBottom: 3,
                  background: selected === m.name ? 'var(--panel2)' : 'transparent',
                  border: `1px solid ${selected === m.name ? LAYER_COLORS[m.layer] : 'transparent'}`,
                }}
              >
                <code style={{ fontSize: 12 }}>{m.name}</code>
                <div className="muted" style={{ fontSize: 11 }}>{m.comment}</div>
              </div>
            ))}
          </div>
        ))}
        <button className="small danger" onClick={() => { resetModels(); setNotice('已恢复默认模型与规则'); }}>
          恢复全部默认 SQL
        </button>
      </div>

      <div className="grid">
        <div className="card">
          <h3>
            {model && <span className={`badge ${model.layer}`}>{model.layer}</span>} {selected}
            {model?.partitionBy && <span className="pill" style={{ marginLeft: 8 }}>分区键: {model.partitionBy}</span>}
          </h3>
          <textarea
            className="sql-editor"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
          />
          <div className="row" style={{ marginTop: 8 }}>
            <button className="primary small" onClick={save}>保存 SQL</button>
            <button className="small" onClick={validate}>EXPLAIN 校验</button>
            <button className="small" onClick={applySingle}>单独执行</button>
          </div>
        </div>

        <div className="card">
          <h3>数据预览（前 20 行）</h3>
          <DataTable key={`${selected}-${previewKey}`} sql={`SELECT * FROM ${selected}`} />
        </div>

        <MetricVersionPanel />
      </div>
    </div>
  );
}

function layerDesc(l: LayerName): string {
  return { ODS: '原始落地', DWD: '清洗/维度', DWS: '轻度汇总', ADS: '应用指标' }[l];
}

function MetricVersionPanel() {
  const { metricVersions, saveMetricVersion, setNotice, models } = useStore();
  const [metric, setMetric] = useState('daily_swap_cnt');
  const [v1, setV1] = useState('v1');
  const [v2, setV2] = useState('v2');
  const [newExpr, setNewExpr] = useState('sum(swap_cnt - abnormal_cnt)');
  const [newVersion, setNewVersion] = useState('v3');

  const versionsOf = (m: string) => metricVersions.filter((x) => x.metric === m);

  async function addVersion() {
    const mv: MetricVersion = {
      id: `mv_${metric}_${newVersion}_${Date.now()}`,
      metric,
      version: newVersion,
      expression: newExpr,
      comment: '页面自定义口径',
      createdAt: new Date().toISOString(),
      active: false,
    };
    saveMetricVersion(mv);
    setNotice(`已新增口径版本 ${metric}@${newVersion}，到管道页重跑后生效`);
  }

  async function rerunMetrics() {
    // 直接在引擎内按当前版本定义重算 ADS（幂等）
    for (const mv of metricVersions) {
      await exec(`DELETE FROM ads_metric_daily WHERE metric_id='${mv.metric}' AND version='${mv.version}'`).catch(() => undefined);
      await exec(`
        INSERT INTO ads_metric_daily
        SELECT '${mv.metric}', '${mv.version}', event_date, station_id,
               CAST(${mv.expression} AS DOUBLE), CURRENT_TIMESTAMP
        FROM dws_swap_daily GROUP BY event_date, station_id`).catch((e) => {
        setNotice(`❌ 版本 ${mv.version} 计算失败: ${(e as Error).message}`);
      });
    }
    setNotice('✅ 指标版本已重新物化到 ads_metric_daily');
  }

  const compareSql = `
    WITH a AS (SELECT event_date, station_id, metric_value AS v_${v1} FROM ads_metric_daily WHERE metric_id='${metric}' AND version='${v1}'),
         b AS (SELECT event_date, station_id, metric_value AS v_${v2} FROM ads_metric_daily WHERE metric_id='${metric}' AND version='${v2}')
    SELECT a.event_date, a.station_id, a.v_${v1}, b.v_${v2},
           round(b.v_${v2} - a.v_${v1}, 2) AS diff,
           round((b.v_${v2} - a.v_${v1}) * 100.0 / nullif(a.v_${v1}, 0), 2) AS diff_pct
    FROM a JOIN b USING (event_date, station_id)
    ORDER BY a.event_date, a.station_id`;

  return (
    <div className="card">
      <h3>指标口径版本化与新旧对比</h3>
      <div className="grid cols2">
        <div>
          <h4>已有版本（表达式作用于 dws_swap_daily）</h4>
          <div className="scroll">
            <table>
              <thead><tr><th>指标</th><th>版本</th><th>表达式</th><th>启用</th></tr></thead>
              <tbody>
                {metricVersions.map((m) => (
                  <tr key={m.id}>
                    <td>{m.metric}</td>
                    <td>{m.version}</td>
                    <td className="wrap"><code style={{ fontSize: 11 }}>{m.expression}</code></td>
                    <td>{m.active ? '✅' : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div>
          <h4>新增口径版本</h4>
          <div className="grid" style={{ gap: 8 }}>
            <select value={metric} onChange={(e) => setMetric(e.target.value)}>
              {['daily_swap_cnt', 'abnormal_rate'].map((m) => <option key={m}>{m}</option>)}
            </select>
            <input placeholder="版本号" value={newVersion} onChange={(e) => setNewVersion(e.target.value)} />
            <input placeholder="聚合表达式" value={newExpr} onChange={(e) => setNewExpr(e.target.value)} />
            <div className="row">
              <button className="small primary" onClick={addVersion}>保存版本</button>
              <button className="small" onClick={rerunMetrics}>重算 ADS</button>
            </div>
          </div>
        </div>
      </div>

      <h4>新旧口径结果对比</h4>
      <div className="row" style={{ marginBottom: 8 }}>
        <select value={metric} onChange={(e) => { setMetric(e.target.value); setV1(versionsOf(e.target.value)[0]?.version ?? 'v1'); setV2(versionsOf(e.target.value)[1]?.version ?? 'v2'); }}>
          {Array.from(new Set(metricVersions.map((m) => m.metric))).map((m) => <option key={m}>{m}</option>)}
        </select>
        <select value={v1} onChange={(e) => setV1(e.target.value)}>
          {versionsOf(metric).map((m) => <option key={m.id}>{m.version}</option>)}
        </select>
        <span className="muted">vs</span>
        <select value={v2} onChange={(e) => setV2(e.target.value)}>
          {versionsOf(metric).map((m) => <option key={m.id}>{m.version}</option>)}
        </select>
      </div>
      <DataTable sql={compareSql} />
      <div className="muted" style={{ marginTop: 6 }}>
        同指标多版本共存于 ads_metric_daily（主键 metric_id+version+event_date+station_id），换口径不覆盖历史结果。
      </div>
      <div style={{ display: 'none' }}>{models.length}</div>
    </div>
  );
}
