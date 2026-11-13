import { useEffect } from 'react';
import { initDuckDB } from './lib/duckdb';
import { useStore } from './store';
import { SourcesPage } from './pages/SourcesPage';
import { PipelinePage } from './pages/PipelinePage';
import { ModelsPage } from './pages/ModelsPage';
import { QualityPage } from './pages/QualityPage';
import { LineagePage } from './pages/LineagePage';

const TABS = [
  { id: 'sources', label: '数据源' },
  { id: 'pipeline', label: '管道编排' },
  { id: 'models', label: '模型分层' },
  { id: 'quality', label: '质量校验' },
  { id: 'lineage', label: '血缘' },
];

export function App() {
  const { ready, dbMode, activeTab, setTab, setReady, notice } = useStore();

  useEffect(() => {
    initDuckDB()
      .then(({ mode }) => setReady(mode))
      .catch((e) => console.error('DuckDB 初始化失败', e));
  }, [setReady]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          🔋 换电柜湖仓平台 <span className="tag">· 浏览器端分层数据处理</span>
        </div>
        <nav className="tabs">
          {TABS.map((t) => (
            <div key={t.id} className={`tab ${activeTab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
              {t.label}
            </div>
          ))}
        </nav>
        <div className="db-status">
          <span className={`dot ${ready ? 'ok' : 'wait'}`} />
          {ready ? `DuckDB 就绪 · ${dbMode}` : 'DuckDB 加载中…'}
        </div>
      </header>
      <main className="content">
        {!ready && <div className="muted">正在初始化 DuckDB-WASM 引擎（首次加载约几秒）…</div>}
        {ready && activeTab === 'sources' && <SourcesPage />}
        {ready && activeTab === 'pipeline' && <PipelinePage />}
        {ready && activeTab === 'models' && <ModelsPage />}
        {ready && activeTab === 'quality' && <QualityPage />}
        {ready && activeTab === 'lineage' && <LineagePage />}
      </main>
      {notice && <div className="notice">{notice}</div>}
    </div>
  );
}
