// 真实浏览器端到端验证：驱动系统 Chrome 访问 vite preview，
// 校验 COI 跨域隔离、DuckDB 多线程初始化、500 万行全链路耗时与关键交互。
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 4173;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
  cwd: root,
  shell: true,
});
await sleep(3500);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 950 });

const consoleLogs = [];
const pageErrors = [];
page.on('console', (m) => consoleLogs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => pageErrors.push(e.message));

const results = {};
try {
  await page.goto(`http://localhost:${PORT}`, { waitUntil: 'networkidle0', timeout: 60000 });

  // 1) COI 跨域隔离（多线程前提）
  results.crossOriginIsolated = await page.evaluate(() => globalThis.crossOriginIsolated === true);

  // 2) 等待 DuckDB 就绪
  await page.waitForFunction(
    () => document.body.innerText.includes('DuckDB 就绪'),
    { timeout: 30000 },
  );
  results.dbMode = (await page.evaluate(() => document.body.innerText.match(/DuckDB 就绪 · (.+?)(\n|$)/)?.[1])) ?? 'unknown';

  // 3) 切到数据源页，选择 500 万并触发生成
  await page.evaluate(() => {
    const sel = document.querySelector('select');
    return sel ? sel.value : null;
  });
  // 找到行数下拉并选 500 万
  await page.evaluate(() => {
    const selects = Array.from(document.querySelectorAll('select'));
    for (const s of selects) {
      if (Array.from(s.options).some((o) => o.value === '5000000')) {
        s.value = '5000000';
        s.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  });
  const genBtn = await page.waitForSelector('button.primary', { timeout: 5000 });
  const tGen0 = Date.now();
  await genBtn.click();
  // 等待生成完成通知
  await page.waitForFunction(
    () => document.body.innerText.includes('测试数据已写入 ODS') || document.body.innerText.includes('生成失败'),
    { timeout: 120000 },
  );
  results.generateMs = Date.now() - tGen0;
  results.genNotice = (await page.evaluate(() => document.querySelector('.notice')?.textContent)) ?? '';

  // 4) 切到管道页，勾选强制继续（脏数据会触发质量门），运行全量
  const tabs = await page.$$('.tab');
  await tabs[1].click();
  await sleep(500);
  // 勾选「质量门失败时强制继续」
  await page.evaluate(() => {
    const cb = document.querySelector('input[type="checkbox"]');
    if (cb && !cb.checked) cb.click();
  });
  const runBtns = await page.$$('button.primary');
  const tRun0 = Date.now();
  await runBtns[0].click();
  // 强制继续下管道最终会跑完所有任务（状态 ok）
  await page.waitForFunction(
    () => {
      const t = document.body.innerText;
      return t.includes('全量管道完成') || t.includes('管道失败');
    },
    { timeout: 180000 },
  );
  results.pipelineMs = Date.now() - tRun0;
  results.runNotice = (await page.evaluate(() => document.querySelector('.notice')?.textContent)) ?? '';

  // 5) 读取各任务状态与分层行数
  results.taskLines = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.task-line')).map((el) => el.innerText.replace(/\s+/g, ' ').trim()),
  );

  // 6) 切到质量页执行规则
  await (await page.$$('.tab'))[3].click();
  await sleep(500);
  const qBtn = (await page.$$('button.primary'))[0];
  await qBtn.click();
  await page.waitForFunction(
    () => {
      const t = document.body.innerText;
      return t.includes('未通过，管道运行时将阻断下游') || t.includes('全部启用规则通过');
    },
    { timeout: 60000 },
  );
  results.qualityNotice = (await page.evaluate(() => document.querySelector('.notice')?.textContent)) ?? '';
  results.qualityBadges = await page.evaluate(() =>
    Array.from(document.querySelectorAll('table .badge')).map((b) => b.textContent.trim()),
  );

  // 7) 切到血缘页，确认图渲染并点一个字段
  await (await page.$$('.tab'))[4].click();
  await sleep(1500);
  results.reactFlowNodes = await page.evaluate(() => document.querySelectorAll('.react-flow__node').length);
  results.reactFlowEdges = await page.evaluate(() => document.querySelectorAll('.react-flow__edge').length);
  const firstField = await page.$('.react-flow__node .field-chip');
  if (firstField) {
    await firstField.click();
    await sleep(800);
    results.afterPickHighlight = await page.evaluate(() => document.querySelectorAll('.field-chip[style*="rgb(120, 53, 15)"], .field-chip[style*="border-color"]').length);
    results.upstreamPanel = await page.evaluate(() => document.body.innerText.includes('上游字段'));
  }

  // 8) 模型页 SQL 编辑可用性
  await (await page.$$('.tab'))[2].click();
  await sleep(600);
  results.modelCount = await page.evaluate(() => document.querySelectorAll('.split code').length);
  results.hasSqlEditor = await page.evaluate(() => !!document.querySelector('textarea.sql-editor'));

  results.consoleErrors = consoleLogs.filter((l) => l.includes('[error]')).slice(0, 10);
  results.pageErrors = pageErrors.slice(0, 10);
} catch (e) {
  results.fatal = e.message;
  results.consoleErrors = consoleLogs.filter((l) => l.includes('[error]')).slice(0, 10);
  results.pageErrors = pageErrors.slice(0, 10);
} finally {
  await browser.close();
  server.kill();
}

console.log(JSON.stringify(results, null, 2));
process.exit(results.fatal || (results.pageErrors && results.pageErrors.length) ? 1 : 0);
