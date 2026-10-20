// Measures the CPU-heavy pure functions to decide whether a worker_threads pool would pay off. Run after `npm run build`.
import { performance } from 'node:perf_hooks';
const { createPageBuilder } = await import(new URL('../server/dist/pagemodel/shared/build.js', import.meta.url));
const { cleanProject } = await import(new URL('../server/dist/pagemodel/shared/clean.js', import.meta.url));
const { renderProject } = await import(new URL('../server/dist/pagemodel/render.js', import.meta.url));
const { sanitizeUserHtml } = await import(new URL('../server/dist/pagemodel/htmlfilter.js', import.meta.url));
const { sanitizeCss } = await import(new URL('../server/dist/pagemodel/cssfilter.js', import.meta.url));
const pm = createPageBuilder('x');
// ~2,700 components (the limit is 3,000): 48 sections of (heading, paragraph, list of 4, button) in one row each.
const sections = Array.from({ length: 48 }, (_, i) => pm.section([pm.stack([pm.heading(`Heading ${i}`), pm.text('Lorem **ipsum** dolor sit amet, [link](https://example.com) consectetur. '.repeat(4)), pm.list(['a', 'b', 'c', 'd']), pm.button('Go')])], { background: i % 2 ? '#0f172a' : undefined }));
const project = pm.project(sections);
const big = '<div class="a"><p onclick="x()">hello <b>world</b> <a href="https://e.com">l</a></p><script>1</script></div>'.repeat(450);
const css = '.a{color:red;background:url(https://e.com/a.png)} @media (max-width: 600px){.b{display:none}}'.repeat(150);
const time = (label, fn, n = 30) => { fn(); const t = []; for (let i = 0; i < n; i++) { const s = performance.now(); fn(); t.push(performance.now() - s); } t.sort((x, y) => x - y); console.log(`${label.padEnd(58)} median ${t[n >> 1].toFixed(2)} ms  p95 ${t[Math.floor(n * 0.95)].toFixed(2)} ms`); };
const ctx = { funnelId: 'f', stepId: 's', stepName: 'x' };
const nodes = JSON.stringify(project).split('"type"').length;
console.log(`project: ${(JSON.stringify(project).length / 1024).toFixed(0)} KB JSON, ~${nodes} components`);
time('cleanProject (allow-list rebuild + zod props)', () => cleanProject(project));
time('renderProject (clean + render + sanitize-html + css)', () => renderProject(project, ctx));
time(`sanitizeUserHtml, ${(big.length / 1024).toFixed(0)} KB (custom code limit is 50 KB)`, () => sanitizeUserHtml(big));
time(`sanitizeCss (postcss), ${(css.length / 1024).toFixed(0)} KB`, () => sanitizeCss(css));
const csv = Array.from({ length: 1000 }, (_, i) => [i, `user${i}@example.com`, 'Name', '=x']);
time('CSV: 1000-row page formatting', () => csv.map((r) => r.map((c) => String(c).replace(/"/g, '""')).join(',')).join('\r\n'));
