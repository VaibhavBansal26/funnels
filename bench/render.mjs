// Measures the CPU-heavy pure functions to decide whether a worker_threads pool would pay off. Run after `npm run build`.
import { performance } from 'node:perf_hooks';
const { renderPage, createBuilder, documentOf, sanitizeHtml, parseDocument } = await import(new URL('../server/dist/blocks/index.js', import.meta.url));
const b = createBuilder('x');
const blocks = Array.from({ length: 400 }, (_, i) => (i % 4 === 0 ? b.heading(`Heading ${i}`) : i % 4 === 1 ? b.paragraph('Lorem **ipsum** dolor sit amet, [link](https://example.com) consectetur. '.repeat(8)) : i % 4 === 2 ? b.list(['a', 'b', 'c', 'd']) : b.button('Go')));
const doc = documentOf(blocks);
const big = '<div class="a"><p onclick="x()">hello <b>world</b> <a href="https://e.com">l</a></p><script>1</script></div>'.repeat(450);
const time = (label, fn, n = 50) => { fn(); const t = []; for (let i = 0; i < n; i++) { const s = performance.now(); fn(); t.push(performance.now() - s); } t.sort((x, y) => x - y); console.log(`${label.padEnd(44)} median ${t[n >> 1].toFixed(2)} ms  p95 ${t[Math.floor(n * 0.95)].toFixed(2)} ms`); };
time('renderPage, 400 blocks (the hard limit)', () => renderPage(doc, { funnelId: 'f', stepId: 's', stepName: 'x' }));
time('parseDocument (zod), 400 blocks', () => parseDocument(doc));
time(`sanitizeHtml, ${(big.length / 1024).toFixed(0)} KB (the hard limit is 50 KB)`, () => sanitizeHtml(big));
const csv = Array.from({ length: 1000 }, (_, i) => [i, `user${i}@example.com`, 'Name', '=x']);
time('CSV: 1000-row page formatting', () => csv.map((r) => r.map((c) => String(c).replace(/"/g, '""')).join(',')).join('\r\n'));
