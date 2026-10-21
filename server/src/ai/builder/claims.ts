import type { Regulated } from './types.js';

/**
 * Compliance guard for generated copy. It cannot make claims true; it refuses the kinds of claim a funnel writer must not invent: guarantees, rankings,
 * endorsements, press mentions, customer counts, statistics, and, for regulated topics, health, income and legal outcomes. Used on model output (violations
 * trigger a repair retry, then the built-in writer) and as a rubric check in the golden-prompt evals.
 */
const GENERAL: [RegExp, string][] = [
  [/\b(100\s?%|fully|completely)\s+(guaranteed|risk[- ]free)\b/i, 'absolute guarantee'],
  [/\bguaranteed?\s+(results?|success|income|returns?|profits?|weight loss|approval|outcome)\b/i, 'guaranteed result'],
  [/\brisk[- ]free\b|\bno[- ]risk\b/i, 'risk-free claim'],
  [/(^|\W)#\s?1\b|\bnumber (one|1)\b|\bbest (in the world|ever|on the market)\b|\btop[- ]rated\b|\bworld'?s (best|leading|#1)\b/i, 'ranking claim'],
  [/\bas seen (on|in)\b|\bfeatured (on|in)\b|\bendorsed by\b|\brecommended by (doctors|experts|dentists)\b/i, 'press or endorsement claim'],
  [/\b(thousands|millions|hundreds) of (happy |satisfied )?(customers|clients|people|users|families)\b/i, 'customer count'],
  [/\bjoin (over |more than )?[\d,]+\+?\s+(customers|clients|people|members|users|others)\b/i, 'customer count'],
  [/\baward[- ]winning\b|\bvoted (best|#1)\b/i, 'award claim'],
  [/\b(scientifically|clinically|medically) proven\b|\bstudies show\b|\bresearch shows\b/i, 'unsupported evidence claim'],
  [/\bget rich\b|\bovernight (success|results)\b|\bwork from (home|anywhere) and earn\b/i, 'income hype'],
  [/\bonly \d+ (spots?|seats?|left|remaining)\b|\bjust \d+ left\b/i, 'invented scarcity'],
  [/\b(5|five)[- ]stars?\b|\b\d(\.\d)?\s?\/\s?5\b|\b\d(\.\d)?\s?stars?\b/i, 'rating claim'],
];

const REGULATED_RULES: Record<Exclude<Regulated, 'none'>, [RegExp, string][]> = {
  health: [
    [/\b(cure|cures|cured|heal|heals|reverse|reverses|eliminate|eliminates)\b/i, 'health cure claim'],
    [/\b(treat|treats|prevent|prevents)\s+(cancer|diabetes|depression|anxiety|arthritis|disease|infection|covid)/i, 'treatment claim'],
    [/\blose\s+\d+\s*(lbs?|pounds?|kg|kilos?)\b|\bmiracle\b|\bdetox\b/i, 'weight or miracle claim'],
    [/\bpain[- ]free\b|\bno side effects\b|\bFDA[- ]approved\b/i, 'safety claim'],
  ],
  finance: [
    [/\b(double|triple|10x) your (money|investment)\b|\bguaranteed (returns?|profits?)\b|\bpassive income\b|\bfinancial freedom\b/i, 'return or income claim'],
    [/\b(beat|outperform) the market\b|\bno[- ]loss\b|\bcan'?t lose\b/i, 'performance claim'],
    [/\b\d+(\.\d+)?\s?%\s+(return|returns|yield|apy|interest)\b/i, 'rate claim'],
  ],
  legal: [
    [/\bwin (your|every) case\b|\bguaranteed (outcome|settlement|win)\b|\byou will (win|get compensation)\b/i, 'outcome claim'],
    [/\bbest (lawyer|attorney)s?\b/i, 'ranking claim'],
  ],
};

export interface Violation { rule: string; excerpt: string }

export function findViolations(text: string, regulated: Regulated = 'none'): Violation[] {
  const out: Violation[] = [];
  const rules = [...GENERAL, ...(regulated === 'none' ? [] : REGULATED_RULES[regulated])];
  for (const [re, rule] of rules) {
    const m = re.exec(text);
    if (m) out.push({ rule, excerpt: m[0].trim().slice(0, 60) });
  }
  return out;
}

const numbersIn = (s: string): string[] => (s.replace(/(\d),(\d{3})/g, '$1$2').match(/\d+(?:\.\d+)?/g) ?? []);

/**
 * Numbers in generated copy must come from the author. Small counts (up to 10, as in "3 steps") are allowed unless attached to a percent sign, a plus
 * sign or a "years"/"customers" noun; anything else must appear in `source` (the brief, the prices and the author's constraints).
 */
export function ungroundedNumbers(text: string, source: string): string[] {
  const known = new Set(numbersIn(source));
  const bad: string[] = [];
  for (const m of text.replace(/(\d),(\d{3})/g, '$1$2').matchAll(/(\d+(?:\.\d+)?)(\s?(?:%|\+|percent|years?|yrs?|customers|clients|reviews|members))?/gi)) {
    const n = m[1]!;
    if (known.has(n)) continue;
    const small = Number(n) <= 10 && !m[2];
    if (!small) bad.push(m[0].trim());
  }
  return bad;
}

/** Words the author asked to avoid, matched as whole words (case-insensitive). */
export function usedAvoided(text: string, avoid: string[]): string[] {
  return avoid.filter((w) => w.trim() && new RegExp(`(^|[^\\p{L}])${w.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}])`, 'iu').test(text));
}
