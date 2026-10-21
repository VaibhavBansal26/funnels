import { createHash } from 'node:crypto';

/**
 * Normalisation and SHA-256 hashing of customer data for the ad networks' server-side APIs. Every network hashes the same way (UTF-8, lowercase hex) but
 * normalises differently BEFORE hashing, and a value normalised wrongly simply never matches (no error). The rules, and where they come from:
 *  - Meta: https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/customer-information-parameters
 *  - Google (GA4 Measurement Protocol user_data / enhanced conversions): https://support.google.com/google-ads/answer/13262500
 *  - TikTok: https://business-api.tiktok.com/portal/docs?id=1771101027431425 (SHA-256 of the lower-cased, trimmed value; phone in E.164)
 * Raw values never leave this module unhashed except where a network requires it (IP address, user agent, fbp, fbc, ttclid).
 */
export const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

export type Network = 'meta' | 'ga4' | 'tiktok';

const collapse = (s: string) => s.normalize('NFC').trim();

/** Email: trim, lower-case. Google additionally drops dots in the local part of gmail.com / googlemail.com addresses. Plus-tags are kept (no network documents removing them). */
export function normalizeEmail(raw: string | null | undefined, network: Network): string | null {
  if (!raw) return null;
  const s = collapse(raw).toLowerCase();
  const at = s.lastIndexOf('@');
  if (at < 1 || at === s.length - 1 || /\s/.test(s)) return null;
  if (network === 'ga4') {
    const [local, domain] = [s.slice(0, at), s.slice(at + 1)];
    if (domain === 'gmail.com' || domain === 'googlemail.com') return `${local.replace(/\./g, '')}@gmail.com`;
  }
  return s;
}

/**
 * Phone to E.164 digits. `+` or `00` mark an international number; a number without either is accepted only when `defaultCallingCode` (digits, no +) is given and the
 * national number starts with the trunk prefix 0 or is otherwise plausibly national (7 to 11 digits): the trunk 0 is dropped and the code prepended. Anything else is
 * refused (null) rather than guessed, because a wrong number matches a stranger. Result has 8 to 15 digits (E.164 maximum).
 */
export function normalizePhone(raw: string | null | undefined, defaultCallingCode?: string): string | null {
  if (!raw) return null;
  const s = collapse(raw);
  if (!/^[0-9+()\-.\s/]+$/.test(s)) return null;
  // "+49 (0) 30 ...": the (0) is the national trunk prefix, which is not part of the international number.
  const digits = (s.startsWith('+') ? s.replace(/\(0\)/, '') : s).replace(/\D/g, '');
  let e164: string;
  if (s.startsWith('+')) e164 = digits;
  else if (digits.startsWith('00')) e164 = digits.slice(2);
  else if (defaultCallingCode && /^\d{1,3}$/.test(defaultCallingCode)) {
    const national = digits.replace(/^0+/, '');
    if (national.length < 6 || national.length > 12) return null;
    e164 = digits.startsWith(defaultCallingCode) && digits.length > 10 ? digits : defaultCallingCode + national;
  } else return null;
  e164 = e164.replace(/^0+/, '');
  return /^[1-9]\d{7,14}$/.test(e164) ? e164 : null;
}

/** Name parts and city: lower-case letters (any script) and digits-free; punctuation, spaces and symbols removed. Unicode letters are kept (UTF-8 hashed). */
export function normalizeNamePart(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = collapse(raw).toLowerCase().replace(/[^\p{L}\p{M}]/gu, '');
  return s || null;
}

export function normalizeCountry(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim().toLowerCase();
  return /^[a-z]{2}$/.test(s) ? s : null;
}

/** ZIP: lower-case, no spaces or dashes; US codes are cut to the first five digits. */
export function normalizeZip(raw: string | null | undefined, country?: string | null): string | null {
  if (!raw) return null;
  const s = collapse(raw).toLowerCase().replace(/[\s-]/g, '');
  if (!/^[a-z0-9]{3,10}$/.test(s)) return null;
  if ((country ?? '').toLowerCase() === 'us' || (/^\d{9}$/.test(s) && !country)) return s.replace(/\D/g, '').slice(0, 5) || null;
  return s;
}

export function normalizeState(raw: string | null | undefined): string | null {
  const s = (raw ?? '').normalize('NFC').trim().toLowerCase().replace(/[^\p{L}\p{M}]/gu, '');
  return s || null;
}

/** Splits "Ada Lovelace King" into first name and the rest (last name). A single word is a first name only. */
export function splitName(full: string | null | undefined): { first: string | null; last: string | null } {
  const parts = collapse(full ?? '').split(/\s+/).filter(Boolean);
  if (!parts.length) return { first: null, last: null };
  return { first: parts[0]!, last: parts.length > 1 ? parts.slice(1).join(' ') : null };
}

export const hashed = (v: string | null): string | undefined => (v ? sha256(v) : undefined);

export interface RawUser {
  email?: string | null;
  phone?: string | null;
  name?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  country?: string | null;
  /** The funnel's visitor id: hashed and sent as external_id. */
  externalId?: string | null;
  defaultCallingCode?: string;
}

/** Hashed, normalised identifiers per network. Fields that cannot be normalised are omitted. */
export function hashedUser(u: RawUser, network: Network): Record<string, string | undefined> {
  const { first, last } = splitName(u.name);
  const country = normalizeCountry(u.country);
  const email = hashed(normalizeEmail(u.email, network));
  const phone = normalizePhone(u.phone, u.defaultCallingCode);
  const out: Record<string, string | undefined> =
    network === 'meta'
      ? {
          em: email,
          ph: hashed(phone),
          fn: hashed(normalizeNamePart(first)),
          ln: hashed(normalizeNamePart(last)),
          ct: hashed(normalizeNamePart(u.city)),
          st: hashed(normalizeState(u.state)),
          zp: hashed(normalizeZip(u.zip, country)),
          country: hashed(country),
          external_id: hashed(u.externalId ?? null),
        }
      : network === 'tiktok'
        ? { email, phone_number: hashed(phone ? `+${phone}` : null), external_id: hashed(u.externalId ?? null) }
        : {
            sha256_email_address: email,
            sha256_phone_number: hashed(phone ? `+${phone}` : null),
            sha256_first_name: hashed(normalizeNamePart(first)),
            sha256_last_name: hashed(normalizeNamePart(last)),
            // Google's address block hashes only the name parts; postal code and country go in clear (https://developers.google.com/analytics/devguides/collection/protocol/ga4/user-data)
            postal_code: normalizeZip(u.zip, country) ?? undefined,
            country: country ? country.toUpperCase() : undefined,
          };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}
