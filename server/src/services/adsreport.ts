import { z } from 'zod';
import type { Deps } from '../deps.js';
import { requireFunnel } from '../repos/funnels.js';
import { toCsv } from '../util/csv.js';
import { round2 } from '../util/time.js';
import { fromMinor } from '../util/money.js';
import { AnalyticsQuery, resolveRange, type Range } from './analytics.js';

/**
 * Attribution and ad performance reports (docs/ADS.md).
 *
 * Attribution: visits, leads and orders by the marketing touch recorded for the visitor, first touch or last non-direct touch (`model`). Orders and revenue are in ONE
 * currency per report (`currency`; the others are listed in `currencies`), revenue is net of refunds and of amounts lost in Stripe disputes, an "order" is a checkout
 * (an order bump rides with its main offer and is not counted again).
 *
 * Performance: ad spend (entered or imported) joined to the attributed results by (platform, campaign), where the platform is the spend source and the traffic's
 * utm_source after folding the usual aliases (facebook/fb/instagram -> meta, ...), and the campaign is the spend campaign name or its mapped utm_campaign, compared
 * case-insensitively. Only results of campaigns that have spend count towards a row; the rest is reported as `other`, and spend whose campaign never appears in the
 * traffic is returned in `unmatched` so a person can map it. ROAS = revenue / spend; profit = revenue - spend; ratios with a zero denominator are null.
 */
export const AdsQuery = AnalyticsQuery.extend({
  model: z.enum(['first', 'last']).default('last'),
  groupBy: z.enum(['campaign', 'source', 'funnel', 'day']).default('campaign'),
  currency: z.string().trim().length(3).optional(),
  funnelId: z.string().max(64).optional(),
});
export const AttributionQuery = AnalyticsQuery.extend({
  model: z.enum(['first', 'last']).default('last'),
  dimension: z.enum(['source', 'medium', 'campaign', 'content', 'source_medium', 'source_medium_campaign']).default('source_medium'),
  currency: z.string().trim().length(3).optional(),
  funnelId: z.string().max(64).optional(),
});

/** Which funnels a caller may see: an API key only sees funnels of its mode (live or test); a signed-in person sees all. */
export interface Scope {
  mode?: 'live' | 'test';
}

const ALIASES: Record<string, string[]> = {
  meta: ['meta', 'facebook', 'fb', 'instagram', 'ig', 'facebook_ads', 'meta_ads', 'fb_ads', 'facebook-ads', 'meta-ads'],
  google: ['google', 'adwords', 'google_ads', 'googleads', 'google-ads', 'gads', 'youtube', 'yt'],
  tiktok: ['tiktok', 'tik_tok', 'tiktok_ads', 'tiktok-ads', 'tt'],
  bing: ['bing', 'microsoft', 'msn', 'microsoft_ads', 'bing_ads', 'microsoft-ads', 'bing-ads'],
  linkedin: ['linkedin', 'linkedin_ads', 'li', 'linkedin-ads'],
  twitter: ['twitter', 'x', 'twitter_ads', 'x_ads'],
  pinterest: ['pinterest', 'pinterest_ads', 'pin'],
  snapchat: ['snapchat', 'snap', 'snapchat_ads'],
  reddit: ['reddit', 'reddit_ads'],
};
const ALIAS_OF = new Map(Object.entries(ALIASES).flatMap(([canon, list]) => list.map((a) => [a, canon] as const)));
/** Folds a source name to its platform: `Facebook`, `fb` and `instagram` are all `meta`. Unknown names stand for themselves (lower-cased). */
export const platformOf = (s: string | null | undefined): string => {
  const v = (s ?? '').trim().toLowerCase();
  return ALIAS_OF.get(v) ?? v;
};

const majorIn = (currency: string) => (cents: number) => Number(fromMinor(Math.round(cents), currency).toFixed(3));
const div = (a: number, b: number): number | null => (b > 0 ? round2(a / b) : null);

interface Counts {
  visits: number;
  leads: number;
  orders: number;
  cents: number;
}
const zero = (): Counts => ({ visits: 0, leads: 0, orders: 0, cents: 0 });
const add = (a: Counts, b: Counts) => {
  a.visits += b.visits;
  a.leads += b.leads;
  a.orders += b.orders;
  a.cents += b.cents;
};
const n = (v: unknown) => Number(v ?? 0);

const NET = 'GREATEST(0, o.amount_cents - COALESCE(o.refunded_cents, 0) - COALESCE(o.disputed_lost_cents, 0))';
const netExpr = (deps: Deps) => (deps.db.dialect.name === 'sqlite' ? 'MAX(0, o.amount_cents - COALESCE(o.refunded_cents, 0) - COALESCE(o.disputed_lost_cents, 0))' : NET);

interface Filters {
  funnelId?: string;
  mode?: 'live' | 'test';
}
const modeCond = (col: string, f: Filters, ws: string): { sql: string; params: string[] } =>
  f.mode ? { sql: ` AND ${col} IN (SELECT id FROM funnels WHERE workspace_id = ? AND status = ?)`, params: [ws, f.mode] } : { sql: '', params: [] };

async function currenciesIn(deps: Deps, ws: string, range: Range, f: Filters, spendFrom: string, spendTo: string): Promise<{ currencies: string[]; byWeight: Map<string, number> }> {
  const w = new Map<string, number>();
  const m = modeCond('o.funnel_id', f, ws);
  for (const r of await deps.db.all<{ currency: string; c: number }>(
    `SELECT o.currency, SUM(o.amount_cents) AS c FROM orders o WHERE o.workspace_id = ? AND o.created_at >= ? AND o.created_at < ? ${f.funnelId ? 'AND o.funnel_id = ?' : ''}${m.sql} GROUP BY o.currency`,
    ws, range.startUtc, range.endUtc, ...(f.funnelId ? [f.funnelId] : []), ...m.params,
  )) w.set(r.currency, n(r.c));
  if (f.mode !== 'test') {
    for (const r of await deps.db.all<{ currency: string; c: number }>(
      `SELECT currency, SUM(spend_cents) AS c FROM ad_spend WHERE workspace_id = ? AND day >= ? AND day <= ? ${f.funnelId ? 'AND funnel_id = ?' : ''} GROUP BY currency`,
      ws, spendFrom, spendTo, ...(f.funnelId ? [f.funnelId] : []),
    )) w.set(r.currency, (w.get(r.currency) ?? 0) + n(r.c));
  }
  return { currencies: [...w.keys()].sort(), byWeight: w };
}

function pickCurrency(asked: string | undefined, found: { currencies: string[]; byWeight: Map<string, number> }): string {
  if (asked) return asked.toUpperCase();
  const top = [...found.byWeight.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
  return top?.[0] ?? 'USD';
}

// ---- attribution -----------------------------------------------------------------------------------------------------------------------------------------

type Dim = 'source' | 'medium' | 'campaign' | 'content';
const DIMS: Record<z.infer<typeof AttributionQuery>['dimension'], Dim[]> = {
  source: ['source'], medium: ['medium'], campaign: ['campaign'], content: ['content'], source_medium: ['source', 'medium'], source_medium_campaign: ['source', 'medium', 'campaign'],
};

export interface AttributionRow {
  source?: string;
  medium?: string;
  campaign?: string;
  content?: string;
  visits: number;
  leads: number;
  orders: number;
  revenue: number;
  conversionRate: number | null;
}

export async function attributionReport(base: Deps, ws: string, q: z.infer<typeof AttributionQuery>, scope: Scope = {}) {
  const deps: Deps = { ...base, db: base.db.read(ws) };
  if (q.funnelId) await requireFunnel(deps.db, ws, q.funnelId);
  const range = resolveRange(deps, q);
  const f: Filters = { funnelId: q.funnelId, mode: scope.mode };
  const found = await currenciesIn(deps, ws, range, f, range.from, range.to);
  const currency = pickCurrency(q.currency, found);
  const major = majorIn(currency);
  const p = q.model;
  const dims = DIMS[q.dimension];
  const col = (prefix: string, d: Dim) => `${prefix}${p}_${d}`;
  const sel = (prefix: string) => dims.map((d) => `MIN(${col(prefix, d)}) AS d_${d}`).join(', ');
  const grp = (prefix: string) => dims.map((d) => `LOWER(COALESCE(${col(prefix, d)}, ''))`).join(', ');
  const keyOf = (r: Record<string, unknown>) => dims.map((d) => String(r[`d_${d}`] ?? '').toLowerCase()).join('\u0000');
  const rows = new Map<string, { vals: Record<string, string | null>; c: Counts }>();
  const slot = (r: Record<string, unknown>) => {
    const k = keyOf(r);
    let s = rows.get(k);
    if (!s) rows.set(k, (s = { vals: Object.fromEntries(dims.map((d) => [d, (r[`d_${d}`] as string | null) || null])), c: zero() }));
    return s;
  };

  const vm = modeCond(`${p}_funnel_id`, f, ws);
  for (const r of await deps.db.all<Record<string, unknown>>(
    `SELECT ${sel('')}, COUNT(*) AS n FROM visitor_attribution WHERE workspace_id = ? AND ${p}_at >= ? AND ${p}_at < ? ${q.funnelId ? `AND ${p}_funnel_id = ?` : ''}${vm.sql} GROUP BY ${grp('')}`,
    ws, range.startUtc, range.endUtc, ...(q.funnelId ? [q.funnelId] : []), ...vm.params,
  )) slot(r).c.visits += n(r.n);

  const lm = modeCond('first_funnel_id', f, ws);
  for (const r of await deps.db.all<Record<string, unknown>>(
    `SELECT ${sel('')}, COUNT(*) AS n FROM leads WHERE workspace_id = ? AND created_at >= ? AND created_at < ? ${q.funnelId ? 'AND first_funnel_id = ?' : ''}${lm.sql} GROUP BY ${grp('')}`,
    ws, range.startUtc, range.endUtc, ...(q.funnelId ? [q.funnelId] : []), ...lm.params,
  )) slot(r).c.leads += n(r.n);

  const om = modeCond('o.funnel_id', f, ws);
  const oSel = dims.map((d) => `MIN(o.${col('', d)}) AS d_${d}`).join(', ');
  const oGrp = dims.map((d) => `LOWER(COALESCE(o.${col('', d)}, ''))`).join(', ');
  for (const r of await deps.db.all<Record<string, unknown>>(
    `SELECT ${oSel}, SUM(CASE WHEN o.is_bump = 0 THEN 1 ELSE 0 END) AS orders, SUM(${netExpr(deps)}) AS cents FROM orders o
     WHERE o.workspace_id = ? AND o.currency = ? AND o.created_at >= ? AND o.created_at < ? ${q.funnelId ? 'AND o.funnel_id = ?' : ''}${om.sql} GROUP BY ${oGrp}`,
    ws, currency, range.startUtc, range.endUtc, ...(q.funnelId ? [q.funnelId] : []), ...om.params,
  )) {
    const s = slot(r);
    s.c.orders += n(r.orders);
    s.c.cents += n(r.cents);
  }

  // Visitors with no marketing touch at all (direct visits): distinct page-view visitors in the range, minus those the attribution table knows a touch for.
  const em = modeCond('e.funnel_id', f, ws);
  const direct = n((await deps.db.get<{ n: number }>(
    `SELECT COUNT(DISTINCT e.visitor_id) AS n FROM events e WHERE e.workspace_id = ? AND e.type = 'page_view' AND e.visitor_id IS NOT NULL AND e.created_at >= ? AND e.created_at < ? ${q.funnelId ? 'AND e.funnel_id = ?' : ''}${em.sql}
     AND NOT EXISTS (SELECT 1 FROM visitor_attribution v WHERE v.workspace_id = e.workspace_id AND v.visitor_id = e.visitor_id AND v.first_at IS NOT NULL)`,
    ws, range.startUtc, range.endUtc, ...(q.funnelId ? [q.funnelId] : []), ...em.params,
  ))?.n);
  if (direct > 0) {
    const d = slot(Object.fromEntries(dims.map((x) => [`d_${x}`, '']))) ;
    d.c.visits += direct;
  }

  const out: AttributionRow[] = [...rows.values()]
    .map(({ vals, c }) => ({
      ...Object.fromEntries(dims.map((d) => [d, vals[d] ?? '(direct)'])),
      visits: c.visits, leads: c.leads, orders: c.orders, revenue: major(c.cents), conversionRate: c.visits > 0 ? round2((c.orders / c.visits) * 100) : null,
    } as AttributionRow))
    .filter((r) => r.visits + r.leads + r.orders > 0)
    .sort((a, b) => b.revenue - a.revenue || b.visits - a.visits || JSON.stringify(a) .localeCompare(JSON.stringify(b)))
    .slice(0, 500);
  const totals = out.reduce((t, r) => ({ visits: t.visits + r.visits, leads: t.leads + r.leads, orders: t.orders + r.orders, revenue: round2(t.revenue + r.revenue) }), { visits: 0, leads: 0, orders: 0, revenue: 0 });
  return { range: { from: range.from, to: range.to, tz: range.tz }, model: q.model, dimension: q.dimension, currency, currencies: found.currencies.length ? found.currencies : [currency], rows: out, totals };
}

// ---- performance -----------------------------------------------------------------------------------------------------------------------------------------

export interface PerfRow {
  key: string;
  source: string | null;
  campaign: string | null;
  funnelId: string | null;
  funnelName: string | null;
  day: string | null;
  spend: number;
  impressions: number | null;
  clicks: number | null;
  visits: number;
  leads: number;
  orders: number;
  revenue: number;
  cpl: number | null;
  cpa: number | null;
  cpc: number | null;
  ctr: number | null;
  roas: number | null;
  profit: number;
}

interface SpendAgg {
  platform: string;
  source: string;
  campaign: string;
  funnelId: string | null;
  day: string | null;
  cents: number;
  impressions: number | null;
  clicks: number | null;
  /** The join key (platform|campaign) after the campaign mapping. */
  key: string;
  mapped: boolean;
}

const sum = (a: number | null, b: number | null) => (a === null && b === null ? null : (a ?? 0) + (b ?? 0));

export async function adsPerformance(base: Deps, ws: string, q: z.infer<typeof AdsQuery>, scope: Scope = {}) {
  const deps: Deps = { ...base, db: base.db.read(ws) };
  if (q.funnelId) await requireFunnel(deps.db, ws, q.funnelId);
  const range = resolveRange(deps, q);
  const f: Filters = { funnelId: q.funnelId, mode: scope.mode };
  const found = await currenciesIn(deps, ws, range, f, range.from, range.to);
  const currency = pickCurrency(q.currency, found);
  const major = majorIn(currency);
  const p = q.model;

  // 1. spend (this currency only), mapped to the campaign names traffic uses
  const maps = new Map((await deps.db.all<{ source: string; campaign: string; utm_source: string | null; utm_campaign: string }>('SELECT source, campaign, utm_source, utm_campaign FROM ad_campaign_map WHERE workspace_id = ?', ws)).map((m) => [`${m.source.toLowerCase()}\u0000${m.campaign.toLowerCase()}`, m]));
  const spendRows = scope.mode === 'test' ? [] : await deps.db.all<{ source: string; campaign: string; funnel_id: string | null; day: string; cents: number; impressions: number | null; clicks: number | null }>(
    `SELECT MIN(source) AS source, MIN(campaign) AS campaign, funnel_id, ${q.groupBy === 'day' ? 'day' : "'' AS day"}, SUM(spend_cents) AS cents, SUM(impressions) AS impressions, SUM(clicks) AS clicks
     FROM ad_spend WHERE workspace_id = ? AND currency = ? AND day >= ? AND day <= ? ${q.funnelId ? 'AND funnel_id = ?' : ''}
     GROUP BY LOWER(source), LOWER(campaign), funnel_id${q.groupBy === 'day' ? ', day' : ''}`,
    ws, currency, range.from, range.to, ...(q.funnelId ? [q.funnelId] : []),
  );
  const spend: SpendAgg[] = spendRows.map((r) => {
    const m = maps.get(`${r.source.toLowerCase()}\u0000${r.campaign.toLowerCase()}`);
    const platform = platformOf(m?.utm_source ?? r.source);
    return { platform, source: r.source, campaign: r.campaign, funnelId: r.funnel_id, day: q.groupBy === 'day' ? r.day : null, cents: n(r.cents), impressions: r.impressions === null ? null : n(r.impressions), clicks: r.clicks === null ? null : n(r.clicks), key: `${platform}\u0000${(m?.utm_campaign ?? r.campaign).toLowerCase()}`, mapped: !!m };
  });
  const spendKeys = new Set(spend.map((s) => s.key));

  // 2. attributed results by (platform, campaign), optionally also by funnel or local day
  // The zone is validated by resolveRange (Intl); it is inlined as a literal, so the SELECT and GROUP BY expressions are identical (a bound parameter would make PostgreSQL reject the grouping).
  const tz = /^[A-Za-z0-9_+\-/]{1,64}$/.test(range.tz) ? range.tz : 'UTC';
  const extraCol = (kind: 'visit' | 'lead' | 'order'): string | null => {
    if (q.groupBy === 'funnel') return kind === 'order' ? 'o.funnel_id' : kind === 'lead' ? 'first_funnel_id' : `${p}_funnel_id`;
    if (q.groupBy === 'day') return kind === 'order' ? deps.db.dialect.localDay('o.created_at', `'${tz}'`) : kind === 'lead' ? deps.db.dialect.localDay('created_at', `'${tz}'`) : deps.db.dialect.localDay(`${p}_at`, `'${tz}'`);
    return null;
  };
  const results = new Map<string, Counts & { source: string; campaign: string }>();
  const other = zero();
  const take = (source: string | null, campaign: string | null, extra: string | null, c: Counts) => {
    const platform = platformOf(source);
    const key = `${platform}\u0000${(campaign ?? '').toLowerCase()}`;
    if (!spendKeys.has(key)) {
      add(other, c);
      return;
    }
    const ek = `${key}\u0000${extra ?? ''}`;
    const cur = results.get(ek) ?? { ...zero(), source: platform, campaign: campaign ?? '' };
    add(cur, c);
    results.set(ek, cur);
  };

  const vx = extraCol('visit');
  const vm = modeCond(`${p}_funnel_id`, f, ws);
  for (const r of await deps.db.all<Record<string, unknown>>(
    `SELECT MIN(${p}_source) AS s, MIN(${p}_campaign) AS c${vx ? `, ${vx} AS x` : ''}, COUNT(*) AS n FROM visitor_attribution WHERE workspace_id = ? AND ${p}_at >= ? AND ${p}_at < ? AND ${p}_campaign IS NOT NULL ${q.funnelId ? `AND ${p}_funnel_id = ?` : ''}${vm.sql}
     GROUP BY LOWER(COALESCE(${p}_source, '')), LOWER(${p}_campaign)${vx ? `, ${vx}` : ''}`,
    ws, range.startUtc, range.endUtc, ...(q.funnelId ? [q.funnelId] : []), ...vm.params,
  )) take(r.s as string | null, r.c as string | null, (r.x as string | null) ?? null, { ...zero(), visits: n(r.n) });

  const lx = extraCol('lead');
  const lm = modeCond('first_funnel_id', f, ws);
  for (const r of await deps.db.all<Record<string, unknown>>(
    `SELECT MIN(${p}_source) AS s, MIN(${p}_campaign) AS c${lx ? `, ${lx} AS x` : ''}, COUNT(*) AS n FROM leads WHERE workspace_id = ? AND created_at >= ? AND created_at < ? AND ${p}_campaign IS NOT NULL ${q.funnelId ? 'AND first_funnel_id = ?' : ''}${lm.sql}
     GROUP BY LOWER(COALESCE(${p}_source, '')), LOWER(${p}_campaign)${lx ? `, ${lx}` : ''}`,
    ws, range.startUtc, range.endUtc, ...(q.funnelId ? [q.funnelId] : []), ...lm.params,
  )) take(r.s as string | null, r.c as string | null, (r.x as string | null) ?? null, { ...zero(), leads: n(r.n) });

  const ox = extraCol('order');
  const om = modeCond('o.funnel_id', f, ws);
  for (const r of await deps.db.all<Record<string, unknown>>(
    `SELECT MIN(o.${p}_source) AS s, MIN(o.${p}_campaign) AS c${ox ? `, ${ox} AS x` : ''}, SUM(CASE WHEN o.is_bump = 0 THEN 1 ELSE 0 END) AS orders, SUM(${netExpr(deps)}) AS cents FROM orders o
     WHERE o.workspace_id = ? AND o.currency = ? AND o.created_at >= ? AND o.created_at < ? ${q.funnelId ? 'AND o.funnel_id = ?' : ''}${om.sql}
     GROUP BY LOWER(COALESCE(o.${p}_source, '')), LOWER(COALESCE(o.${p}_campaign, ''))${ox ? `, ${ox}` : ''}`,
    ws, currency, range.startUtc, range.endUtc, ...(q.funnelId ? [q.funnelId] : []), ...om.params,
  )) take(r.s as string | null, r.c as string | null, (r.x as string | null) ?? null, { ...zero(), orders: n(r.orders), cents: n(r.cents) });

  // 3. rows for the requested grouping
  const names = new Map<string, string>();
  if (q.groupBy === 'funnel') for (const r of await deps.db.all<{ id: string; name: string }>('SELECT id, name FROM funnels WHERE workspace_id = ?', ws)) names.set(r.id, r.name);
  interface Acc extends Counts {
    spendCents: number;
    impressions: number | null;
    clicks: number | null;
    source: string | null;
    campaign: string | null;
    funnelId: string | null;
    day: string | null;
    mapped: boolean;
  }
  const acc = new Map<string, Acc>();
  const get = (key: string, init: Partial<Acc>): Acc => {
    let a = acc.get(key);
    if (!a) acc.set(key, (a = { ...zero(), spendCents: 0, impressions: null, clicks: null, source: null, campaign: null, funnelId: null, day: null, mapped: false, ...init }));
    return a;
  };
  const rowKey = (s: { platform?: string; key?: string; funnelId?: string | null; day?: string | null }): string =>
    q.groupBy === 'campaign' ? s.key! : q.groupBy === 'source' ? s.platform! : q.groupBy === 'funnel' ? s.funnelId ?? '' : s.day ?? '';
  for (const s of spend) {
    const a = get(rowKey(s), { source: q.groupBy === 'campaign' || q.groupBy === 'source' ? s.platform : null, campaign: q.groupBy === 'campaign' ? s.campaign : null, funnelId: q.groupBy === 'funnel' ? s.funnelId : null, day: q.groupBy === 'day' ? s.day : null });
    a.spendCents += s.cents;
    a.impressions = sum(a.impressions, s.impressions);
    a.clicks = sum(a.clicks, s.clicks);
    a.mapped ||= s.mapped;
  }
  for (const [ek, c] of results) {
    const [platform, camp, extra] = ek.split('\u0000') as [string, string, string];
    const key = q.groupBy === 'campaign' ? `${platform}\u0000${camp}` : q.groupBy === 'source' ? platform : extra;
    const a = get(key, { source: q.groupBy === 'campaign' || q.groupBy === 'source' ? platform : null, campaign: q.groupBy === 'campaign' ? c.campaign : null, funnelId: q.groupBy === 'funnel' ? extra || null : null, day: q.groupBy === 'day' ? extra : null });
    add(a, c);
  }

  const toRow = (key: string, a: Acc): PerfRow => ({
    key, source: a.source, campaign: a.campaign, funnelId: a.funnelId, funnelName: a.funnelId ? names.get(a.funnelId) ?? null : null, day: a.day,
    spend: major(a.spendCents), impressions: a.impressions, clicks: a.clicks, visits: a.visits, leads: a.leads, orders: a.orders, revenue: major(a.cents),
    cpl: div(major(a.spendCents), a.leads), cpa: div(major(a.spendCents), a.orders), cpc: a.clicks ? div(major(a.spendCents), a.clicks) : null,
    ctr: a.impressions && a.clicks !== null ? round2((a.clicks / a.impressions) * 100) : null,
    roas: a.spendCents > 0 ? round2(a.cents / a.spendCents) : null, profit: major(a.cents - a.spendCents),
  });
  const rowsOut = [...acc.entries()].map(([k, a]) => toRow(k, a));
  rowsOut.sort(q.groupBy === 'day' ? (a, b) => (a.day! < b.day! ? -1 : 1) : (a, b) => b.spend - a.spend || b.revenue - a.revenue || (a.key < b.key ? -1 : 1));
  const t = [...acc.values()].reduce((x, a) => ({ ...x, spendCents: x.spendCents + a.spendCents, impressions: sum(x.impressions, a.impressions), clicks: sum(x.clicks, a.clicks), visits: x.visits + a.visits, leads: x.leads + a.leads, orders: x.orders + a.orders, cents: x.cents + a.cents }), { ...zero(), spendCents: 0, impressions: null as number | null, clicks: null as number | null });
  const totals = toRow('total', { ...zero(), ...t, source: null, campaign: null, funnelId: null, day: null, mapped: false });

  // 4. spend whose campaign name never shows up in the traffic: candidates for the mapping screen, with the traffic campaign names seen in the range as choices
  const seen = new Set<string>();
  const traffic = new Map<string, { source: string; campaign: string }>();
  for (const [tbl, when] of [['visitor_attribution', `${p}_at`], ['leads', 'created_at'], ['orders', 'created_at']] as const) {
    const fcol = tbl === 'visitor_attribution' ? `${p}_funnel_id` : tbl === 'leads' ? 'first_funnel_id' : 'funnel_id';
    const mm = modeCond(fcol, f, ws);
    const bounds = tbl === 'visitor_attribution' ? [range.startUtc, range.endUtc] : [range.startUtc, range.endUtc];
    for (const r of await deps.db.all<{ s: string | null; c: string }>(
      `SELECT MIN(${p}_source) AS s, MIN(${p}_campaign) AS c FROM ${tbl} WHERE workspace_id = ? AND ${when} >= ? AND ${when} < ? AND ${p}_campaign IS NOT NULL${mm.sql} GROUP BY LOWER(COALESCE(${p}_source, '')), LOWER(${p}_campaign) LIMIT 500`,
      ws, ...bounds, ...mm.params,
    )) {
      const k = `${platformOf(r.s)}\u0000${r.c.toLowerCase()}`;
      seen.add(k);
      if (!traffic.has(k)) traffic.set(k, { source: platformOf(r.s), campaign: r.c });
    }
  }
  const unmatchedMap = new Map<string, { source: string; campaign: string; spend: number; hint: string | null }>();
  for (const s of spend) {
    if (seen.has(s.key)) continue;
    const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, '');
    const hint = [...traffic.values()].find((t) => t.source === s.platform && norm(t.campaign) === norm(s.campaign))?.campaign ?? null;
    const k = `${s.source.toLowerCase()}\u0000${s.campaign.toLowerCase()}`;
    const cur = unmatchedMap.get(k) ?? { source: s.source, campaign: s.campaign, spend: 0, hint };
    cur.spend = round2(cur.spend + major(s.cents));
    unmatchedMap.set(k, cur);
  }

  return {
    range: { from: range.from, to: range.to, tz: range.tz }, model: q.model, groupBy: q.groupBy, currency, currencies: found.currencies.length ? found.currencies : [currency],
    rows: rowsOut, totals,
    other: { visits: other.visits, leads: other.leads, orders: other.orders, revenue: major(other.cents) },
    unmatched: [...unmatchedMap.values()].sort((a, b) => b.spend - a.spend),
    campaigns: [...traffic.values()].map((t) => t.campaign).sort(),
  };
}

export function performanceCsv(report: Awaited<ReturnType<typeof adsPerformance>>): string {
  const headers = ['Group', 'Source', 'Campaign', 'Funnel', 'Day', 'Currency', 'Spend', 'Impressions', 'Clicks', 'Visits', 'Leads', 'Orders', 'Revenue', 'CPL', 'CPA', 'CPC', 'CTR %', 'ROAS', 'Profit'];
  const line = (r: PerfRow, label: string) => [label, r.source, r.campaign, r.funnelName ?? r.funnelId, r.day, report.currency, r.spend, r.impressions, r.clicks, r.visits, r.leads, r.orders, r.revenue, r.cpl, r.cpa, r.cpc, r.ctr, r.roas, r.profit];
  return toCsv(headers, [...report.rows.map((r) => line(r, report.groupBy)), line(report.totals, 'total')]);
}

export function attributionCsv(report: Awaited<ReturnType<typeof attributionReport>>): string {
  return toCsv(['Source', 'Medium', 'Campaign', 'Content', 'Currency', 'Visits', 'Leads', 'Orders', 'Revenue', 'Order conversion %'], report.rows.map((r) => [r.source, r.medium, r.campaign, r.content, report.currency, r.visits, r.leads, r.orders, r.revenue, r.conversionRate]));
}

