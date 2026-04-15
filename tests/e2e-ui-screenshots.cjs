'use strict';

/**
 * Playwright UI smoke: dashboard, Generation settings, Model details, /header-ui.
 * Install: npm i -D playwright && npx playwright install chromium
 * Run: npm run test:e2e-ui
 * Artifacts: tests/screenshots-out/ (gitignored)
 */
const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.log('e2e-ui: SKIP — install playwright: npm i -D playwright && npx playwright install chromium');
  process.exit(0);
}

const TEST_PORT = Number.parseInt(process.env.TEST_ROUTER_PORT_E2E || '20997', 10);
const outDir = path.join(__dirname, 'screenshots-out');

function waitHealth(port, timeout = 20000) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (Date.now() - t0 > timeout) {
        reject(new Error('router health timeout'));
        return;
      }
      const req = http.get(`http://127.0.0.1:${port}/api/health`, (res) => {
        res.resume();
        if (res.statusCode === 200) resolve();
        else setTimeout(tick, 120);
      });
      req.on('error', () => setTimeout(tick, 120));
    };
    tick();
  });
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const routerDir = path.join(__dirname, '..', 'router');
  const env = { ...process.env, ROUTER_PORT: String(TEST_PORT) };
  delete env.ROUTER_ADMIN_TOKEN;

  const child = spawn(process.execPath, ['server.js'], {
    cwd: routerDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const kill = () => {
    try {
      child.kill('SIGTERM');
    } catch (_) {}
  };
  const tkill = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch (_) {}
  }, 4000);
  child.on('exit', () => clearTimeout(tkill));

  try {
    await waitHealth(TEST_PORT);
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
    const base = `http://127.0.0.1:${TEST_PORT}`;

    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(String(err && err.message ? err.message : err)));

    await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('#local-pool-panel', { timeout: 15000 });
    await page.waitForSelector('.dash-card--models-runtime', { timeout: 5000 });

    // Main dashboard script must parse and run (footer padding, collapse, system-stats poller).
    await page.waitForFunction(
      () => {
        const pad = document.body && document.body.style.paddingBottom;
        return pad && parseFloat(pad) >= 40;
      },
      { timeout: 12000 },
    );
    await page.waitForFunction(
      () => {
        const el = document.getElementById('r-cpu');
        return el && el.textContent && el.textContent !== '—%' && !/^\s*—\s*$/.test(el.textContent);
      },
      { timeout: 12000 },
    );
    const docH = await page.evaluate(() => ({
      scrollHeight: document.documentElement.scrollHeight,
      clientHeight: document.documentElement.clientHeight,
    }));
    if (docH.scrollHeight <= docH.clientHeight) {
      throw new Error(`expected document scrollHeight > clientHeight for scrollable page, got ${JSON.stringify(docH)}`);
    }
    await page.click('#fixedLogToggleBtn');
    await page.waitForFunction(
      () => document.getElementById('fixedLogFooter') && document.getElementById('fixedLogFooter').classList.contains('is-collapsed'),
      { timeout: 5000 },
    );
    if (pageErrors.length) {
      throw new Error(`dashboard page JS errors: ${pageErrors.join(' | ')}`);
    }

    await page.screenshot({ path: path.join(outDir, '01-dashboard.png'), fullPage: true });

    await page.click('#btn-open-gen-settings');
    await page.waitForSelector('#settings-diff-tbody tr', { timeout: 15000 });
    const aria = await page.locator('#settings-diff-tbody .ov-cb').first().getAttribute('aria-label');
    if (!aria || aria.length < 8) {
      throw new Error(`settings checkbox aria-label missing or too short: ${String(aria)}`);
    }
    await page.screenshot({ path: path.join(outDir, '02-settings-modal.png') });

    await page.click('#settings-modal-close');
    await page.evaluate(() => {
      if (typeof openModelInfoModal === 'function') openModelInfoModal();
    });
    await page.waitForSelector('#info-readonly-note', { state: 'visible', timeout: 15000 });
    await page.waitForSelector('#info-hero-name', { timeout: 5000 });
    await page.screenshot({ path: path.join(outDir, '03-model-info-modal.png') });
    await page.click('#model-info-close');

    await page.goto(`${base}/header-ui`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('.header-ui-preview-note', { timeout: 10000 });
    await page.screenshot({ path: path.join(outDir, '04-header-ui.png'), fullPage: true });

    await browser.close();
    console.log('e2e-ui: OK — screenshots in', outDir);
  } finally {
    kill();
    await new Promise((r) => setTimeout(r, 400));
  }
})().catch((e) => {
  console.error('e2e-ui: FAIL', e);
  process.exit(1);
});
