import type { FunnelCopy, Insights } from './schemas.js';
import type { AiProvider, AltTextInput, GenerateFunnelInput, HeadlineInput, InsightInput, RewriteInput, StepKind, Tone } from './types.js';

/** Deterministic, offline copy generation. Also the fallback whenever a model call fails or returns invalid output. */

const CTA: Record<Tone, string> = { persuasive: 'Yes, count me in', concise: 'Get started', friendly: 'Count me in!', formal: 'Request access' };

const firstSentence = (s: string, max = 70): string => {
  const one = s.split(/[.!?\n]/)[0]!.trim() || s.trim();
  return (one.length > max ? one.slice(0, max).replace(/\s+\S*$/, '') : one) || 'your business';
};

export function heuristicFunnelCopy(i: GenerateFunnelInput): FunnelCopy {
  const what = firstSentence(i.business);
  const who = i.audience.trim() ? firstSentence(i.audience, 60) : 'people like you';
  const cta = CTA[i.tone];
  const bullets = [`Built for ${who}`, `Clear, practical steps you can use today`, `No jargon, no fluff`];
  const byKind: Record<StepKind, { headline: string; subheadline: string; bullets: string[]; cta: string }> = {
    optin: { headline: `Get the free guide to ${what}`, subheadline: `Made for ${who}. Enter your email and we will send it right away.`, bullets, cta },
    registration: { headline: `Join the free live session: ${what}`, subheadline: `A practical walkthrough for ${who}. Save your seat now.`, bullets, cta: i.tone === 'concise' ? 'Save my seat' : 'Reserve my seat' },
    story: { headline: `Why ${what} works`, subheadline: `Here is what ${who} tell us matters most.`, bullets, cta: 'Continue' },
    sales: { headline: `${what}: the complete solution`, subheadline: `Everything ${who} need in one place.`, bullets: [...bullets, 'Backed by clear support'], cta: i.tone === 'concise' ? 'Buy now' : 'Get instant access' },
    upsell: { headline: 'Wait! Add this to your order', subheadline: `A one-time offer for ${who}: get even more from your purchase.`, bullets: ['Add it with one click', 'No need to re-enter your details'], cta: 'Yes, add it' },
    booking: { headline: `Book a free call about ${what}`, subheadline: `Talk to us about your goals. It is quick, and there is no obligation.`, bullets: ['Personal recommendations', 'Answers to your questions', 'Zero pressure'], cta: 'Book my call' },
    thankyou: { headline: 'Thank you! You are all set', subheadline: `Check your inbox for the next steps. We are glad to have you, ${who}.`, bullets: [], cta: 'Continue' },
  };
  return { name: cut(`${firstSentence(i.business, 50)} funnel`, 80), steps: i.stepKinds.map((k) => byKind[k]) };
}

const cut = (s: string, max: number) => (s.length > max ? s.slice(0, max).trim() : s);

const FILLER = /\b(very|really|just|actually|basically|simply|literally|quite)\s+/gi;
const CONTRACTIONS: [RegExp, string][] = [[/\bdon't\b/gi, 'do not'], [/\bcan't\b/gi, 'cannot'], [/\bwon't\b/gi, 'will not'], [/\bit's\b/gi, 'it is'], [/\bwe're\b/gi, 'we are'], [/\byou're\b/gi, 'you are'], [/\bI'm\b/g, 'I am']];

const sentences = (t: string): string[] => t.match(/[^.!?]+[.!?]*/g)?.map((s) => s.trim()).filter(Boolean) ?? [t];

export function heuristicRewrite(i: RewriteInput): string {
  let out = i.text.replace(/\s+/g, ' ').trim();
  switch (i.tone) {
    case 'concise':
      out = out.replace(FILLER, '');
      break;
    case 'formal':
      for (const [re, to] of CONTRACTIONS) out = out.replace(re, to);
      out = out.replace(/!+/g, '.');
      break;
    case 'friendly':
      out = /^(hey|hi|hello)\b/i.test(out) ? out : `Hey there, ${out.charAt(0).toLowerCase()}${out.slice(1)}`;
      out = out.replace(/\.$/, '!');
      break;
    case 'persuasive':
      out = /(today|now)[.!]?$/i.test(out) ? out : `${out.replace(/[.!]*$/, '.')} Start today.`;
      break;
  }
  const parts = sentences(out);
  if (i.length === 'shorter' && parts.length > 1) out = parts.slice(0, Math.ceil(parts.length / 2)).join(' ');
  if (i.length === 'longer') out = `${out} That is what makes the difference.`;
  return out || i.text;
}

export function heuristicHeadlines(i: HeadlineInput): string[] {
  const t = firstSentence(i.topic, 80).replace(/[.!?]+$/, '');
  const who = i.audience?.trim() ? firstSentence(i.audience, 50) : null;
  const sets: Record<Tone, string[]> = {
    persuasive: [`Finally: ${t} that actually works`, `Stop guessing. Start ${t.charAt(0).toLowerCase()}${t.slice(1)}`, `The proven way to ${t.charAt(0).toLowerCase()}${t.slice(1)}`, who ? `${who}: this is how you ${t.charAt(0).toLowerCase()}${t.slice(1)}` : `Why most people fail at ${t.charAt(0).toLowerCase()}${t.slice(1)} (and how to win)`, `Your fastest path to ${t.charAt(0).toLowerCase()}${t.slice(1)}`],
    concise: [t, `${t}, simplified`, `${t} in 3 steps`, `Do this: ${t}`, `${t}. Done right.`],
    friendly: [`Let's ${t.charAt(0).toLowerCase()}${t.slice(1)} together`, `Ready to ${t.charAt(0).toLowerCase()}${t.slice(1)}? We've got you`, `${t}: easier than you think`, who ? `Hey ${who}, here's how to ${t.charAt(0).toLowerCase()}${t.slice(1)}` : `Here's a friendly guide to ${t.charAt(0).toLowerCase()}${t.slice(1)}`, `Your simple plan to ${t.charAt(0).toLowerCase()}${t.slice(1)}`],
    formal: [`A professional guide to ${t.charAt(0).toLowerCase()}${t.slice(1)}`, `${t}: a structured approach`, `Principles of ${t.charAt(0).toLowerCase()}${t.slice(1)}`, `Best practices for ${t.charAt(0).toLowerCase()}${t.slice(1)}`, `${t}: what you need to know`],
  };
  return sets[i.tone].map((h) => cut(h, 140));
}

export function heuristicAltText(i: AltTextInput): string {
  const file = i.src.split(/[?#]/)[0]!.split('/').pop() ?? '';
  const words = file.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[-_+]+/g, ' ').replace(/\d{3,}/g, '').trim();
  const base = words && !/^(image|img|photo|screenshot|dsc)\s*\d*$/i.test(words) ? words.charAt(0).toUpperCase() + words.slice(1) : 'Image';
  const ctx = i.context?.trim() ? ` for ${firstSentence(i.context, 60).toLowerCase()}` : '';
  return cut(`${base}${ctx}`, 125);
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

export function heuristicInsights(i: InsightInput): Insights {
  const weakest = i.steps.find((s) => s.stepId === i.weakestStepId);
  const t = i.totals;
  if (t.views === 0) {
    return {
      summary: `"${i.funnelName}" has no recorded visits between ${i.range.from} and ${i.range.to}, so there is nothing to analyse yet.`,
      actions: [
        { title: 'Publish the funnel', detail: 'Connect a verified domain and set the funnel live so visitors can reach it.' },
        { title: 'Send some traffic', detail: 'Share the link in an email or social post to collect your first visits.' },
        { title: 'Check the tracking', detail: 'Open the live page once and confirm a page view appears in the analytics tab.' },
      ],
    };
  }
  const where = weakest ? `The weakest step is "${weakest.name}"${weakest.dropOffPercent !== null ? `, where ${fmt(weakest.dropOffPercent)}% of the previous step's visitors do not continue` : ''}.` : 'There is not enough step-level data to name a weakest step yet.';
  return {
    summary: `Between ${i.range.from} and ${i.range.to}, "${i.funnelName}" had ${t.views} page views from ${t.uniqueVisitors} unique visitors, ${t.optIns} opt-ins (${fmt(t.optInRate)}%) and ${t.orders} orders (${fmt(t.gross)} gross). ${where}`,
    actions: [
      { title: 'Rewrite the headline', detail: `Test a clearer promise on ${weakest ? `"${weakest.name}"` : 'the first step'}: lead with the single biggest benefit for your audience.` },
      { title: 'Cut friction', detail: 'Remove optional form fields and anything that competes with the main button on the weakest page.' },
      { title: 'Add proof near the button', detail: 'Place a testimonial, guarantee or short FAQ next to the call to action to answer the last objection.' },
    ],
  };
}

export class HeuristicProvider implements AiProvider {
  readonly name = 'heuristic';
  funnelCopy = async (i: GenerateFunnelInput) => heuristicFunnelCopy(i);
  rewrite = async (i: RewriteInput) => ({ text: heuristicRewrite(i) });
  headlines = async (i: HeadlineInput) => ({ headlines: heuristicHeadlines(i) });
  insights = async (i: InsightInput) => heuristicInsights(i);
  altText = async (i: AltTextInput) => ({ alt: heuristicAltText(i) });
}
