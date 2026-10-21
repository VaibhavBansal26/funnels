/**
 * Strict formats of the identifiers a pixel snippet is generated from. Snippets are built by the server from these values only (never from pasted script text), so
 * a value that does not match is refused when it is saved AND skipped again when a page is rendered. Each pattern is anchored and has no characters that could end a
 * JavaScript string or an HTML attribute (letters, digits and a few separators).
 */
export const ID_FORMATS = {
  /** Meta Pixel / dataset id: digits only, 8 to 20 of them (real ones have 15 or 16). */
  metaPixel: /^\d{8,20}$/,
  /** Google Analytics 4 measurement id: G- plus 6 to 12 capitals/digits. */
  ga4: /^G-[A-Z0-9]{6,12}$/,
  /** Google Ads conversion id (the AW- tag id). */
  googleAds: /^AW-\d{6,12}$/,
  /** Google Ads conversion label: the part after the slash in `send_to`. */
  googleAdsLabel: /^[A-Za-z0-9_-]{6,40}$/,
  /** TikTok pixel code, for example CABCDEF1234567890ABC. */
  tiktok: /^[A-Z0-9]{10,30}$/,
  /** LinkedIn Insight partner id (digits). */
  linkedinPartner: /^\d{5,10}$/,
  /** LinkedIn conversion id (digits). */
  linkedinConversion: /^\d{4,12}$/,
  /** Microsoft Advertising UET tag id (digits). */
  uet: /^\d{6,12}$/,
} as const;

export type IdKind = keyof typeof ID_FORMATS;

export const isId = (kind: IdKind, v: unknown): v is string => typeof v === 'string' && ID_FORMATS[kind].test(v);

export const ID_HINTS: Record<IdKind, string> = {
  metaPixel: 'the Meta Pixel ID: 8 to 20 digits, for example 123456789012345',
  ga4: 'a GA4 measurement ID such as G-ABC123XYZ9',
  googleAds: 'a Google Ads conversion ID such as AW-123456789',
  googleAdsLabel: 'a Google Ads conversion label (letters, digits, - and _)',
  tiktok: 'a TikTok pixel code in capitals and digits, for example CABCDEF1234567890ABC',
  linkedinPartner: 'a LinkedIn partner ID (digits)',
  linkedinConversion: 'a LinkedIn conversion ID (digits)',
  uet: 'a Microsoft Advertising UET tag ID (digits)',
};
