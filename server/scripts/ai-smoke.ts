/**
 * Real-model smoke test of the AI funnel builder. NOT run in CI and never exercised by the authors of this change: it needs your own key.
 *
 *   ANTHROPIC_API_KEY=sk-ant-... npx tsx scripts/ai-smoke.ts [--model claude-sonnet-5-5]
 *
 * It runs three briefs through the same pipeline the app uses (no database, nothing is saved), grades each result with the deterministic rubric of the
 * offline evals and prints a report with token use. The key is read from the environment only and is never printed or sent anywhere but the Anthropic API.
 * Status of the real-model path: verified with fakes only (test/ai.evals.test.ts, test/ai.builder.test.ts, test/ai.edit.test.ts).
 */
import { AnthropicProvider } from '../src/ai/anthropic.js';
import { runPipeline } from '../src/ai/builder/engine.js';
import { GOLDEN } from '../src/ai/builder/evals/briefs.js';
import { formatReport, grade } from '../src/ai/builder/evals/rubric.js';
import { BuildOptions } from '../src/ai/builder/types.js';

const key = process.env.ANTHROPIC_API_KEY;
if (!key) {
  console.log('ANTHROPIC_API_KEY is not set. Nothing was run. Set it to your own key to smoke-test the real model; the offline evals do not need it.');
  process.exit(0);
}
const argModel = process.argv.indexOf('--model');
const model = (argModel > 0 ? process.argv[argModel + 1] : undefined) ?? process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5-5';
const provider = new AnthropicProvider({ apiKey: key, model, timeoutMs: 90_000 });
const ids = ['bakery', 'saas-trial', 'regulated-health'];
const results: { id: string; source: string; rows: ReturnType<typeof grade> }[] = [];
let tokens = 0;
for (const id of ids) {
  const g = GOLDEN.find((x) => x.id === id)!;
  const started = Date.now();
  try {
    const out = await runPipeline(
      { prompt: g.prompt, structured: g.structured, options: BuildOptions.parse({ products: 'none', ...g.options }) },
      { llm: provider.llm, limits: { inputTokens: 6000, outputTokens: 16_000, maxRepairs: 2 }, catalog: [] },
    );
    tokens += out.usage.inputTokens + out.usage.outputTokens;
    results.push({ id, source: out.source, rows: grade(g, out) });
    console.log(`${id}: ${out.usage.calls} calls, ${out.usage.inputTokens} in / ${out.usage.outputTokens} out tokens, ${((Date.now() - started) / 1000).toFixed(1)}s, fallbacks: ${out.state.fallbacks.map((f) => `${f.stage} (${f.reason})`).join('; ') || 'none'}`);
  } catch (e) {
    console.log(`${id}: the run failed: ${(e as Error).message}`);
    results.push({ id, source: 'error', rows: [{ id: 'run', pass: false, detail: (e as Error).message }] });
  }
}
console.log(`\nModel ${model}\n${formatReport(results)}\nTotal tokens: ${tokens}`);
process.exit(results.some((r) => r.rows.some((x) => !x.pass)) ? 1 : 0);
