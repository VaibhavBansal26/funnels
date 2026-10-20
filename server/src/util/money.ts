/**
 * Money in minor units with the currency exponent (ISO 4217): 100 for USD, 1 for JPY, 1000 for KWD. Amounts are integers everywhere they are stored and
 * calculated; major-unit numbers exist only at the edges (page props, API convenience fields, display).
 */
const ZERO_DECIMAL = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
const THREE_DECIMAL = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);

export const currencyExponent = (currency: string): 0 | 2 | 3 => {
  const c = currency.toUpperCase();
  return ZERO_DECIMAL.has(c) ? 0 : THREE_DECIMAL.has(c) ? 3 : 2;
};

/** Currencies Stripe settles; `Intl` knows the ISO list, which is a superset we accept for the catalog. */
export const isCurrency = (code: string): boolean => {
  if (!/^[A-Z]{3}$/.test(code)) return false;
  try {
    return (Intl.supportedValuesOf('currency') as string[]).includes(code);
  } catch {
    return true;
  }
};

/** 12.34 USD -> 1234; 500 JPY -> 500; 1.5 KWD -> 1500. Decimal-string arithmetic, so 1.005 is 1.01 and never 1.00 through float error. */
export const toMinor = (major: number, currency: string): number => Math.round(Number(`${major}e${currencyExponent(currency)}`));
export const fromMinor = (minor: number, currency: string): number => Number(`${minor}e-${currencyExponent(currency)}`);

/** Stripe wants three-decimal amounts to be multiples of ten. */
export const validMinor = (minor: number, currency: string): boolean => Number.isSafeInteger(minor) && minor >= 0 && minor <= 99_999_999 && (currencyExponent(currency) !== 3 || minor % 10 === 0);

export function formatMinor(minor: number, currency: string, locale = 'en-US'): string {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(fromMinor(minor, currency));
  } catch {
    return `${fromMinor(minor, currency).toFixed(currencyExponent(currency))} ${currency}`;
  }
}

/** Splits `total` over `weights` so the parts add up exactly (largest remainder). Used to spread a discount over order lines. */
export function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0 || total <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum);
  const out = raw.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) {
    if (left <= 0) break;
    out[i]!++;
    left--;
  }
  return out;
}

/** The amount to send Stripe: three-decimal currencies must be multiples of ten, so a legacy page amount is rounded to the nearest ten. */
export const stripeAmount = (minor: number, currency: string): number => (currencyExponent(currency) === 3 ? Math.round(minor / 10) * 10 : minor);
