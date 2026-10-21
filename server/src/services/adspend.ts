import { z } from 'zod';
import type { Auth } from '../auth/context.js';
import { cleanText } from '../ads/touch.js';
import type { Deps } from '../deps.js';
import { AppError, badRequest, notFound } from '../errors.js';
import { requireFunnel } from '../repos/funnels.js';
import { CsvError, parseCsv } from '../util/csvparse.js';
import { newId } from '../util/ids.js';
import { isDay } from '../util/time.js';
import { fromMinor, isCurrency, toMinor } from '../util/money.js';
import { inTx } from '../db/scope.js';
import { audit } from './audit.js';

/**
 * Ad spend by day, per source (platform), account and campaign, in one currency per row. Money is stored in minor units (cents; the exponent of the currency, so yen are whole units); rows of different
 * currencies are never added together anywhere (the reports take a currency). A day is a calendar date as the ad platform reported it (platform reports are in the
 * ad account's own time zone, which this app cannot know): it is compared as written, not converted.
 */

export const MAX_SPEND = 1_000_000_000; // per row and day, in major units: far above any real budget, far below 2^53 cents

const text = (max: number) => z.string().transform((s) => cleanText(s, max) ?? '');
const count = z.number().int().min(0).max(1e12);

export const SpendInput = z.object({
  day: z.string().refine(isDay, 'Use a date as YYYY-MM-DD'),
  source: text(60).refine((s) => s.length > 0, 'A source (the platform, for example facebook) is required').transform((s) => s.toLowerCase()),
  account: text(80).optional().default(''),
  campaign: text(200).refine((s) => s.length > 0, 'A campaign name is required'),
  currency: z.string().trim().length(3).transform((s) => s.toUpperCase()).refine(isCurrency, 'Use a three-letter ISO 4217 currency code such as USD'),
  spend: z.number().min(0).max(MAX_SPEND),
  impressions: count.nullable().optional(),
  clicks: count.nullable().optional(),
  funnelId: z.string().max(64).nullable().optional(),
});
export type SpendInputT = z.infer<typeof SpendInput>;


interface SpendRow {
  id: string;
  day: string;
  source: string;
  account: string;
  campaign: string;
  currency: string;
  spend_cents: number;
  impressions: number | null;
  clicks: number | null;
  funnel_id: string | null;
  created_at: string;
  updated_at: string;
}

export const serializeSpend = (r: SpendRow) => ({
  id: r.id, day: r.day, source: r.source, account: r.account, campaign: r.campaign, currency: r.currency, spend: fromMinor(Number(r.spend_cents), r.currency),
  impressions: r.impressions === null ? null : Number(r.impressions), clicks: r.clicks === null ? null : Number(r.clicks), funnelId: r.funnel_id, createdAt: r.created_at, updatedAt: r.updated_at,
});

export const SpendQuery = z.object({
  from: z.string().refine(isDay, 'Use YYYY-MM-DD').optional(),
  to: z.string().refine(isDay, 'Use YYYY-MM-DD').optional(),
  source: z.string().max(60).optional(),
  campaign: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
});

export async function listSpend(deps: Deps, ws: string, q: z.infer<typeof SpendQuery>) {
  const where = ['workspace_id = ?'];
  const params: (string | number)[] = [ws];
  if (q.from) (where.push('day >= ?'), params.push(q.from));
  if (q.to) (where.push('day <= ?'), params.push(q.to));
  if (q.source) (where.push('source = ?'), params.push(q.source.toLowerCase()));
  if (q.campaign) (where.push('campaign = ?'), params.push(q.campaign));
  if (q.cursor) {
    const [day, id] = Buffer.from(q.cursor, 'base64url').toString().split('|');
    if (day && id) (where.push('(day < ? OR (day = ? AND id < ?))'), params.push(day, day, id));
  }
  const rows = await deps.db.all<SpendRow>(`SELECT * FROM ad_spend WHERE ${where.join(' AND ')} ORDER BY day DESC, id DESC LIMIT ?`, ...params, q.limit + 1);
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return { data: page.map(serializeSpend), nextCursor: rows.length > q.limit && last ? Buffer.from(`${last.day}|${last.id}`).toString('base64url') : null };
}

async function upsertRow(deps: Deps, ws: string, userId: string, r: SpendInputT): Promise<'created' | 'updated'> {
  const at = deps.now().toISOString();
  const cents = toMinor(r.spend, r.currency);
  const existing = await deps.db.get<{ id: string }>(
    'SELECT id FROM ad_spend WHERE workspace_id = ? AND day = ? AND source = ? AND account = ? AND campaign = ? AND currency = ?', ws, r.day, r.source, r.account ?? '', r.campaign, r.currency,
  );
  if (existing) {
    await deps.db.run('UPDATE ad_spend SET spend_cents = ?, impressions = ?, clicks = ?, funnel_id = ?, updated_at = ? WHERE id = ?', cents, r.impressions ?? null, r.clicks ?? null, r.funnelId ?? null, at, existing.id);
    return 'updated';
  }
  await deps.db.run(
    'INSERT INTO ad_spend (id, workspace_id, day, source, account, campaign, currency, spend_cents, impressions, clicks, funnel_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    newId('spd'), ws, r.day, r.source, r.account ?? '', r.campaign, r.currency, cents, r.impressions ?? null, r.clicks ?? null, r.funnelId ?? null, userId, at, at,
  );
  return 'created';
}

/** Manual entry. The same day, source, account, campaign and currency replaces the earlier amount (entering a correction is the normal case). */
export async function saveSpend(deps: Deps, auth: Auth, input: SpendInputT, ip: string | null) {
  const ws = auth.workspaceId;
  if (input.funnelId) await requireFunnel(deps.db, ws, input.funnelId);
  const outcome = await upsertRow(deps, ws, auth.userId, input);
  await audit(deps, { workspaceId: ws, actorId: auth.userId, action: 'ads.spend.saved', target: `${input.day}/${input.source}/${input.campaign}`.slice(0, 200), detail: { outcome, currency: input.currency, spend: input.spend }, ip });
  const row = await deps.db.get<SpendRow>('SELECT * FROM ad_spend WHERE workspace_id = ? AND day = ? AND source = ? AND account = ? AND campaign = ? AND currency = ?', ws, input.day, input.source, input.account ?? '', input.campaign, input.currency);
  return { outcome, row: serializeSpend(row!) };
}

export async function deleteSpend(deps: Deps, auth: Auth, id: string, ip: string | null): Promise<void> {
  const r = await deps.db.get<SpendRow>('SELECT * FROM ad_spend WHERE workspace_id = ? AND id = ?', auth.workspaceId, id);
  if (!r) throw notFound('Spend row');
  await deps.db.run('DELETE FROM ad_spend WHERE workspace_id = ? AND id = ?', auth.workspaceId, id);
  await audit(deps, { workspaceId: auth.workspaceId, actorId: auth.userId, action: 'ads.spend.deleted', target: id, detail: { day: r.day, source: r.source, campaign: r.campaign }, ip });
}

// ---- CSV import ----------------------------------------------------------------------------------------------------------------------------------------

const COLUMNS: Record<string, string[]> = {
  day: ['date', 'day', 'reporting starts', 'date start', 'segments.date'],
  source: ['source', 'platform', 'network', 'channel'],
  account: ['account', 'account name', 'ad account', 'account id'],
  campaign: ['campaign', 'campaign name', 'campaign_name'],
  currency: ['currency', 'currency code', 'account currency'],
  spend: ['spend', 'cost', 'amount spent', 'amount', 'amount spent (usd)', 'metrics.cost'],
  impressions: ['impressions', 'impr.', 'impr', 'metrics.impressions'],
  clicks: ['clicks', 'link clicks', 'metrics.clicks'],
};

export const ImportQuery = z.object({
  /** Parse and validate only; write nothing. */
  dryRun: z.enum(['true', 'false']).optional(),
  /** Import the valid rows and report the others, instead of refusing the whole file. */
  skipInvalid: z.enum(['true', 'false']).optional(),
  /** What to do with rows of the file that share day, source, account, campaign and currency: refuse (default) or add their amounts. */
  duplicates: z.enum(['error', 'sum']).optional(),
  /** Used for rows without a source or currency column. */
  source: z.string().max(60).optional(),
  currency: z.string().length(3).optional(),
});

export interface ImportIssue {
  line: number;
  field: string;
  message: string;
}
export interface ImportResult {
  dryRun: boolean;
  rows: number;
  valid: number;
  created: number;
  updated: number;
  skipped: number;
  errors: ImportIssue[];
  /** True when more than the first 100 problems exist. */
  moreErrors: boolean;
}

/** Plain decimal number as spreadsheets and ad managers export it: 1234.5, 1,234.50, $1,234.50, "1 234.50". European 1.234,50 is refused as ambiguous. */
export function parseMoney(raw: string): number | null {
  let s = raw.trim().replace(/^[\p{Sc}\s]+/u, '').replace(/[\p{Sc}\s]+$/u, '').replace(/\s/g, '');
  if (!s) return null;
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const parseCount = (raw: string): number | null => {
  const s = raw.trim().replace(/,/g, '');
  if (s === '') return null;
  return /^\d+$/.test(s) ? Number(s) : NaN;
};

function columnIndex(header: string[]): Record<string, number> {
  const idx: Record<string, number> = {};
  const norm = header.map((h) => h.toLowerCase().replace(/\s+/g, ' ').trim());
  for (const [field, names] of Object.entries(COLUMNS)) {
    const i = norm.findIndex((h) => names.includes(h));
    if (i >= 0) idx[field] = i;
  }
  return idx;
}

export async function importSpend(deps: Deps, auth: Auth, csv: string, q: z.infer<typeof ImportQuery>, ip: string | null): Promise<ImportResult> {
  const ws = auth.workspaceId;
  const max = deps.config.ADS_IMPORT_MAX_ROWS;
  if (Buffer.byteLength(csv) > deps.config.ADS_IMPORT_MAX_BYTES) throw new AppError(413, 'IMPORT_TOO_LARGE', `The file is larger than ${Math.round(deps.config.ADS_IMPORT_MAX_BYTES / 1_000_000)} MB`);
  let parsed;
  try {
    parsed = parseCsv(csv, { maxRows: max });
  } catch (e) {
    if (e instanceof CsvError) throw badRequest('INVALID_CSV', `${e.message} (line ${e.line})`);
    throw e;
  }
  const idx = columnIndex(parsed.header);
  const missing = ['day', 'campaign', 'spend'].filter((f) => idx[f] === undefined);
  if (idx.source === undefined && !q.source) missing.push('source (or pass ?source=)');
  if (idx.currency === undefined && !q.currency) missing.push('currency (or pass ?currency=)');
  if (missing.length) throw badRequest('MISSING_COLUMNS', `The header is missing: ${missing.join(', ')}. Found: ${parsed.header.join(', ') || '(none)'}`);
  const defaultCurrency = q.currency?.toUpperCase();
  if (defaultCurrency && !isCurrency(defaultCurrency)) throw badRequest('INVALID_CURRENCY', `"${q.currency}" is not a currency code`);

  const errors: ImportIssue[] = [];
  let moreErrors = false;
  const note = (line: number, field: string, message: string) => (errors.length < 100 ? errors.push({ line, field, message }) : (moreErrors = true));
  const keyOf = (r: SpendInputT) => [r.day, r.source, r.account ?? '', r.campaign.toLowerCase(), r.currency].join('\u0000');
  const valid = new Map<string, { line: number; row: SpendInputT }>();
  const duplicates = q.duplicates ?? 'error';
  let invalid = 0;
  for (const rec of parsed.rows) {
    const cell = (f: string) => (idx[f] === undefined ? '' : (rec.cells[idx[f]!] ?? ''));
    if (rec.cells.length > parsed.header.length) {
      note(rec.line, '*', `Row has ${rec.cells.length} values but the header has ${parsed.header.length}`);
      invalid++;
      continue;
    }
    let bad = false;
    const problem = (line: number, field: string, message: string) => {
      bad = true;
      note(line, field, message);
    };
    const dayRaw = cell('day').trim();
    const day = /^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(dayRaw) ? dayRaw.slice(0, 10) : dayRaw;
    const money = parseMoney(cell('spend'));
    const imp = parseCount(cell('impressions'));
    const clk = parseCount(cell('clicks'));
    if (!isDay(day)) problem(rec.line, 'date', `"${dayRaw.slice(0, 40)}" is not a date (use YYYY-MM-DD)`);
    if (money === null) problem(rec.line, 'spend', `"${cell('spend').slice(0, 40)}" is not an amount (use 1234.50; negative amounts and 1.234,50 are not accepted)`);
    else if (money > MAX_SPEND) problem(rec.line, 'spend', 'The amount is unreasonably large');
    if (Number.isNaN(imp)) problem(rec.line, 'impressions', `"${cell('impressions').slice(0, 40)}" is not a whole number`);
    if (Number.isNaN(clk)) problem(rec.line, 'clicks', `"${cell('clicks').slice(0, 40)}" is not a whole number`);
    const currencyRaw = (cell('currency').trim() || defaultCurrency || '').toUpperCase();
    if (!/^[A-Z]{3}$/.test(currencyRaw) || !isCurrency(currencyRaw)) problem(rec.line, 'currency', `"${cell('currency').slice(0, 20)}" is not a currency code`);
    const source = (cell('source').trim() || q.source || '').trim();
    // The structured checks above already named what is wrong with a field; the schema only speaks up for what they do not cover (empty campaign or source, lengths).
    const r = SpendInput.safeParse({ day, source, account: cell('account'), campaign: cell('campaign'), currency: currencyRaw, spend: money ?? 0, impressions: imp, clicks: clk });
    if (!bad && !r.success) for (const i of r.error.issues) problem(rec.line, String(i.path[0] ?? '*'), i.message);
    if (bad || !r.success) {
      invalid++;
      continue;
    }
    const key = keyOf(r.data);
    const prev = valid.get(key);
    if (prev) {
      if (duplicates === 'error') {
        note(rec.line, '*', `Duplicate of line ${prev.line} (same date, source, account, campaign and currency). Merge the rows, or import with duplicates=sum`);
        invalid++;
        continue;
      }
      prev.row = { ...prev.row, spend: prev.row.spend + r.data.spend, impressions: (prev.row.impressions ?? 0) + (r.data.impressions ?? 0) || prev.row.impressions, clicks: (prev.row.clicks ?? 0) + (r.data.clicks ?? 0) || prev.row.clicks };
      continue;
    }
    valid.set(key, { line: rec.line, row: r.data });
  }
  const dryRun = q.dryRun === 'true';
  const result: ImportResult = { dryRun, rows: parsed.rows.length, valid: valid.size, created: 0, updated: 0, skipped: invalid, errors, moreErrors };
  if (invalid > 0 && q.skipInvalid !== 'true') {
    if (!dryRun) throw new AppError(422, 'IMPORT_INVALID', `${invalid} of ${parsed.rows.length} rows are invalid; nothing was imported. Fix them, or import the valid rows with skipInvalid=true`, { ...result, valid: valid.size });
    return result;
  }
  if (dryRun) return result;
  await inTx(deps, async (d) => {
    for (const { row } of valid.values()) {
      const outcome = await upsertRow(d, ws, auth.userId, row);
      if (outcome === 'created') result.created++;
      else result.updated++;
    }
  });
  await audit(deps, { workspaceId: ws, actorId: auth.userId, action: 'ads.spend.imported', detail: { rows: parsed.rows.length, created: result.created, updated: result.updated, skipped: invalid }, ip });
  return result;
}

// ---- campaign mapping ----------------------------------------------------------------------------------------------------------------------------------

export const MapInput = z.object({
  source: text(60).refine((s) => s.length > 0, 'A source is required').transform((s) => s.toLowerCase()),
  campaign: text(200).refine((s) => s.length > 0, 'A campaign name is required'),
  utmCampaign: text(100).refine((s) => s.length > 0, 'The UTM campaign value is required'),
  utmSource: text(100).optional().transform((s) => (s ? s.toLowerCase() : null)),
});

interface MapRow {
  id: string;
  source: string;
  campaign: string;
  utm_source: string | null;
  utm_campaign: string;
  created_at: string;
}
const serializeMap = (m: MapRow) => ({ id: m.id, source: m.source, campaign: m.campaign, utmSource: m.utm_source, utmCampaign: m.utm_campaign, createdAt: m.created_at });

export async function listMappings(deps: Deps, ws: string) {
  return { data: (await deps.db.all<MapRow>('SELECT * FROM ad_campaign_map WHERE workspace_id = ? ORDER BY source, campaign', ws)).map(serializeMap) };
}

export async function saveMapping(deps: Deps, auth: Auth, input: z.infer<typeof MapInput>, ip: string | null) {
  const ws = auth.workspaceId;
  const at = deps.now().toISOString();
  const existing = await deps.db.get<{ id: string }>('SELECT id FROM ad_campaign_map WHERE workspace_id = ? AND source = ? AND campaign = ?', ws, input.source, input.campaign);
  if (existing) await deps.db.run('UPDATE ad_campaign_map SET utm_source = ?, utm_campaign = ? WHERE id = ?', input.utmSource, input.utmCampaign, existing.id);
  else await deps.db.run('INSERT INTO ad_campaign_map (id, workspace_id, source, campaign, utm_source, utm_campaign, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', newId('map'), ws, input.source, input.campaign, input.utmSource, input.utmCampaign, auth.userId, at);
  await audit(deps, { workspaceId: ws, actorId: auth.userId, action: 'ads.mapping.saved', target: input.campaign.slice(0, 200), detail: { source: input.source, utmCampaign: input.utmCampaign, utmSource: input.utmSource }, ip });
  return serializeMap((await deps.db.get<MapRow>('SELECT * FROM ad_campaign_map WHERE workspace_id = ? AND source = ? AND campaign = ?', ws, input.source, input.campaign))!);
}

export async function deleteMapping(deps: Deps, auth: Auth, id: string, ip: string | null): Promise<void> {
  const m = await deps.db.get<MapRow>('SELECT * FROM ad_campaign_map WHERE workspace_id = ? AND id = ?', auth.workspaceId, id);
  if (!m) throw notFound('Mapping');
  await deps.db.run('DELETE FROM ad_campaign_map WHERE workspace_id = ? AND id = ?', auth.workspaceId, id);
  await audit(deps, { workspaceId: auth.workspaceId, actorId: auth.userId, action: 'ads.mapping.deleted', target: id, detail: { source: m.source, campaign: m.campaign }, ip });
}
