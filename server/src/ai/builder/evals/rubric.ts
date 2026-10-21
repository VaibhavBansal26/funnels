import { textOf, walk, wrapperOf } from '../../../pagemodel/shared/clean.js';
import { findViolations } from '../claims.js';
import type { PipelineOutput } from '../engine.js';
import { factsOf } from '../validate.js';
import type { GoldenBrief } from './briefs.js';

export interface RubricRow { id: string; pass: boolean; detail: string }

/**
 * Deterministic rubric for a finished run. It repeats the pipeline's own validation on purpose (an eval must not trust the thing it grades) and adds
 * checks against the golden brief: the conclusions drawn from it, no echo of injected or profane text, prices inside the author's range.
 */
export function grade(g: GoldenBrief, out: PipelineOutput): RubricRow[] {
  const rows: RubricRow[] = [];
  const add = (id: string, pass: boolean, detail = '') => rows.push({ id, pass, detail });
  const brief = out.state.brief!;
  const strategy = out.state.strategy!;
  const checks = out.report.checks;
  const failing = (id: string) => checks.filter((c) => c.id === id && c.status === 'fail');
  for (const id of ['structure', 'wiring', 'reachable', 'one-cta', 'contrast', 'lengths', 'claims', 'external-hosts', 'products', 'forms', 'fake-proof', 'alt-text'])
    add(id, failing(id).length === 0 && checks.some((c) => c.id === id), failing(id)[0]?.detail ?? '');
  add('report-ok', out.report.ok);
  add('assumptions-listed', brief.assumptions.length > 0 || !!g.structured, `${brief.assumptions.length} assumption(s)`);
  add('last-step-thank-you', strategy.steps.at(-1)?.kind === 'thankyou');

  // independent re-check of the documents
  let ctas = 0;
  const texts: string[] = [];
  for (const s of out.steps) {
    const f = factsOf(s.doc);
    texts.push(textOf(wrapperOf(s.doc.project)));
    ctas += f.forms.length;
    walk(wrapperOf(s.doc.project), (n) => { if (n.type === 'fn-code') add('no-custom-code', false, 'custom code in a generated page'); });
  }
  const all = texts.join('\n');
  add('no-banned-claims', findViolations(all, brief.regulated).length === 0, findViolations(all, brief.regulated)[0]?.rule ?? '');
  add('has-conversion-path', ctas > 0 || out.steps.some((s) => factsOf(s.doc).products.length > 0) || out.steps.length >= 2);
  add('plain-text-only', !/<[a-z][^>]*>|javascript:|onerror=/i.test(all));

  const x = g.expect;
  if (x.goal) add('goal', brief.goal === x.goal, `got ${brief.goal}, want ${x.goal}`);
  if (x.funnelType) add('funnel-type', strategy.funnelType === x.funnelType, `got ${strategy.funnelType}, want ${x.funnelType}`);
  if (x.industry) add('industry', brief.industry === x.industry, `got ${brief.industry}, want ${x.industry}`);
  if (x.regulated) add('regulated', brief.regulated === x.regulated, `got ${brief.regulated}, want ${x.regulated}`);
  if (x.language) add('language', brief.language === x.language, `got ${brief.language}, want ${x.language}`);
  if (x.injection !== undefined) add('injection-flagged', brief.injectionSuspected === x.injection);
  for (const bad of x.noEcho ?? []) add(`no-echo:${bad}`, !all.toLowerCase().includes(bad.toLowerCase()), `"${bad}" appears in the generated pages`);
  if (x.priceMax !== undefined) add('price-max', (out.state.plans ?? []).every((p) => p.amount <= x.priceMax!), `plans: ${(out.state.plans ?? []).map((p) => p.amount).join(',')}`);
  if (x.priceMin !== undefined) add('price-min', (out.state.plans ?? []).filter((p) => p.role === 'main').every((p) => p.amount >= x.priceMin!));
  return rows;
}

export function formatReport(results: { id: string; source: string; rows: RubricRow[] }[]): string {
  const lines: string[] = [];
  for (const r of results) {
    const failed = r.rows.filter((x) => !x.pass);
    lines.push(`${failed.length ? 'FAIL' : 'ok  '} ${r.id.padEnd(22)} source=${r.source.padEnd(9)} ${r.rows.length - failed.length}/${r.rows.length}${failed.length ? `  ${failed.map((f) => `${f.id}${f.detail ? ` (${f.detail})` : ''}`).join('; ')}` : ''}`);
  }
  return lines.join('\n');
}
