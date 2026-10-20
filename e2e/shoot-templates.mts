// Developer tool: renders built-in templates to PNG screenshots for design review (not part of the app or the tests).
// Usage (from server/): npx tsx ../e2e/shoot-templates.mts <outDir> [slug ...]   (screenshots at 1280 and 390 pixels wide, one PNG per step)
import { mkdirSync } from 'node:fs';
import { renderProject } from '../server/src/pagemodel/render.js';
import { SEED_TEMPLATES } from '../server/src/templates/seed.js';

import { chromium } from 'playwright';

const [out, ...slugs] = process.argv.slice(2);
if (!out) throw new Error('usage: shoot-templates.ts <outDir> [slug ...]');
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
for (const t of SEED_TEMPLATES.filter((x) => !slugs.length || slugs.includes(x.slug))) {
  for (const [i, s] of t.steps.entries()) {
    const { html } = renderProject(s.doc.project, { funnelId: 'f', stepId: `s${i}`, stepName: s.name, mode: 'preview', steps: t.steps.map((x, j) => ({ id: `s${j}`, href: x.path })) });
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.setContent(html, { waitUntil: 'load' });
      await page.screenshot({ path: `${out}/${t.slug}-${i + 1}-${width}.png`, fullPage: true });
      await page.close();
    }
  }
}
await browser.close();
