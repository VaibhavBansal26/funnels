/**
 * Marketing touches: pure functions (no I/O) that turn untrusted query-string and cookie values into a bounded, sanitised touch and decide which touch is the
 * visitor's first and last. Everything here treats its input as hostile: values come from URLs anyone can craft.
 */
export const CLICK_ID_KEYS = ['gclid', 'fbclid', 'ttclid', 'msclkid', 'li_fat_id'] as const;
export type ClickIdKey = (typeof CLICK_ID_KEYS)[number];

export interface Touch {
  source?: string;
  medium?: string;
  campaign?: string;
  content?: string;
  term?: string;
  clickIds?: Partial<Record<ClickIdKey, string>>;
  /** Host of an external referrer (never the full URL). */
  referrer?: string;
  /** Path of the landing page without query or fragment. */
  landing?: string;
  /** True when source and medium were derived from a click id or a referrer rather than UTM parameters. */
  inferred?: boolean;
  /** ISO instant the touch happened. */
  at: string;
}

const MAX_UTM = 100;
// Control characters, zero-width and bidirectional formatting characters: invisible, and a way to make one value look like another in a report.
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
const CLICK_ID = /^[A-Za-z0-9_.\-=*~:]{4,200}$/;

export function cleanText(v: unknown, max = MAX_UTM): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.normalize('NFC').replace(/\s+/g, ' ').replace(INVISIBLE, '').trim().slice(0, max);
  return s || undefined;
}

const INFER: Record<ClickIdKey, { source: string; medium: string }> = {
  gclid: { source: 'google', medium: 'cpc' },
  fbclid: { source: 'facebook', medium: 'paid_social' },
  ttclid: { source: 'tiktok', medium: 'paid_social' },
  msclkid: { source: 'bing', medium: 'cpc' },
  li_fat_id: { source: 'linkedin', medium: 'paid_social' },
};

const HOST = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;

export interface RawTouch {
  utm_source?: unknown;
  utm_medium?: unknown;
  utm_campaign?: unknown;
  utm_content?: unknown;
  utm_term?: unknown;
  // some senders use the short names of the existing `utms` object
  source?: unknown;
  medium?: unknown;
  campaign?: unknown;
  content?: unknown;
  term?: unknown;
  clickIds?: unknown;
  referrer?: unknown;
  landing?: unknown;
}

/** Sanitises an incoming touch. Returns null when it carries no marketing information at all (a direct visit). `selfHost` is the page's own host: a referrer from it is internal navigation. */
export function sanitizeTouch(raw: unknown, now: Date, selfHost?: string): Touch | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as RawTouch;
  const t: Touch = { at: now.toISOString() };
  const lower = (v: unknown) => cleanText(v)?.toLowerCase();
  t.source = lower(r.utm_source ?? r.source);
  t.medium = lower(r.utm_medium ?? r.medium);
  t.campaign = cleanText(r.utm_campaign ?? r.campaign);
  t.content = cleanText(r.utm_content ?? r.content);
  t.term = cleanText(r.utm_term ?? r.term);
  const ids: Partial<Record<ClickIdKey, string>> = {};
  const given = typeof r.clickIds === 'object' && r.clickIds !== null ? (r.clickIds as Record<string, unknown>) : {};
  for (const k of CLICK_ID_KEYS) {
    const v = given[k];
    if (typeof v === 'string' && CLICK_ID.test(v)) ids[k] = v;
  }
  if (Object.keys(ids).length) t.clickIds = ids;
  if (typeof r.referrer === 'string') {
    const h = r.referrer.trim().toLowerCase().replace(/^www\./, '');
    if (HOST.test(h) && h !== (selfHost ?? '').replace(/^www\./, '').toLowerCase()) t.referrer = h;
  }
  if (typeof r.landing === 'string') {
    const p = r.landing.split(/[?#]/)[0]!.replace(INVISIBLE, '');
    if (p.startsWith('/') && p.length <= 200) t.landing = p;
  }
  if (!t.source && !t.medium) {
    const firstId = CLICK_ID_KEYS.find((k) => ids[k]);
    if (firstId) {
      t.source = INFER[firstId].source;
      t.medium = INFER[firstId].medium;
      t.inferred = true;
    } else if (t.referrer && !t.campaign) {
      t.source = t.referrer;
      t.medium = 'referral';
      t.inferred = true;
    }
  }
  return hasInfo(t) ? t : null;
}

export const hasInfo = (t: Touch | null | undefined): t is Touch => !!t && !!(t.source || t.medium || t.campaign || t.content || t.term || t.clickIds);

export interface TouchPair {
  first: Touch | null;
  last: Touch | null;
}

/**
 * First touch = the earliest touch that carries marketing information; last touch = the latest one. A direct visit (no information) never replaces either: it
 * is not a campaign touch, and "last non-direct click" is the usual rule. A touch that arrives late (older than the stored one) can still become the first touch
 * but never regresses the last.
 */
export function mergeTouch(prev: TouchPair, incoming: Touch | null): TouchPair & { changed: boolean } {
  if (!hasInfo(incoming)) return { ...prev, changed: false };
  let first = prev.first;
  let last = prev.last;
  if (!first || incoming.at < first.at) first = incoming;
  if (!last || incoming.at >= last.at) last = incoming;
  return { first, last, changed: first !== prev.first || last !== prev.last };
}

/** Flat columns for reports. A missing touch is `(direct)`-less: nulls are reported as direct / none. */
export function flat(t: Touch | null, p: 'first' | 'last'): Record<string, string | null> {
  return { [`${p}_source`]: t?.source ?? null, [`${p}_medium`]: t?.medium ?? null, [`${p}_campaign`]: t?.campaign ?? null, [`${p}_content`]: t?.content ?? null, [`${p}_term`]: t?.term ?? null };
}

// Browser identifiers that server-side conversions send back to the networks. Each has a documented shape; anything else is dropped.
const FBP = /^fb\.[0-2]\.\d{10,13}\.\d{4,20}$/;
const FBC = /^fb\.[0-2]\.\d{10,13}\.[A-Za-z0-9_-]{4,400}$/;
const TTP = /^[A-Za-z0-9._-]{8,120}$/;
const GA_CLIENT = /^\d{4,12}\.\d{4,12}$/;
const GA_SESSION = /^\d{1,12}$/;

export interface BrowserIds {
  fbp?: string;
  fbc?: string;
  ttp?: string;
  gaClientId?: string;
  gaSessionId?: string;
  /** What the visitor chose in the consent banner: granted, denied, unknown (banner shown, no choice yet) or na (no consent banner on the page). */
  consent?: 'granted' | 'denied' | 'unknown' | 'na';
}

export function sanitizeBrowserIds(raw: unknown): BrowserIds {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const out: BrowserIds = {};
  const pick = (re: RegExp, v: unknown) => (typeof v === 'string' && re.test(v) ? v : undefined);
  const fbp = pick(FBP, r.fbp);
  if (fbp) out.fbp = fbp;
  const fbc = pick(FBC, r.fbc);
  if (fbc) out.fbc = fbc;
  const ttp = pick(TTP, r.ttp);
  if (ttp) out.ttp = ttp;
  const gc = pick(GA_CLIENT, r.gaClientId);
  if (gc) out.gaClientId = gc;
  const gs = pick(GA_SESSION, r.gaSessionId);
  if (gs) out.gaSessionId = gs;
  if (r.consent === 'granted' || r.consent === 'denied' || r.consent === 'unknown' || r.consent === 'na') out.consent = r.consent;
  return out;
}

/** The `_fbc` cookie value Meta documents for a click: fb.<subdomain index>.<click time ms>.<fbclid>. */
export const fbcFromClick = (fbclid: string, atMs: number): string => `fb.1.${atMs}.${fbclid}`;
