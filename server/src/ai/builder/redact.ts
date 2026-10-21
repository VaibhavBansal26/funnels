/**
 * Safety helpers for text that goes into prompts or comes out of the model.
 * - `redactPii` removes personal data from a brief when the author asks for it.
 * - `detectInjection` flags briefs that try to instruct the model (the text is still treated as data; the flag lands in the audit record and the report).
 * - `plainOut` makes model text safe for the page: no markup, no links, no control characters.
 */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE = /(?<![\w.])\+?\d[\d ()./-]{7,}\d(?![\w])/g;
const CARD = /\b(?:\d[ -]?){13,19}\b/g;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
const IBAN = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g;

export function redactPii(text: string): { text: string; count: number } {
  let count = 0;
  const sub = (re: RegExp, label: string) => (text = text.replace(re, () => (count++, `[${label}]`)));
  sub(EMAIL, 'email');
  sub(CARD, 'number');
  sub(SSN, 'id');
  sub(IBAN, 'account');
  sub(PHONE, 'phone');
  return { text, count };
}

const INJECTION = [
  /ignore (all |any )?(the )?(previous|prior|above|earlier) (instructions|rules|prompts?)/i,
  /disregard (all |any )?(the )?(previous|prior|above|system)/i,
  /(reveal|print|show|repeat|leak) (me )?(your |the )?(system )?(prompt|instructions|rules)/i,
  /you are now\b/i,
  /\bsystem prompt\b/i,
  /<\/?(untrusted_input|system|assistant)\b/i,
  /\bnew instructions?:/i,
  /\bjailbreak\b|\bDAN mode\b/i,
  /respond (only )?with (json|the following)/i,
];
export const detectInjection = (text: string): boolean => INJECTION.some((re) => re.test(text));

/** Control characters out, tags and links out, whitespace collapsed. Model text is plain text; the renderer escapes it again. */
export function plainOut(value: unknown, max: number): string {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/g, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/\b(?:https?:)?\/\/\S+/gi, '')
    .replace(/\bwww\.\S+/gi, '')
    .replace(/[`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
}
