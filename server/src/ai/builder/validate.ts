import { normalizeDoc, type ProjectDoc } from '../../pagemodel/doc.js';
import { textOf, walk, wrapperOf, type GjsNode } from '../../pagemodel/shared/clean.js';
import type { ButtonActionProps, FormProps, ProductProps } from '../../pagemodel/shared/props.js';
import { auditContrast } from '../../templates/contrast.js';
import { findViolations, ungroundedNumbers, usedAvoided } from './claims.js';
import type { AssembledStep } from './assemble.js';
import type { Brief, Check, ProductPlan, StepCopy, Strategy, ValidationReport } from './types.js';

interface Facts {
  buttons: { node: GjsNode; action: ButtonActionProps; variant: string; text: string }[];
  forms: { node: GjsNode; props: FormProps; id: string }[];
  products: { node: GjsNode; props: ProductProps; id: string }[];
  ids: Set<string>;
  text: string;
}

export function factsOf(doc: ProjectDoc): Facts {
  const f: Facts = { buttons: [], forms: [], products: [], ids: new Set(), text: '' };
  walk(wrapperOf(doc.project), (n) => {
    const id = (n.attributes as Record<string, string> | undefined)?.id;
    if (id) f.ids.add(id);
    if (n.type === 'fn-button') f.buttons.push({ node: n, action: (n.fnAction as ButtonActionProps) ?? { type: 'none' }, variant: ((n.classes as string[]) ?? []).find((c) => c.startsWith('fn-btn-') && !['fn-btn-lg', 'fn-btn-sm', 'fn-btn-block'].includes(c))?.slice(7) ?? 'primary', text: textOf(n) });
    if (n.type === 'fn-form') f.forms.push({ node: n, props: n.fnForm as FormProps, id: id ?? '' });
    if (n.type === 'fn-checkout') f.products.push({ node: n, props: n.fnProduct as ProductProps, id: id ?? '' });
  });
  f.text = textOf(wrapperOf(doc.project));
  return f;
}

export interface ValidateInput { brief: Brief; strategy: Strategy; steps: AssembledStep[]; copies: StepCopy[]; plans: ProductPlan[]; productMode: 'none' | 'create' | 'existing' }

/** The rubric. Each check is deterministic and runs on the assembled documents, so it holds whichever writer (model or built-in) produced the copy. */
export function validateFunnel(v: ValidateInput): ValidationReport {
  const checks: Check[] = [];
  const add = (id: string, ok: boolean, detail: string, step?: string, warn = false) => checks.push({ id, status: ok ? 'pass' : warn ? 'warn' : 'fail', detail, ...(step ? { step } : {}) });
  const paths = new Set(v.steps.map((s) => s.base_path));
  const facts = v.steps.map((s) => factsOf(s.doc));
  const grounding = [v.brief.business, v.brief.offer, v.brief.audience, ...v.brief.constraints, v.brief.priceMin ?? '', v.brief.priceMax ?? '', ...v.plans.map((p) => p.amount)].join('\n');

  v.steps.forEach((s, i) => {
    const f = facts[i]!;
    const last = i === v.steps.length - 1;
    const re = normalizeDoc(s.doc, { scriptsOk: false });
    add('structure', re.ok && f.text.length > 0, re.ok ? 'valid page document' : `invalid: ${re.ok ? '' : re.issues[0]?.message}`, s.key);

    // wiring
    const bad: string[] = [];
    for (const b of f.buttons) {
      const a = b.action;
      if (a.type === 'next_step' && last) bad.push(`"${b.text}" goes to a next step that does not exist`);
      else if (a.type === 'step' && !paths.has(a.stepId)) bad.push(`"${b.text}" goes to an unknown step`);
      else if (a.type === 'anchor' && !f.ids.has(a.anchor)) bad.push(`"${b.text}" scrolls to a missing section #${a.anchor}`);
      else if (a.type === 'link' && !/^(\/|#|mailto:|tel:)/.test(a.url)) bad.push(`"${b.text}" links to an external address`);
      else if (a.type === 'none' || a.type === 'popup') bad.push(`"${b.text}" does nothing`);
    }
    for (const fm of f.forms) if (fm.props.success.type === 'next_step' && last) bad.push(`form "${fm.props.name}" continues to a step that does not exist`);
    for (const p of f.products) if (p.props.success.type === 'next_step' && last) bad.push(`checkout "${p.props.productName}" continues to a step that does not exist`);
    add('wiring', bad.length === 0, bad.length ? bad.join('; ') : 'every button, form and checkout leads somewhere real', s.key);

    // forms
    const formBad = f.forms.filter((fm) => !fm.props.fields.some((x) => x.type === 'email'));
    add('forms', formBad.length === 0 && (s.kind === 'thankyou' || v.copies[i]!.form === null || f.forms.length === 1), formBad.length ? 'a form has no email field' : `${f.forms.length} form(s), each with an email field`, s.key);

    // checkout wired to products
    const planSlots = new Set(v.plans.map((p) => p.slot));
    const unbound = f.products.filter((p) => !p.props.slot || !planSlots.has(p.props.slot));
    const overCap = f.products.filter((p) => !p.props.productId && v.brief.priceMax !== null && p.props.price > v.brief.priceMax);
    add('products', unbound.length === 0 && overCap.length === 0 && (v.productMode !== 'none' || f.products.length === 0), unbound.length ? 'a checkout is not tied to a product slot' : overCap.length ? 'a price is above the maximum you gave' : f.products.length ? `${f.products.length} checkout block(s) bound to products` : 'no checkout on this page', s.key);

    // one clear CTA
    const keys = new Set<string>();
    for (const b of f.buttons) {
      if (b.variant === 'outline' || b.variant === 'ghost') continue;
      const a = b.action;
      keys.add(a.type === 'anchor' ? (a.anchor === 'offer' ? 'checkout' : f.forms.length ? 'form' : 'next:') : a.type === 'next_step' || a.type === 'step' ? `next:${a.type === 'step' ? a.stepId : ''}` : a.type);
    }
    if (f.forms.length) keys.add('form');
    if (f.products.some((p) => !p.props.orderBump)) keys.add('checkout');
    const expected = s.kind === 'thankyou' ? keys.size <= 1 : keys.size === 1;
    add('one-cta', expected, expected ? 'one clear call to action' : `${keys.size} competing calls to action (${[...keys].join(', ')})`, s.key);

    // contrast
    const issues = auditContrast(s.doc.project);
    add('contrast', issues.length === 0, issues.length ? `${issues.length} contrast problem(s), e.g. ${issues[0]!.where} ${issues[0]!.ratio}:1` : 'text meets WCAG AA', s.key);

    // length limits and external hosts
    const long = f.buttons.filter((b) => b.text.length > 40).length + (v.copies[i]!.headline.length > 100 ? 1 : 0);
    add('lengths', long === 0, long ? 'a headline or button is too long' : 'within length limits', s.key);
    add('external-hosts', !/https?:\/\/|\/\/[a-z0-9.-]+\.[a-z]{2,}/i.test(JSON.stringify(s.doc.project)), 'no external hosts in the page', s.key);

    // claims
    const copyText = `${f.text}`;
    const viol = findViolations(copyText, v.brief.regulated);
    const nums = ungroundedNumbers(copyText, grounding);
    const avoided = usedAvoided(copyText, v.brief.avoid);
    add('claims', viol.length === 0 && nums.length === 0 && avoided.length === 0, [...viol.map((x) => x.rule), ...nums.map((n) => `unsupported number ${n}`), ...avoided.map((w) => `avoided word "${w}"`)].join('; ') || 'no banned claims, invented numbers or avoided words', s.key);
    add('fake-proof', !/[“"][^”"]{25,}[”"]\s*[—–-]\s*[A-Z]/.test(copyText), 'no attributed quotes', s.key);

    const pl = (copyText.match(/\[[^\]]{4,}\]/g) ?? []).length;
    add('placeholders', pl === 0, pl ? `${pl} placeholder(s) in [brackets] to replace before launch` : 'no placeholders', s.key, true);
    const art = JSON.stringify(s.doc.project).includes('"role":"img"') || s.kind === 'thankyou' || s.kind === 'upsell' || s.kind === 'downsell';
    add('alt-text', art, 'illustrations have a text alternative', s.key);
  });

  // funnel level: reachability
  const reach = new Set([0]);
  const queue = [0];
  while (queue.length) {
    const i = queue.shift()!;
    const f = facts[i]!;
    const outs = new Set<number>();
    const goNext = () => i + 1 < v.steps.length && outs.add(i + 1);
    for (const b of f.buttons) {
      if (b.action.type === 'next_step') goNext();
      if (b.action.type === 'step') { const t = v.steps.findIndex((s) => s.base_path === (b.action as { stepId: string }).stepId); if (t >= 0) outs.add(t); }
    }
    for (const fm of f.forms) if (fm.props.success.type === 'next_step') goNext();
    for (const p of f.products) if (p.props.success.type === 'next_step') goNext();
    for (const o of outs) if (!reach.has(o)) { reach.add(o); queue.push(o); }
  }
  const unreachable = v.steps.filter((_, i) => !reach.has(i)).map((s) => s.name);
  add('reachable', unreachable.length === 0, unreachable.length ? `not reachable from the first step: ${unreachable.join(', ')}` : 'every step is reachable from the first');
  add('step-count', v.steps.length >= 1 && v.steps.length <= 6 && v.steps[v.steps.length - 1]!.kind === 'thankyou', 'ends with a thank-you page');
  return { ok: !checks.some((c) => c.status === 'fail'), checks, repairs: [] };
}

/** Deterministic repairs for wiring problems; returns the (possibly changed) steps and what was changed. */
export function repairWiring(steps: AssembledStep[]): { steps: AssembledStep[]; repairs: string[] } {
  const repairs: string[] = [];
  const paths = new Set(steps.map((s) => s.base_path));
  const out = steps.map((s, i) => {
    const doc = structuredClone(s.doc);
    const last = i === steps.length - 1;
    const ids = factsOf(doc).ids;
    let changed = false;
    walk(wrapperOf(doc.project), (n) => {
      const a = n.fnAction as ButtonActionProps | undefined;
      if (n.type === 'fn-button' && a) {
        if ((a.type === 'next_step' && last) || (a.type === 'step' && !paths.has(a.stepId)) || (a.type === 'anchor' && !ids.has(a.anchor)) || (a.type === 'link' && !/^(\/|#|mailto:|tel:)/.test(a.url))) {
          n.fnAction = last ? { type: 'anchor', anchor: ids.has('top') ? 'top' : [...ids][0] ?? 'top' } : { type: 'next_step' };
          if (last && !ids.has('top') && ![...ids].length) n.fnAction = { type: 'none' };
          changed = true;
          repairs.push(`${s.name}: re-pointed a broken button`);
        }
      }
      for (const k of ['fnForm', 'fnProduct'] as const) {
        const p = n[k] as { success?: { type: string; message?: string } } | undefined;
        if (last && p?.success?.type === 'next_step') { p.success = { type: 'message', message: 'Thank you. We have received your request.' }; changed = true; repairs.push(`${s.name}: a final-step form or checkout showed a message instead of a missing next step`); }
      }
    });
    if (!changed) return s;
    const r = normalizeDoc({ version: 2, project: doc.project }, { scriptsOk: false });
    return r.ok ? { ...s, doc: r.doc } : s;
  });
  return { steps: out, repairs };
}
