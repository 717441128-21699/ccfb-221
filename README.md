# 换电柜湖仓平台（浏览器端分层数据处理）

基于 **TypeScript + React + DuckDB-WASM + Apache Arrow + React Flow** 的纯浏览器数据平台。
所有数据处理、SQL 执行、存储都发生在浏览器标签页内，不落服务端，刷新页面后 ODS/DWD/DWS/ADS 表清空（模型定义、质量规则、指标口径通过 localStorage 持久化）。

## 快速开始

```bash
npm install
npm run dev        # 开发，自动带 COOP/COEP 头以启用 DuckDB 多线程
npm run build      # 类型检查 + 生产构建
npm run preview    # 预览生产构建（同样带 COOP/COEP 头）
```

打开后顶栏显示 `DuckDB 就绪 · COI 多线程` 即代表跨域隔离生效、pthread 多线程可用；
不满足隔离条件时自动降级为 EH 单线程，功能不变、耗时变长。

## 五大页面与需求映射

| 页面 | 能力 |
| --- | --- |
| 数据源 | JSONL/CSV 拖拽导入、前 2000 条采样自动推断字段类型、下拉手动改型（pinned 锁定）；引擎内生成 10 万/100 万/500 万行测试数据（含 8% 迟到、1% 脏数据）；样例文件下载 |
| 管道编排 | ODS→DWD→质量门→DWS→ADS 九任务 DAG，逐任务耗时与状态；质量门失败阻断下游、可强制继续；迟到数据注入与事件时间分区回补；SCD2 任意时间点归属查询 |
| 模型分层 | 四层 9 张表，SQL 在线编辑（localStorage 持久化）、EXPLAIN 校验、单独执行、数据预览；指标口径版本化管理与新旧版本结果对比 |
| 质量校验 | 唯一/非空/范围/环比突变四类规则，可增删改；不通过批次在管道中被挡在 DWS/ADS 之外；`dq_result` 审计表 |
| 血缘 | React Flow 表级 DAG，点击字段高亮全上下游字段链路（金色路径），未相关表自动淡化，附上下游字段清单 |

## 核心设计

### 分层与幂等
- ODS：`CREATE TABLE IF NOT EXISTS`，原始落地保留 `ingest_ts`/`source_file`。
- DWD/DWS/ADS：全部 `CREATE OR REPLACE TABLE`，重跑天然幂等，验证 500 万行重跑前后行数完全一致。
- 分区键统一为事件时间 `event_date`（台账为 `change_date`）；迟到日志按事件时间回补到对应日期分区，与入库时间无关。

### 缓慢变化维 SCD2
`dim_battery_scd2` 用 `lead(change_time)` 生成 `valid_from ~ valid_to` 区间，当前记录 `valid_to=9999-12-31`、`is_current=true`。
任意时间点归属：`WHERE :ts >= valid_from AND :ts < valid_to`，冒烟测试验证区间零重叠。

### 指标版本化
`ads_metric_daily` 主键 `(metric_id, version, event_date, station_id)`，同指标多版本共存，换口径不覆盖历史；
重算按 metric+version 先 DELETE 再 INSERT，可重复执行。

### 质量门
管道在 DWD 之后、DWS 之前设置唯一阻断点。任一启用规则失败 → 后续任务全部 `blocked`；
勾选「强制继续」仅告警不拦截，便于演示对比。环比突变按站点日聚合序列与前一日比较。

### 内存与性能
- 500 万行数据全部在 DuckDB 引擎内用 `range()` 生成，JS 侧不持有数据，避免主线程爆内存。
- 文件导入走 Apache Arrow `insertArrowTable` 零拷贝落表，仅保留 50 行采样用于页面展示。
- DWD 去重经基准对比选用 `row_number` 窗口（比多列 `arg_max` 内存更稳、比两步 JOIN 更省内存）。
- `memory_limit=3GB`、`threads=4`，所有 SQL 经单连接串行队列执行避免并发写冲突。

## 实测性能（Chrome / COI 多线程）

| 环节 | 500 万行耗时 |
| --- | --- |
| 引擎内生成日志 + 5 千电池台账 | ~4.0 s |
| 全量管道（ODS→ADS 九任务，含质量校验） | ~1.9 s |
| **端到端合计** | **~6 s**（要求 ≤ 120 s） |

## 测试脚本

```bash
npm run test:perf              # Node 阻塞式 wasm 冒烟：SQL 正确性/SCD2/幂等/质量规则/计时
node scripts/browser-e2e.mjs       # 系统 Chrome 端到端：COI 隔离、500 万计时、页面交互、零控制台错误
node scripts/browser-scenarios.mjs # 场景测试：文件导入、质量门阻断、迟到回补、SCD2、指标对比
```

> Node 冒烟使用单线程 mvp wasm（500 万行约 15s），浏览器 COI 多线程为真实性能口径（约 6s）。

## 目录结构

```
src/
  lib/        duckdb 封装、解析/类型推断/Arrow、数据生成、质量规则、管道编排
  models/     分层模型 SQL 注册表与默认指标口径
  pages/      五个页面
  components/ 通用 SQL 结果表等
  store.ts    zustand 全局状态 + localStorage 持久化
scripts/      Node 冒烟与浏览器 E2E
```
