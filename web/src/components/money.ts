/** Currencies offered in pickers: the common ones, including a zero-decimal (JPY, KRW) and a three-decimal (KWD) one. The server accepts any ISO 4217 code. */
export const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'NZD', 'CHF', 'SEK', 'NOK', 'DKK', 'JPY', 'KRW', 'INR', 'BRL', 'MXN', 'SGD', 'HKD', 'AED', 'KWD'] as const;
export const INTERVALS = [{ value: 'day', label: 'Daily' }, { value: 'week', label: 'Weekly' }, { value: 'month', label: 'Monthly' }, { value: 'year', label: 'Yearly' }] as const;

const ZERO = new Set(['JPY', 'KRW']);
const THREE = new Set(['KWD', 'BHD', 'JOD', 'OMR', 'TND']);
export const exponentOf = (currency: string): 0 | 2 | 3 => (ZERO.has(currency) ? 0 : THREE.has(currency) ? 3 : 2);

/** Parses what a person typed into a price field ("12", "12.5", "1,299.00") for `currency`; null when it is not a valid amount with at most the currency's decimals. */
export function parseAmount(text: string, currency: string): number | null {
  const t = text.trim().replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const [, frac = ''] = t.split('.');
  if (frac.length > exponentOf(currency)) return null;
  const n = Number(t);
  return n >= 0 && n <= 1_000_000 ? n : null;
}

export function amountHint(currency: string): string {
  const e = exponentOf(currency);
  return e === 0 ? `${currency} has no decimals` : `Up to ${e} decimals`;
}
