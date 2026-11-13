// 场景验证：质量门阻断、文件导入(Arrow 落表)、迟到回补、SCD2 时间点查询、指标版本对比
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 4174;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: root, shell: true });
await sleep(3500);
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 950 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.log('BROWSER-ERR:', m.text().slice(0, 300));
});
const out = {};
const tmpJson = path.join(root, 'tmp_import.jsonl');
const tmpCsv = path.join(root, 'tmp_import.csv');

try {
  await page.goto(`http://localhost:${PORT}`, { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForFunction(() => document.body.innerText.includes('DuckDB 就绪'), { timeout: 30000 });

  // ---------- 场景 1：文件导入（用页面生成器在 Node 侧造文件，再通过 input 上传）----------
  // 直接在页面上下文生成样例文件内容并通过 DataTransfer 注入
  const jsonl = await page.evaluate(() => {
    const lines = [];
    for (let i = 0; i < 300; i++) {
      lines.push(JSON.stringify({
        log_id: `IMP${String(i).padStart(8, '0')}`,
        cabinet_id: `CB000${i % 9}`, station_id: 'ST001', battery_id: `BT000${i % 50}`,
        event_time: '2026-11-08 10:00:00', swap_type: 'swap',
        soc_before: 50, soc_after: 80, temperature: 28.5, voltage: 52.0,
        cycle_cnt: 100, is_abnormal: false, ingest_ts: '2026-11-08 11:00:00',
      }));
    }
    return lines.join('\n');
  });
  const csv = 'battery_id,cabinet_id,station_id,change_time,change_type\n' +
    Array.from({ length: 50 }, (_, i) => `BT000${i % 50},CB000${i % 9},ST001,2026-11-0${(i % 9) + 1} 09:00:00,cabinet_change`).join('\n');

  const tmpCsvPath = tmpCsv;
  fs.writeFileSync(tmpJson, jsonl);
  fs.writeFileSync(tmpCsvPath, csv);

  const fileInput = await page.$('input[type="file"]');
  await fileInput.uploadFile(tmpJson, tmpCsv);
  await page.waitForFunction(() => document.body.innerText.includes('导入'), { timeout: 30000 });
  await sleep(1500);
  out.importNotice = await page.evaluate(() => document.querySelector('.notice')?.textContent ?? '');
  out.importedSchemaFields = await page.evaluate(() => document.querySelectorAll('.card table select').length);
  // 验证导入行数（ODS 预览计数）
  await page.waitForFunction(() => document.body.innerText.includes('300'), { timeout: 15000 }).catch(() => {});

  // ---------- 场景 2：生成 100 万数据并验证质量门阻断（不勾选强制继续）----------
  await page.evaluate(() => {
    for (const s of document.querySelectorAll('select')) {
      if (Array.from(s.options).some((o) => o.value === '1000000')) {
        s.value = '1000000';
        s.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  });
  const genButtons = await page.$$('button.primary');
  await genButtons[0].click();
  await page.waitForFunction(() => document.body.innerText.includes('测试数据已写入 ODS'), { timeout: 90000 });

  await (await page.$$('.tab'))[1].click();
  await sleep(400);
  // 确保强制继续复选框未勾选
  const checked = await page.evaluate(() => document.querySelector('input[type="checkbox"]')?.checked);
  if (checked) await page.evaluate(() => document.querySelector('input[type="checkbox"]').click());
  await (await page.$$('button.primary'))[0].click();
  await page.waitForFunction(
    () => document.body.innerText.includes('质量门拦截') || document.body.innerText.includes('全量管道完成'),
    { timeout: 120000 },
  );
  out.blockingNotice = await page.evaluate(() => document.querySelector('.notice')?.textContent ?? '');
  out.blockedTaskCount = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.task-line .badge.blocked')).length,
  );

  // ---------- 场景 3：迟到数据注入 + 重跑回补 ----------
  const injectBtn = await page.waitForSelector('[data-testid="inject-late"]', { timeout: 5000 });
  await injectBtn.click();
  await page.waitForFunction(() => document.body.innerText.includes('迟到数据已进入 ODS'), { timeout: 30000 });
  out.lateNotice = await page.evaluate(() => document.querySelector('.notice')?.textContent ?? '');

  // 勾选强制继续后重跑，让下游建表
  await page.evaluate(() => {
    const cb = document.querySelector('input[type="checkbox"]');
    if (!cb.checked) cb.click();
  });
  await (await page.$$('button.primary'))[0].click();
  await page.waitForFunction(() => document.body.innerText.includes('全量管道完成'), { timeout: 120000 });
  await sleep(800);
  // 读取迟到分区验证表
  out.latePartitionText = await page.evaluate(() => {
    const card = Array.from(document.querySelectorAll('.card')).find((c) => c.textContent.includes('迟到回补验证'));
    return card ? card.innerText.slice(0, 300) : 'NOT FOUND';
  });

  // ---------- 场景 4：SCD2 任意时间点查询 ----------
  await page.waitForSelector('[data-testid="scd-pick"]', { timeout: 5000 });
  await page.click('[data-testid="scd-pick"]');
  await sleep(300);
  await page.click('[data-testid="scd-query"]');
  await page.waitForFunction(() => document.body.innerText.includes('该电池全历史 SCD2 切片'), { timeout: 15000 });
  out.scdHasResult = await page.evaluate(() => document.body.innerText.includes('该时间点的有效归属'));
  out.scdHistoryRows = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.card table tbody tr')).length,
  );

  // ---------- 场景 5：指标版本对比（模型页）----------
  await (await page.$$('.tab'))[2].click();
  await sleep(800);
  out.metricCompareVisible = await page.evaluate(() => document.body.innerText.includes('新旧口径结果对比'));
  out.metricTableRows = await page.evaluate(() =>
    document.querySelectorAll('.card table tbody tr').length,
  );

  out.errors = errors;
} catch (e) {
  out.fatal = e.message;
  out.errors = errors;
} finally {
  fs.rmSync(tmpJson, { force: true });
  fs.rmSync(tmpCsv, { force: true });
  await browser.close();
  server.kill();
}
console.log(JSON.stringify(out, null, 2));
process.exit(out.fatal || out.errors.length ? 1 : 0);
