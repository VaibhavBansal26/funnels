// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { hashedUser, normalizeCountry, normalizeEmail, normalizeNamePart, normalizePhone, normalizeState, normalizeZip, sha256, splitName } from '../src/ads/hash.js';

describe('sha256', () => {
  it('matches known vectors (UTF-8, lower-case hex)', () => {
    expect(sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256('ada@example.com')).toBe('b5fc85e55755f9e0d030a10ab4429b6b2944855f9a0d60077fe832becbc41d72');
    expect(sha256('14155552671')).toBe('758fbf68945f21c416814c539ab578876c8d98fb69e6da692def92cd52417fe0');
    expect(sha256('+14155552671')).toBe('cb6880e416769253645cb9c6b8989154bf66a56a77fc14c81fb1019663cbb928');
    expect(sha256('josé')).toBe('d994e1d001886fe5b45b1267bd1fa2b752ac50742579bd3dad7b2a2aa0ed6866');
  });
});

describe('email normalisation', () => {
  const table: [string, string, string | null][] = [
    ['  Ada@Example.COM ', 'meta', 'ada@example.com'],
    ['ada.lovelace+promo@gmail.com', 'meta', 'ada.lovelace+promo@gmail.com'],
    ['Ada.Lovelace+promo@Gmail.com', 'ga4', 'adalovelace+promo@gmail.com'],
    ['a.b.c@googlemail.com', 'ga4', 'abc@gmail.com'],
    ['a.b.c@googlemail.com', 'tiktok', 'a.b.c@googlemail.com'],
    ['first.last@corp.example', 'ga4', 'first.last@corp.example'],
    ['ÅSA@Example.se', 'meta', 'åsa@example.se'],
    ['no-at-sign', 'meta', null],
    ['@example.com', 'meta', null],
    ['ada@', 'meta', null],
    ['a b@example.com', 'meta', null],
    ['', 'meta', null],
  ];
  it.each(table)('%j for %s -> %j', (raw, network, want) => expect(normalizeEmail(raw, network as 'meta')).toBe(want));
  it('null and undefined', () => {
    expect(normalizeEmail(null, 'meta')).toBeNull();
    expect(normalizeEmail(undefined, 'ga4')).toBeNull();
  });
});

describe('phone normalisation (E.164 digits)', () => {
  const table: [string, string | undefined, string | null][] = [
    ['+1 (415) 555-2671', undefined, '14155552671'],
    ['+44 20 7946 0958', undefined, '442079460958'],
    ['0044 20 7946 0958', undefined, '442079460958'],
    ['(415) 555-2671', '1', '14155552671'],
    ['020 7946 0958', '44', '442079460958'],
    ['14155552671', '1', '14155552671'],
    ['4155552671', undefined, null],
    ['+0415555', undefined, null],
    ['12345', '1', null],
    ['call me', undefined, null],
    ['+1 415 555 2671 ext 5', undefined, null],
    ['+49 (0) 30 1234567', undefined, '49301234567'],
    ['+٣٣ ١ ٢٣', undefined, null],
    ['', undefined, null],
  ];
  it.each(table)('%j (default %s) -> %j', (raw, cc, want) => expect(normalizePhone(raw, cc)).toBe(want));
});

describe('names, zip, country, state', () => {
  it('names keep letters of any script and drop punctuation, spaces and digits', () => {
    expect(normalizeNamePart("  O'Brien-Smith ")).toBe('obriensmith');
    expect(normalizeNamePart('José')).toBe('josé');
    expect(normalizeNamePart('Zoë 3')).toBe('zoë');
    expect(normalizeNamePart('李')).toBe('李');
    expect(normalizeNamePart('Café')).toBe('café'); // NFC
    expect(normalizeNamePart('!!!')).toBeNull();
    expect(normalizeNamePart(null)).toBeNull();
  });
  it('splits a full name', () => {
    expect(splitName(' Ada  Augusta King ')).toEqual({ first: 'Ada', last: 'Augusta King' });
    expect(splitName('Cher')).toEqual({ first: 'Cher', last: null });
    expect(splitName('')).toEqual({ first: null, last: null });
  });
  it('zip codes', () => {
    expect(normalizeZip('94107-1234', 'us')).toBe('94107');
    expect(normalizeZip('M1 1AE', 'gb')).toBe('m11ae');
    expect(normalizeZip('K1A 0B1', 'ca')).toBe('k1a0b1');
    expect(normalizeZip('ab', 'us')).toBeNull();
    expect(normalizeZip('12!45', 'de')).toBeNull();
  });
  it('country and state', () => {
    expect(normalizeCountry(' US ')).toBe('us');
    expect(normalizeCountry('USA')).toBeNull();
    expect(normalizeState('New York.')).toBe('newyork');
    expect(normalizeState('CA')).toBe('ca');
  });
});

describe('hashedUser per network', () => {
  const u = { email: ' Ada.Lovelace@Gmail.com ', phone: '+44 20 7946 0958', name: 'Ada King', zip: 'EC1A 1BB', country: 'GB', externalId: 'vis_123' };
  it('meta: hashed em, ph (digits), fn, ln, zp, country, external_id', () => {
    expect(hashedUser(u, 'meta')).toEqual({
      em: sha256('ada.lovelace@gmail.com'), ph: sha256('442079460958'), fn: sha256('ada'), ln: sha256('king'), zp: sha256('ec1a1bb'), country: sha256('gb'), external_id: sha256('vis_123'),
    });
  });
  it('tiktok: email, +E.164 phone, external id only', () => {
    expect(hashedUser(u, 'tiktok')).toEqual({ email: sha256('ada.lovelace@gmail.com'), phone_number: sha256('+442079460958'), external_id: sha256('vis_123') });
  });
  it('ga4: gmail dots removed before hashing, postal code and country in clear', () => {
    expect(hashedUser(u, 'ga4')).toEqual({
      sha256_email_address: sha256('adalovelace@gmail.com'), sha256_phone_number: sha256('+442079460958'), sha256_first_name: sha256('ada'), sha256_last_name: sha256('king'), postal_code: 'ec1a1bb', country: 'GB',
    });
  });
  it('omits what cannot be normalised instead of sending garbage', () => {
    expect(hashedUser({ email: 'nope', phone: '12', name: '' }, 'meta')).toEqual({});
  });
  it('never contains a raw identifier', () => {
    const json = JSON.stringify([hashedUser(u, 'meta'), hashedUser(u, 'tiktok')]);
    expect(json).not.toContain('Lovelace');
    expect(json).not.toContain('2079460958');
  });
});
