import { useState } from 'react';
import { useStore } from '../store';
import { runRule } from '../lib/quality';
import type { QualityRule, RuleResult, RuleType } from '../types';
import { DataTable } from '../components/DataTable';

const TYPE_LABEL: Record<RuleType, string> = {
  unique: '唯一',
  not_null: '非空',
  range: '范围',
  mom_spike: '环比突变',
};

export function QualityPage() {
  const { rules, updateRule, addRule, removeRule, models, setNotice } = useStore();
  const [results, setResults] = useState<RuleResult[]>([]);
  const [running, setRunning] = useState(false);
  const [editing, setEditing] = useState<QualityRule | null>(null);

  async function runAll() {
    setRunning(true);
    const out: RuleResult[] = [];
    for (const r of rules.filter((x) => x.enabled)) {
      out.push(await runRule(r));
    }
    setResults(out);
    setRunning(false);
    const failed = out.filter((r) => !r.passed);
    setNotice(failed.length ? `⛔ ${failed.length} 条规则未通过，管道运行时将阻断下游` : '✅ 全部启用规则通过');
  }

  const tableOptions = models.map((m) => m.name);

  return (
    <div className="grid">
      <div className="card">
        <h3>质量规则（不通过的批次在管道中被挡在 DWS/ADS 之外）</h3>
        <div className="row" style={{ marginBottom: 10 }}>
          <button className="primary" disabled={running} onClick={runAll}>
            {running ? '校验中…' : '▶ 立即执行全部启用规则'}
          </button>
          <button className="small" onClick={() => setEditing({ id: `rq_${Date.now()}`, name: '新规则', table: tableOptions[0], field: '', type: 'not_null', enabled: true })}>
            + 新增规则
          </button>
        </div>
        <table>
          <thead>
            <tr>
              <th>启用</th><th>规则名</th><th>表</th><th>字段</th><th>类型</th><th>参数</th><th>最近结果</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => {
              const res = results.find((x) => x.ruleId === r.id);
              return (
                <tr key={r.id}>
                  <td>
                    <input type="checkbox" checked={r.enabled} onChange={(e) => updateRule(r.id, { enabled: e.target.checked })} />
                  </td>
                  <td>{r.name}</td>
                  <td><code>{r.table}</code></td>
                  <td><code>{r.field}</code></td>
                  <td>{TYPE_LABEL[r.type]}</td>
                  <td className="muted">
                    {r.type === 'range' && `[${r.params?.min}, ${r.params?.max}]`}
                    {r.type === 'mom_spike' && `±${(r.params?.spikeRatio ?? 0) * 100}%`}
                  </td>
                  <td>
                    {res ? (
                      <span className={`badge ${res.passed ? 'ok' : 'failed'}`}>
                        {res.passed ? '通过' : `${res.failedRows} 行失败`}
                      </span>
                    ) : (
                      <span className="muted">未运行</span>
                    )}
                  </td>
                  <td>
                    <button className="small" onClick={() => setEditing(r)}>编辑</button>{' '}
                    <button className="small danger" onClick={() => removeRule(r.id)}>删除</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {results.length > 0 && (
        <div className="card">
          <h3>本次校验明细</h3>
          <table>
            <thead><tr><th>规则</th><th>检查行数</th><th>失败行数</th><th>说明</th></tr></thead>
            <tbody>
              {results.map((r) => {
                const rule = rules.find((x) => x.id === r.ruleId);
                return (
                  <tr key={r.ruleId}>
                    <td>{rule?.name ?? r.ruleId}</td>
                    <td>{r.checkedRows.toLocaleString()}</td>
                    <td style={{ color: r.failedRows > 0 ? 'var(--red)' : undefined }}>{r.failedRows}</td>
                    <td className="wrap muted">{r.detail}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <h3>质量审计表 dq_result（随管道运行写入）</h3>
        <DataTable sql="SELECT batch_id, rule_name, target_table, target_field, rule_type, passed, checked_rows, failed_rows, checked_at FROM dq_result ORDER BY checked_at DESC" />
      </div>

      {editing && (
        <RuleEditor
          rule={editing}
          tableOptions={tableOptions}
          fieldsOf={(t) => models.find((m) => m.name === t)?.lineage ? Object.keys(models.find((m) => m.name === t)!.lineage) : []}
          onClose={() => setEditing(null)}
          onSave={(r) => {
            if (rules.some((x) => x.id === r.id)) updateRule(r.id, r);
            else addRule(r);
            setEditing(null);
            setNotice(`已保存规则 ${r.name}`);
          }}
        />
      )}
    </div>
  );
}

function RuleEditor({
  rule,
  tableOptions,
  fieldsOf,
  onClose,
  onSave,
}: {
  rule: QualityRule;
  tableOptions: string[];
  fieldsOf: (t: string) => string[];
  onClose: () => void;
  onSave: (r: QualityRule) => void;
}) {
  const [draft, setDraft] = useState<QualityRule>({ ...rule, params: { ...(rule.params ?? {}) } });
  const fields = fieldsOf(draft.table);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>编辑质量规则</h3>
        <div className="grid" style={{ gap: 10 }}>
          <label>规则名称<input style={{ width: '100%' }} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
          <label>目标表
            <select style={{ width: '100%' }} value={draft.table} onChange={(e) => setDraft({ ...draft, table: e.target.value, field: '' })}>
              {tableOptions.map((t) => <option key={t}>{t}</option>)}
            </select>
          </label>
          <label>字段
            <select style={{ width: '100%' }} value={draft.field} onChange={(e) => setDraft({ ...draft, field: e.target.value })}>
              {fields.map((f) => <option key={f}>{f}</option>)}
            </select>
          </label>
          <label>类型
            <select style={{ width: '100%' }} value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value as RuleType })}>
              {(Object.keys(TYPE_LABEL) as RuleType[]).map((t) => <option key={t} value={t}>{TYPE_LABEL[t as RuleType]}</option>)}
            </select>
          </label>
          {draft.type === 'range' && (
            <div className="row">
              <label>最小值<input type="number" value={draft.params?.min ?? 0} onChange={(e) => setDraft({ ...draft, params: { ...draft.params, min: Number(e.target.value) } })} /></label>
              <label>最大值<input type="number" value={draft.params?.max ?? 0} onChange={(e) => setDraft({ ...draft, params: { ...draft.params, max: Number(e.target.value) } })} /></label>
            </div>
          )}
          {draft.type === 'mom_spike' && (
            <label>环比突变阈值（比例，0.5 = ±50%）
              <input type="number" step="0.1" style={{ width: '100%' }} value={draft.params?.spikeRatio ?? 0.5}
                onChange={(e) => setDraft({ ...draft, params: { ...draft.params, spikeRatio: Number(e.target.value) } })} />
            </label>
          )}
        </div>
        <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
          <button onClick={onClose}>取消</button>
          <button className="primary" onClick={() => onSave(draft)}>保存</button>
        </div>
      </div>
    </div>
  );
}
