import { useEffect, useState } from 'react';
import { query } from '../lib/duckdb';

interface Props {
  sql: string;
  title?: string;
  pageSize?: number;
  onError?: (msg: string) => void;
}

/** 通用 SQL 结果预览表（分页 + 自动 LIMIT，防止一次拉取过大） */
export function DataTable({ sql, title, pageSize = 20, onError }: Props) {
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [cols, setCols] = useState<string[]>([]);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const countSql = `SELECT count(*)::BIGINT AS n FROM (${sql.replace(/;+\s*$/, '')}) _sq`;
    const pageSql = `SELECT * FROM (${sql.replace(/;+\s*$/, '')}) _sq LIMIT ${pageSize} OFFSET ${page * pageSize}`;
    Promise.all([query(countSql), query(pageSql)])
      .then(([c, d]) => {
        if (cancelled) return;
        setTotal(Number(c.rows[0].n));
        setRows(d.rows);
        setCols(d.columns.map((x) => x.name));
        setErr('');
      })
      .catch((e) => {
        if (cancelled) return;
        setErr((e as Error).message);
        onError?.((e as Error).message);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [sql, page, pageSize]);

  const pages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div>
      {title && (
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
          <strong>{title}</strong>
          <span className="muted">
            {total.toLocaleString()} 行 · 第 {page + 1}/{pages} 页
          </span>
        </div>
      )}
      {loading && <div className="muted">查询中…</div>}
      {err && <pre className="code" style={{ color: 'var(--red)' }}>{err}</pre>}
      {!err && !loading && (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                {cols.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  {cols.map((c) => (
                    <td key={c}>{r[c] === null ? <span className="muted">NULL</span> : String(r[c])}</td>
                  ))}
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={cols.length || 1} className="muted">
                    无数据
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <div className="row" style={{ marginTop: 8 }}>
        <button className="small" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
          上一页
        </button>
        <button className="small" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)}>
          下一页
        </button>
      </div>
    </div>
  );
}
