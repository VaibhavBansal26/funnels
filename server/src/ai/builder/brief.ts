import { z } from 'zod';
import { cleanText } from '../prompts.js';
import { detectInjection, plainOut, redactPii } from './redact.js';
import { TEMPLATE_GOALS, VOICES, REGULATED, type Brief, type Regulated, type StructuredBriefInput, type TemplateGoal, type Voice } from './types.js';

/** Industry slugs the template library uses; the brief maps free text onto one of them (or "general"). */
export const INDUSTRIES = ['general', 'food', 'dental', 'fitness', 'real-estate', 'home-services', 'saas', 'education', 'coaching', 'ecommerce', 'nonprofit', 'events', 'agency', 'media'] as const;

const INDUSTRY_WORDS: [string, RegExp][] = [
  ['food', /\b(bakery|baker|cafe|café|coffee|restaurant|catering|pastr(y|ies)|cake|bread|pizza|bistro|food truck)\b/i],
  ['dental', /\b(dentist|dental|orthodont\w*|teeth|whitening)\b/i],
  ['fitness', /\b(gym|fitness|personal train\w*|yoga|pilates|crossfit|workout)\b/i],
  ['real-estate', /\b(real estate|realtor|property|properties|home buyers?|house hunting|listings?)\b/i],
  ['home-services', /\b(plumb\w*|electrician|roofing|hvac|cleaning service|landscap\w*|handyman|pest control)\b/i],
  ['saas', /\b(saas|software|app\b|platform|dashboard|free trial|api|startup tool)\b/i],
  ['education', /\b(course|curriculum|lessons?|e-?learning|academy|tutor\w*|class(es)?|certification|masterclass)\b/i],
  ['coaching', /\b(coach\w*|mentor\w*|consult\w*|therapist|counsel\w*)\b/i],
  ['ecommerce', /\b(e-?commerce|online store|shop|product line|candles?|jewel\w*|apparel|merch|handmade|skincare)\b/i],
  ['nonprofit', /\b(non-?profit|charity|donat\w*|fundrais\w*|foundation|volunteer\w*)\b/i],
  ['events', /\b(event|conference|summit|festival|meetup|tickets?|workshop)\b/i],
  ['agency', /\b(agency|b2b|marketing services|design studio|web design|seo services)\b/i],
  ['media', /\b(newsletter|podcast|blog|magazine|publication)\b/i],
];

const GOAL_WORDS: [TemplateGoal, RegExp][] = [
  ['webinar', /\b(webinar|live (session|training|class)|masterclass|workshop registration)\b/i],
  ['donations', /\b(donat\w*|fundrais\w*|charity|non-?profit)\b/i],
  ['events', /\b(tickets?|conference|summit|festival|event registration)\b/i],
  ['booking', /\b(book(ing)?|appointment|consultation|schedule a|discovery call|demo|reserve|call with)\b/i],
  ['sales', /\b(sell|selling|buy|purchase|order|checkout|price|pricing|shop|course|ebook|e-book|subscription|membership|product)\b|[$€£]\s?\d/i],
  ['leads', /\b(lead|leads|free guide|checklist|newsletter|waitlist|sign ?up|opt-?in|subscribers?|email list|download)\b/i],
  ['engagement', /\b(quiz|survey|giveaway|contest|download our app)\b/i],
];

const TONE_WORDS: [Voice, RegExp][] = [
  ['playful', /\b(playful|fun|quirky|witty|cheeky|lighthearted)\b/i],
  ['formal', /\b(formal|professional|corporate|serious)\b/i],
  ['authoritative', /\b(authoritative|expert|premium|luxury|high-end)\b/i],
  ['concise', /\b(concise|short|punchy|minimal|direct)\b/i],
  ['friendly', /\b(friendly|warm|welcoming|casual|approachable|neighbou?rly)\b/i],
  ['persuasive', /\b(persuasive|urgent|bold|high-converting)\b/i],
];

const REGULATED_WORDS: [Regulated, RegExp][] = [
  ['health', /\b(clinic|medical|doctor|dental|dentist|therapy|therapist|supplement\w*|weight loss|diet|health|wellness treatment|physio\w*|medic\w*|skin condition|pain)\b/i],
  ['finance', /\b(invest\w*|loan|mortgage|trading|crypto\w*|insurance|forex|stocks?|retirement|wealth|financial advis\w*|credit)\b/i],
  ['legal', /\b(lawyer|attorney|law firm|legal advice|immigration|litigation|solicitor)\b/i],
];

const SYMBOL: Record<string, string> = { $: 'USD', '€': 'EUR', '£': 'GBP', '₹': 'INR', '¥': 'JPY' };
const money = (s: string) => Number(s.replace(/,/g, ''));

export function seedOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Small deterministic generator (mulberry32): the offline builder picks phrase variants with it, so one brief always yields the same funnel. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function detectLanguage(text: string): string {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (!letters.length) return 'en';
  const nonLatin = letters.filter((c) => !/\p{Script=Latin}/u.test(c)).length;
  if (nonLatin / letters.length > 0.3) {
    if (/\p{Script=Han}/u.test(text)) return 'zh';
    if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return 'ja';
    if (/\p{Script=Hangul}/u.test(text)) return 'ko';
    if (/\p{Script=Cyrillic}/u.test(text)) return 'ru';
    if (/\p{Script=Arabic}/u.test(text)) return 'ar';
    if (/\p{Script=Hebrew}/u.test(text)) return 'he';
    if (/\p{Script=Devanagari}/u.test(text)) return 'hi';
    return 'other';
  }
  const w = ` ${text.toLowerCase()} `;
  const count = (words: string[]) => words.filter((x) => w.includes(` ${x} `)).length;
  const scores: [string, number][] = [
    ['es', count(['el', 'la', 'los', 'las', 'para', 'con', 'una', 'nuestro', 'y', 'de'])],
    ['fr', count(['le', 'les', 'des', 'pour', 'avec', 'une', 'notre', 'et', 'du'])],
    ['de', count(['der', 'die', 'das', 'und', 'für', 'mit', 'ein', 'eine', 'unser'])],
    ['pt', count(['os', 'as', 'uma', 'para', 'com', 'nosso', 'não'])],
    ['en', count(['the', 'and', 'for', 'with', 'our', 'we', 'you', 'to', 'of', 'a'])],
  ];
  const best = scores.sort((a, b) => b[1] - a[1])[0]!;
  return best[1] >= 2 && best[0] !== 'en' && best[1] > scores.find((s) => s[0] === 'en')![1] ? best[0] : 'en';
}

export const LANGUAGE_NAMES: Record<string, string> = { en: 'English', es: 'Spanish', fr: 'French', de: 'German', pt: 'Portuguese', zh: 'Chinese', ja: 'Japanese', ko: 'Korean', ru: 'Russian', ar: 'Arabic', he: 'Hebrew', hi: 'Hindi', other: 'the language of the brief' };

function firstSentence(text: string, max: number): string {
  const one = text.split(/(?<=[.!?])\s|\n/)[0]!.trim();
  return (one.length > max ? one.slice(0, max).replace(/\s+\S*$/, '') : one).replace(/[.!?]+$/, '');
}

export interface PreparedInput { prompt: string; redactions: number; injectionSuspected: boolean }

/** Cleans the free text (length cap, control characters) and, when asked, removes personal data. The original is never stored when redaction is on. */
export function prepareInput(prompt: string, structured: StructuredBriefInput | undefined, redact: boolean): PreparedInput {
  let text = cleanText(prompt, 4000);
  const extra = structured ? Object.values(structured).flat().filter((v): v is string => typeof v === 'string').join('\n') : '';
  const injectionSuspected = detectInjection(`${text}\n${extra}`);
  let redactions = 0;
  if (redact) {
    const r = redactPii(text);
    text = r.text;
    redactions = r.count;
  }
  return { prompt: text, redactions, injectionSuspected };
}

/** Deterministic brief: keyword rules and regular expressions. Always available, and the base the model's answer is checked against. */
export function heuristicBrief(prompt: string, s: StructuredBriefInput = {}, injectionSuspected = false): Brief {
  const assumptions: string[] = [];
  const text = prompt.trim();
  const all = `${text}\n${s.business ?? ''}\n${s.offer ?? ''}\n${s.audience ?? ''}`;
  const empty = !text && !s.business && !s.offer;

  const business = cleanText(s.business ?? firstSentence(text, 160), 200) || 'your business';
  if (!s.business && !text) assumptions.push('No description was given, so the page is written for a generic business. Add details and regenerate for better copy.');

  const goalHit = GOAL_WORDS.find(([, re]) => re.test(all))?.[0];
  const goal: TemplateGoal = s.goal ?? goalHit ?? 'leads';
  if (!s.goal && !goalHit) assumptions.push('No clear goal was stated, so the funnel collects leads (email sign-ups).');
  else if (!s.goal) assumptions.push(`The goal was read as "${goal}" from your description.`);

  const industry = INDUSTRY_WORDS.find(([, re]) => re.test(all))?.[0] ?? 'general';

  const toneHit = TONE_WORDS.find(([, re]) => re.test(all))?.[0];
  const tone: Voice = s.tone ?? toneHit ?? (industry === 'food' || industry === 'fitness' || industry === 'ecommerce' ? 'friendly' : industry === 'dental' || industry === 'agency' ? 'formal' : 'persuasive');
  if (!s.tone && !toneHit) assumptions.push(`No tone was given, so the voice is ${tone}.`);

  let currency = s.currency ?? '';
  const prices: number[] = [];
  let priceMin: number | null = s.priceMin ?? null;
  let priceMax: number | null = s.priceMax ?? null;
  const sym = /([$€£₹¥])\s?(\d[\d,]*(?:\.\d{1,2})?)|(\d[\d,]*(?:\.\d{1,2})?)\s?(USD|EUR|GBP|INR|dollars?|euros?|pounds?)/gi;
  for (const m of all.matchAll(sym)) {
    const amount = money(m[2] ?? m[3]!);
    if (Number.isFinite(amount) && amount > 0 && amount <= 1_000_000) prices.push(amount);
    if (!currency) currency = m[1] ? SYMBOL[m[1]]! : /eur/i.test(m[4]!) ? 'EUR' : /gbp|pound/i.test(m[4]!) ? 'GBP' : /inr/i.test(m[4]!) ? 'INR' : 'USD';
  }
  if (priceMin === null && priceMax === null && prices.length) {
    const under = /\b(under|below|less than|max(?:imum)?|at most|up to|no more than)\s*[$€£₹]?\s?\d/i.test(all);
    const over = /\b(from|at least|min(?:imum)?|starting at|over|above)\s*[$€£₹]?\s?\d/i.test(all);
    if (prices.length >= 2) [priceMin, priceMax] = [Math.min(...prices), Math.max(...prices)];
    else if (under) priceMax = prices[0]!;
    else if (over) priceMin = prices[0]!;
    else [priceMin, priceMax] = [prices[0]!, prices[0]!];
  }
  if (priceMin !== null && priceMax !== null && priceMin > priceMax) [priceMin, priceMax] = [priceMax, priceMin];
  if (!currency) currency = 'USD';
  if (!s.currency && prices.length === 0 && (goal === 'sales' || goal === 'events' || goal === 'donations')) assumptions.push('No price was given, so suggested prices use typical amounts in USD. Change them in the product catalog.');

  const regulated: Regulated = REGULATED_WORDS.find(([, re]) => re.test(all))?.[0] ?? 'none';
  if (regulated !== 'none') assumptions.push(`This looks like a ${regulated} topic, so the copy avoids cure, return, income and outcome claims.`);

  let audience = cleanText(s.audience ?? '', 300);
  if (!audience) {
    const m = /\bfor ((?:busy |local |small |new |first[- ]time )?[\p{L}][\p{L}\s'-]{2,70}?)(?:[.,;:!?\n]|\bwho\b|\bthat\b|$)/iu.exec(all);
    audience = m ? m[1]!.trim() : '';
    if (!audience) assumptions.push('No audience was given, so the copy speaks to "people like you".');
  }

  let offer = cleanText(s.offer ?? '', 300);
  if (!offer) {
    const sentence = all.split(/(?<=[.!?])\s+|\n/).find((x) => /\b(sell|offer|free|course|plan|package|trial|ebook|guide|workshop|program|class|service|consultation|membership|tickets?)\b/i.test(x));
    offer = sentence ? firstSentence(sentence, 200) : '';
  }
  if (!offer) assumptions.push('No specific offer was named, so the pages describe a placeholder offer. Replace it with your real one; nothing here claims you already sell something.');

  const constraints = [...(s.constraints ?? [])];
  for (const line of text.split(/\n|(?<=[.!?])\s+/)) if (/^(must|never|do not|don't|avoid|no )\b/i.test(line.trim())) constraints.push(cleanText(line, 200));
  const avoid = [...(s.avoid ?? [])];
  const av = /\bavoid(?:ing)?\s+(?:the (?:words?|terms?)\s+)?["“']?([\p{L}][\p{L}\s,'"“”-]{1,80})/iu.exec(text);
  if (av) avoid.push(...av[1]!.split(/,|\band\b/).map((x) => x.replace(/["“”']/g, '').trim()).filter((x) => x.length > 1 && x.length < 30));

  const language = s.language ?? detectLanguage(all);
  if (language !== 'en') assumptions.push(`The brief looks like ${LANGUAGE_NAMES[language] ?? language}. ${language === 'en' ? '' : 'The built-in writer only writes English; a model writes in the brief\'s language.'}`.trim());
  if (empty) assumptions.push('The description is empty; defaults were used for everything.');
  if (injectionSuspected) assumptions.push('Parts of your description looked like instructions to the AI. They were treated as plain text about your business and ignored as instructions.');

  return {
    business, offer, audience, tone, goal, industry, currency, priceMin, priceMax,
    constraints: [...new Set(constraints)].slice(0, 10), avoid: [...new Set(avoid)].slice(0, 20), mustInclude: (s.mustInclude ?? []).slice(0, 10),
    language, regulated, assumptions, injectionSuspected,
  };
}

/** The shape asked of the model for the "understanding" stage. */
export const BriefModelSchema = z.object({
  business: z.string().trim().min(1).max(200),
  offer: z.string().trim().max(300).default(''),
  audience: z.string().trim().max(300).default(''),
  tone: z.enum(VOICES).default('persuasive'),
  goal: z.enum(TEMPLATE_GOALS),
  industry: z.string().trim().max(40).default('general'),
  currency: z.string().regex(/^[A-Z]{3}$/).default('USD'),
  priceMin: z.number().min(0).max(1_000_000).nullable().default(null),
  priceMax: z.number().min(0).max(1_000_000).nullable().default(null),
  constraints: z.array(z.string().trim().max(200)).max(10).default([]),
  avoid: z.array(z.string().trim().max(40)).max(20).default([]),
  language: z.string().trim().max(10).default('en'),
  regulated: z.enum(REGULATED).default('none'),
  assumptions: z.array(z.string().trim().max(240)).max(12).default([]),
});

/** Semantic check of the model's brief against the text: prices must come from the author, never be invented. */
export function briefProblems(m: z.infer<typeof BriefModelSchema>, source: string): string[] {
  const out: string[] = [];
  const nums = new Set((source.replace(/(\d),(\d{3})/g, '$1$2').match(/\d+(?:\.\d+)?/g) ?? []).map(Number));
  for (const [k, v] of [['priceMin', m.priceMin], ['priceMax', m.priceMax]] as const) if (v !== null && !nums.has(v)) out.push(`${k} ${v} does not appear in the brief; use null when the author gave no price`);
  if (m.priceMin !== null && m.priceMax !== null && m.priceMin > m.priceMax) out.push('priceMin is greater than priceMax');
  return out;
}

/** Model answer + structured fields + heuristic facts: structured wins, then the model, then the heuristic. Everything is cleaned to plain text. */
export function mergeBrief(model: z.infer<typeof BriefModelSchema> | null, base: Brief, s: StructuredBriefInput = {}): Brief {
  if (!model) return base;
  const industry = (INDUSTRIES as readonly string[]).includes(model.industry) ? model.industry : base.industry;
  const regulatedRank = (r: Regulated) => REGULATED.indexOf(r);
  // A topic the rules recognised as regulated stays regulated even when the model says otherwise (the stricter reading wins).
  const regulated = regulatedRank(base.regulated) > regulatedRank(model.regulated) ? base.regulated : model.regulated;
  const clean = (v: string, max: number) => plainOut(v, max);
  return {
    ...base,
    business: s.business ? base.business : clean(model.business, 200) || base.business,
    offer: s.offer ? base.offer : clean(model.offer, 300) || base.offer,
    audience: s.audience ? base.audience : clean(model.audience, 300) || base.audience,
    tone: s.tone ?? model.tone,
    goal: s.goal ?? model.goal,
    industry,
    currency: s.currency ?? model.currency,
    priceMin: s.priceMin ?? model.priceMin ?? base.priceMin,
    priceMax: s.priceMax ?? model.priceMax ?? base.priceMax,
    constraints: [...new Set([...base.constraints, ...model.constraints.map((x) => clean(x, 200))])].slice(0, 10),
    avoid: [...new Set([...base.avoid, ...model.avoid.map((x) => clean(x, 40))])].filter(Boolean).slice(0, 20),
    language: s.language ?? model.language ?? base.language,
    regulated,
    assumptions: [...new Set([...base.assumptions, ...model.assumptions.map((x) => clean(x, 240))])].filter(Boolean).slice(0, 14),
  };
}
