import { useMemo, useState, useCallback } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  type Node,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useStore, LAYER_COLORS } from '../store';
import type { LayerName, TableModel } from '../types';

interface FieldRef {
  table: string;
  field: string;
}

/** 自定义节点：表卡片 + 字段 chips，点击字段高亮上下游链路 */
function TableNode({ data }: { data: Record<string, unknown> }) {
  const model = data.model as TableModel;
  const selected = data.selectedField as string | null;
  const highlight = data.highlightFields as Set<string>;
  const dimmed = data.dimmed as boolean;
  const onPick = data.onPick as (table: string, field: string) => void;
  const fields = Object.keys(model.lineage);

  return (
    <div
      style={{
        background: '#1e293b',
        border: `1.5px solid ${LAYER_COLORS[model.layer]}`,
        borderRadius: 10,
        padding: 0,
        minWidth: 210,
        opacity: dimmed ? 0.35 : 1,
        fontSize: 12,
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: LAYER_COLORS[model.layer] }} />
      <div style={{ background: LAYER_COLORS[model.layer], padding: '6px 10px', borderRadius: '8px 8px 0 0', fontWeight: 700 }}>
        <span className={`badge ${model.layer}`}>{model.layer}</span> {model.name}
      </div>
      <div style={{ padding: 6, maxHeight: 260, overflow: 'auto' }}>
        {fields.map((f) => {
          const key = `${model.name}.${f}`;
          const isSel = selected === key;
          const isHi = highlight.has(key);
          return (
            <div
              key={f}
              className={`field-chip ${isSel ? 'selected' : ''}`}
              style={{
                display: 'block',
                borderColor: isHi ? '#fbbf24' : undefined,
                background: isHi ? '#78350f' : isSel ? '#0c4a6e' : undefined,
              }}
              onClick={() => onPick(model.name, f)}
              title={model.lineage[f].length ? `上游: ${model.lineage[f].map((x) => `${x.table}.${x.field}`).join(', ')}` : '源字段（无上游）'}
            >
              {f}
              {!model.lineage[f].length && <span className="muted"> ·源</span>}
            </div>
          );
        })}
      </div>
      <Handle type="source" position={Position.Right} style={{ background: LAYER_COLORS[model.layer] }} />
    </div>
  );
}

const nodeTypes = { table: TableNode };

/** 简单分层布局：按 ODS→DWD→DWS→ADS 分列 */
function layout(models: TableModel[]): Map<string, { x: number; y: number }> {
  const colX: Record<LayerName, number> = { ODS: 0, DWD: 320, DWS: 640, ADS: 960 };
  const rows = new Map<LayerName, number>();
  const pos = new Map<string, { x: number; y: number }>();
  for (const m of models) {
    const y = (rows.get(m.layer) ?? 0) * 330;
    rows.set(m.layer, (rows.get(m.layer) ?? 0) + 1);
    pos.set(m.name, { x: colX[m.layer], y });
  }
  return pos;
}

export function LineagePage() {
  const { models } = useStore();
  const [picked, setPicked] = useState<{ table: string; field: string } | null>(null);

  const onPick = useCallback((table: string, field: string) => {
    setPicked((cur) => (cur?.table === table && cur?.field === field ? null : { table, field }));
  }, []);

  /** 计算选中字段的完整上下游字段集合（沿 lineage 关系双向传播） */
  const { highlightFields, highlightEdges, relatedTables } = useMemo(() => {
    const hf = new Set<string>();
    const he = new Set<string>();
    const rt = new Set<string>();
    if (!picked) return { highlightFields: hf, highlightEdges: he, relatedTables: rt };

    const startKey = `${picked.table}.${picked.field}`;
    hf.add(startKey);
    rt.add(picked.table);

    // 向上游传播：找 lineage 中指向当前字段的
    const upstream = (table: string, field: string) => {
      for (const m of models) {
        for (const [outField, refs] of Object.entries(m.lineage)) {
          if (refs.some((r) => r.table === table && r.field === field)) {
            const k = `${m.name}.${outField}`;
            const edge = `${m.name}.${outField}->${table}.${field}`;
            if (!hf.has(k)) {
              hf.add(k);
              rt.add(m.name);
              he.add(edge);
              upstream(m.name, outField);
            }
            he.add(edge);
          }
        }
      }
    };
    // 向下游传播：当前字段的 lineage refs
    const downstream = (table: string, field: string) => {
      const m = models.find((x) => x.name === table);
      if (!m) return;
      for (const ref of (m.lineage[field] ?? []) as FieldRef[]) {
        const k = `${ref.table}.${ref.field}`;
        const edge = `${table}.${field}->${ref.table}.${ref.field}`;
        he.add(edge);
        if (!hf.has(k)) {
          hf.add(k);
          rt.add(ref.table);
          downstream(ref.table, ref.field);
        }
      }
    };
    upstream(picked.table, picked.field);
    downstream(picked.table, picked.field);
    return { highlightFields: hf, highlightEdges: he, relatedTables: rt };
  }, [picked, models]);

  const positions = useMemo(() => layout(models), [models]);

  const nodes: Node[] = useMemo(
    () =>
      models.map((m) => ({
        id: m.name,
        type: 'table',
        position: positions.get(m.name) ?? { x: 0, y: 0 },
        data: {
          model: m,
          selectedField: picked ? `${picked.table}.${picked.field}` : null,
          highlightFields,
          dimmed: picked ? !relatedTables.has(m.name) : false,
          onPick,
        },
      })),
    [models, positions, picked, highlightFields, relatedTables, onPick],
  );

  const edges: Edge[] = useMemo(() => {
    const seen = new Set<string>();
    const list: Edge[] = [];
    for (const m of models) {
      for (const refs of Object.values(m.lineage) as FieldRef[][]) {
        for (const ref of refs) {
          const id = `${ref.table}->${m.name}`;
          if (seen.has(id)) continue;
          seen.add(id);
          const active = picked
            ? Array.from(highlightEdges).some((e) => e.startsWith(`${m.name}.`) && e.includes(`->${ref.table}.`)) ||
              Array.from(highlightEdges).some((e) => e.startsWith(`${ref.table}.`) && e.includes(`->${m.name}.`))
            : false;
          list.push({
            id,
            source: ref.table,
            target: m.name,
            animated: active,
            style: {
              stroke: active ? '#fbbf24' : '#475569',
              strokeWidth: active ? 2.5 : 1.2,
            },
          });
        }
      }
    }
    return list;
  }, [models, highlightEdges, picked]);

  const pickedModel = picked ? models.find((m) => m.name === picked.table) : null;
  const pickedRefs: FieldRef[] = picked && pickedModel ? (pickedModel.lineage[picked.field] ?? []) : [];

  return (
    <div className="grid">
      <div className="card">
        <h3>
          表/字段血缘图
          {picked && (
            <span style={{ marginLeft: 10 }}>
              <span className="pill" style={{ borderColor: '#fbbf24' }}>
                {picked.table}.{picked.field}
              </span>
              <button className="small" style={{ marginLeft: 8 }} onClick={() => setPicked(null)}>
                清除选择
              </button>
            </span>
          )}
        </h3>
        <div className="muted" style={{ marginBottom: 8 }}>
          点击任意表卡片中的字段，高亮其全部上游来源与下游消费字段（金色路径）；未相关的表自动淡化。
        </div>
        <div className="lineage-wrap">
          <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView minZoom={0.2} proOptions={{ hideAttribution: true }}>
            <Background color="#334155" gap={24} />
            <Controls />
          </ReactFlow>
        </div>
      </div>

      {picked && (
        <div className="grid cols2">
          <div className="card">
            <h3>上游字段（{picked.table}.{picked.field} 来自）</h3>
            {pickedRefs.length ? (
              pickedRefs.map((r, i) => (
                <div key={i} className="field-chip selected" style={{ display: 'block' }}>
                  {r.table}.{r.field}
                </div>
              ))
            ) : (
              <div className="muted">该字段为 ODS 源字段，无上游。</div>
            )}
          </div>
          <div className="card">
            <h3>下游字段（谁消费了它）</h3>
            <DownstreamList table={picked.table} field={picked.field} models={models} />
          </div>
        </div>
      )}
    </div>
  );
}

function DownstreamList({ table, field, models }: { table: string; field: string; models: TableModel[] }) {
  const items: string[] = [];
  const walk = (t: string, f: string) => {
    for (const m of models) {
      for (const [outField, refs] of Object.entries(m.lineage) as [string, FieldRef[]][]) {
        if (refs.some((r: FieldRef) => r.table === t && r.field === f)) {
          const key = `${m.name}.${outField}`;
          if (!items.includes(key)) {
            items.push(key);
            walk(m.name, outField);
          }
        }
      }
    }
  };
  walk(table, field);
  if (!items.length) return <div className="muted">无下游消费（ADS 末端字段）。</div>;
  return (
    <>
      {items.map((k) => (
        <div key={k} className="field-chip selected" style={{ display: 'block' }}>{k}</div>
      ))}
    </>
  );
}
