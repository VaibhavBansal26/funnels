// Builds before/after contact sheets (JPEG, quality 80) from two folders produced by review-shots.mjs.
//   node contact-sheet.mjs <beforeDir> <afterDir> <outDir>
import { existsSync, mkdirSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

const [before, after, out] = process.argv.slice(2).map((p) => resolve(p));
if (!before || !after || !out) { console.error('usage: node contact-sheet.mjs <beforeDir> <afterDir> <outDir>'); process.exit(1); }
mkdirSync(out, { recursive: true });
const GROUPS = {
  app: ['auth-login', 'auth-register', 'funnels', 'funnels-new', 'funnel-steps', 'funnel-analytics', 'funnel-leads', 'funnel-orders', 'funnel-settings'],
  builder: ['builder', 'builder-blocks', 'builder-layers', 'builder-style', 'builder-settings-tab', 'builder-publish'],
  more: ['templates', 'products', 'products-performance', 'ads', 'ads-integrations', 'domains', 'webhooks', 'trash', 'audit', 'settings', 'admin', 'admin-queues'],
};
const CELL = { 1440: [620, 420], 1024: [520, 400], 390: [230, 460] };
const browser = await chromium.launch();
const tmp = join(out, '_sheet.html');
for (const [group, names] of Object.entries(GROUPS)) {
  for (const width of [1440, 1024, 390]) {
    for (const theme of ['light', 'dark']) {
      const [w, h] = CELL[width];
      const rows = names.filter((n) => existsSync(join(before, `${n}-${width}-${theme}.png`)) && existsSync(join(after, `${n}-${width}-${theme}.png`)));
      if (!rows.length) continue;
      const per = width === 390 ? 3 : 1; // narrow shots: three screens per row, each as a before/after pair
      const cells = rows.map((n) => `<figure><figcaption>${n}</figcaption><div class="pair"><div><span>Before</span><img src="${pathToFileURL(join(before, `${n}-${width}-${theme}.png`))}"></div><div><span>After</span><img src="${pathToFileURL(join(after, `${n}-${width}-${theme}.png`))}"></div></div></figure>`).join('');
      const dark = theme === 'dark';
      writeFileSync(tmp, `<!doctype html><meta charset=utf-8><style>
body{margin:0;padding:24px;background:${dark ? '#0c0c0f' : '#f1f1ef'};font:13px system-ui;color:${dark ? '#ddd' : '#333'}}
h1{font:600 18px system-ui;margin:0 0 16px}
.grid{display:grid;grid-template-columns:repeat(${per},auto);gap:20px 28px;justify-content:start}
figure{margin:0}figcaption{font-weight:600;margin-bottom:6px}
.pair{display:flex;gap:10px}.pair div{position:relative}
span{position:absolute;top:6px;left:6px;z-index:1;background:#000a;color:#fff;font-size:11px;padding:2px 6px;border-radius:4px}
img{display:block;width:${w}px;height:${h}px;object-fit:cover;object-position:top left;border-radius:6px;box-shadow:0 0 0 1px #8883}
</style><h1>${group} - ${width}px - ${theme}</h1><div class="grid">${cells}</div>`);
      const page = await browser.newPage({ viewport: { width: 400, height: 400 } });
      await page.goto(pathToFileURL(tmp).href);
      await page.waitForLoadState('load');
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(out, `before-after-${group}-${width}-${theme}.jpg`), type: 'jpeg', quality: 80, fullPage: true });
      await page.close();
    }
  }
}
rmSync(tmp, { force: true });
await browser.close();
