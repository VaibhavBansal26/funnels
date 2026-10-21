import { createHmac } from 'node:crypto';
import { z } from 'zod';
import type { Auth } from '../auth/context.js';
import { decryptSecret, encryptSecret } from '../auth/secrets.js';
import type { Deps } from '../deps.js';
import { AppError, badRequest, notFound } from '../errors.js';
import { loadDoc, type ProjectDoc } from '../pagemodel/doc.js';
import { walk, wrapperOf } from '../pagemodel/shared/clean.js';
import { googleLink, googlePhoto, type MarkupCtx, type ReviewsData } from '../pagemodel/shared/markup.js';
import type { ReviewCtaProps, ReviewsProps } from '../pagemodel/shared/props.js';
import { denyError } from '../ratelimit/response.js';
import { audit } from './audit.js';

/**
 * Google reviews (docs/REVIEWS.md). Review content comes from the Places API (New), is fetched only by the server, and is shown with the attribution Google requires.
 * Not exercised against the real Google API: the shapes below follow the current documentation and the tests use a fake.
 *   Place Details: https://developers.google.com/maps/documentation/places/web-service/place-details
 *   Text Search:   https://developers.google.com/maps/documentation/places/web-service/text-search
 *   Review object: https://developers.google.com/maps/documentation/places/web-service/reference/rest/v1/places#Review
 *   Policies:      https://developers.google.com/maps/documentation/places/web-service/policies
 */
export const PlaceIdSchema = z.string().regex(/^[A-Za-z0-9_-]{10,200}$/, 'Invalid place id');
const KEY_RE = /^[A-Za-z0-9_-]{20,200}$/;
const DETAILS_MASK = 'id,displayName,rating,userRatingCount,googleMapsUri,reviews';
const SEARCH_MASK = 'places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount';

export const SettingsInput = z.object({
  apiKey: z.string().regex(KEY_RE, 'That does not look like a Google API key').optional(),
  clearKey: z.boolean().optional(),
  defaultPlaceId: z.union([PlaceIdSchema, z.literal('')]).optional(),
  defaultPlaceName: z.string().trim().max(120).optional(),
});
export const SearchInput = z.object({ query: z.string().trim().min(2).max(200) });
export const TestInput = z.object({ placeId: PlaceIdSchema.optional() });

interface SettingsRow { workspace_id: string; key_enc: string | null; key_hint: string | null; default_place_id: string | null; default_place_name: string | null; status: string; last_error: string | null; last_ok_at: string | null; circuit_until: string | null; updated_at: string }
interface CacheRow { workspace_id: string; place_id: string; payload_json: string | null; fetched_at: string | null; expires_at: string | null; fail_count: number; circuit_until: string | null; last_error: string | null }

const getSettings = (deps: Deps, ws: string) => deps.db.get<SettingsRow>('SELECT * FROM google_reviews_settings WHERE workspace_id = ?', ws);
const iso = (deps: Deps) => deps.now().toISOString();
const hint = (key: string) => `…${key.slice(-4)}`;

// ---- settings -----------------------------------------------------------------------------------------------------------------------------------------

export type KeySource = 'workspace' | 'platform' | 'none';
export async function resolveKey(deps: Deps, ws: string): Promise<{ key: string | null; source: KeySource }> {
  const row = await getSettings(deps, ws);
  if (row?.key_enc) {
    try {
      return { key: decryptSecret(deps.config, row.key_enc), source: 'workspace' };
    } catch {
      // unreadable (the data key changed): behave as if no workspace key is stored; the settings screen shows it
    }
  }
  return deps.config.GOOGLE_PLACES_API_KEY ? { key: deps.config.GOOGLE_PLACES_API_KEY, source: 'platform' } : { key: null, source: 'none' };
}

export async function getSettingsView(deps: Deps, ws: string) {
  const row = await getSettings(deps, ws);
  const { source } = await resolveKey(deps, ws);
  return {
    keySource: source,
    keyConfigured: source !== 'none',
    workspaceKeyHint: row?.key_enc ? row.key_hint : null,
    defaultPlaceId: row?.default_place_id || null,
    defaultPlaceName: row?.default_place_name || null,
    status: source === 'none' ? 'unset' : (row?.status ?? 'unset'),
    lastError: row?.last_error ?? null,
    lastOkAt: row?.last_ok_at ?? null,
    cacheTtlSeconds: deps.config.GOOGLE_REVIEWS_CACHE_TTL_S,
    dailyFetchLimit: deps.config.GOOGLE_REVIEWS_DAILY_FETCHES,
  };
}

export async function saveSettings(deps: Deps, auth: Auth, input: z.infer<typeof SettingsInput>, ip?: string) {
  const ws = auth.workspaceId;
  const cur = await getSettings(deps, ws);
  const at = iso(deps);
  let keyEnc = cur?.key_enc ?? null;
  let keyHint = cur?.key_hint ?? null;
  if (input.clearKey) { keyEnc = null; keyHint = null; }
  if (input.apiKey) { keyEnc = encryptSecret(deps.config, input.apiKey); keyHint = hint(input.apiKey); }
  const place = input.defaultPlaceId !== undefined ? input.defaultPlaceId || null : (cur?.default_place_id ?? null);
  const name = input.defaultPlaceId !== undefined ? (input.defaultPlaceId ? (input.defaultPlaceName ?? null) : null) : (input.defaultPlaceName ?? cur?.default_place_name ?? null);
  const status = input.apiKey || input.clearKey ? 'unverified' : (cur?.status ?? 'unset');
  await deps.db.run(
    `INSERT INTO google_reviews_settings (workspace_id, key_enc, key_hint, default_place_id, default_place_name, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)${deps.db.dialect.upsert(['workspace_id'], 'key_enc = excluded.key_enc, key_hint = excluded.key_hint, default_place_id = excluded.default_place_id, default_place_name = excluded.default_place_name, status = excluded.status, circuit_until = NULL, last_error = NULL, updated_at = excluded.updated_at')}`,
    ws, keyEnc, keyHint, place, name, status, at,
  );
  if (input.apiKey || input.clearKey || input.defaultPlaceId !== undefined) await deps.db.run('DELETE FROM google_places_cache WHERE workspace_id = ?', ws);
  snapshots.forEach((_v, k) => k.startsWith(`${ws}|`) && snapshots.delete(k));
  defaults.delete(ws);
  await audit(deps, { workspaceId: ws, actorId: auth.userId, action: 'google_reviews.settings', ip, detail: { keyChanged: !!input.apiKey, keyCleared: !!input.clearKey, defaultPlaceId: place } });
  return getSettingsView(deps, ws);
}

// ---- Places API client ---------------------------------------------------------------------------------------------------------------------------------

export class PlacesError extends AppError {
  constructor(public kind: 'no_key' | 'key_rejected' | 'not_found' | 'quota' | 'upstream' | 'bad_response' | 'circuit', message: string) {
    super(kind === 'no_key' ? 409 : kind === 'not_found' ? 404 : kind === 'quota' ? 429 : 502, `PLACES_${kind.toUpperCase()}`, message);
  }
}

const clean = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/g, '').trim().slice(0, max) : '');
const LANG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/;

/**
 * Turns a Places API (New) Place into what pages show. The review text is passed through unchanged apart from control and bidi-override characters and a length
 * cap (it is shown in full, never rewritten, summarised or translated); links and photos must be https on Google hosts, anything else is dropped.
 */
export function normalizePlace(raw: unknown, fetchedAt: string): ReviewsData & { placeId: string; name: string } {
  const p = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const rating = typeof p.rating === 'number' && p.rating >= 0 && p.rating <= 5 ? p.rating : null;
  const total = typeof p.userRatingCount === 'number' && Number.isFinite(p.userRatingCount) && p.userRatingCount >= 0 ? Math.floor(p.userRatingCount) : null;
  const dn = p.displayName as { text?: unknown } | undefined;
  const reviews = (Array.isArray(p.reviews) ? p.reviews : []).slice(0, 5).flatMap((r: unknown) => {
    const x = (typeof r === 'object' && r !== null ? r : {}) as Record<string, unknown>;
    const rr = typeof x.rating === 'number' ? Math.round(x.rating) : NaN;
    if (!(rr >= 1 && rr <= 5)) return [];
    const original = x.originalText as { text?: unknown; languageCode?: unknown } | undefined;
    const shown = x.text as { text?: unknown; languageCode?: unknown } | undefined;
    const body = original?.text !== undefined ? original : shown;
    const a = (x.authorAttribution ?? {}) as { displayName?: unknown; uri?: unknown; photoUri?: unknown };
    const lang = clean(body?.languageCode, 20);
    const authorUri = googleLink(a.uri);
    const photoUri = googlePhoto(a.photoUri);
    return [{
      author: clean(a.displayName, 120) || 'Google user', ...(authorUri ? { authorUri } : {}), ...(photoUri ? { photoUri } : {}), rating: rr, text: clean(body?.text, 4000),
      ...(LANG.test(lang) ? { lang } : {}), ...(clean(x.relativePublishTimeDescription, 60) ? { when: clean(x.relativePublishTimeDescription, 60) } : {}),
    }];
  });
  return { source: 'google', placeId: clean(p.id, 200), name: clean(dn?.text, 120), placeName: clean(dn?.text, 120), rating, total, mapsUri: googleLink(p.googleMapsUri), reviews, fetchedAt };
}

async function callPlaces(deps: Deps, key: string, path: string, init: { method: 'GET' | 'POST'; mask: string; body?: unknown }): Promise<unknown> {
  let res: Response;
  try {
    res = await deps.outbound(`${deps.config.GOOGLE_PLACES_API_BASE.replace(/\/+$/, '')}${path}`, {
      method: init.method,
      headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': init.mask, accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}) },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new PlacesError('upstream', 'Google could not be reached');
  }
  if (res.status === 401 || res.status === 403) throw new PlacesError('key_rejected', 'Google rejected the API key (check that the Places API (New) is enabled for it and that its restrictions allow this server)');
  if (res.status === 400 || res.status === 404) throw new PlacesError('not_found', 'Google does not know that place');
  if (res.status === 429) throw new PlacesError('quota', 'Google says the key is over its quota');
  if (!res.ok) throw new PlacesError('upstream', `Google answered ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new PlacesError('bad_response', 'Google sent an answer that could not be read');
  }
}

/** One paid call is charged to the workspace's daily budget first; refusing here keeps a runaway page from spending the key. */
async function charge(deps: Deps, ws: string, policy: 'reviews.fetch' | 'reviews.search'): Promise<void> {
  const d = await deps.limiter.check(policy, { ip: 'workspace', workspaceId: ws });
  if (!d.allowed) {
    if (d.status === 503) throw denyError(d);
    throw new PlacesError('quota', 'This workspace reached its daily limit for Google review lookups');
  }
}

// ---- cache, circuit breaker, snapshots -----------------------------------------------------------------------------------------------------------------

const snapshots = new Map<string, ReviewsData>();
const defaults = new Map<string, string | null>();
const SNAP_MAX = 1000;
const remember = (ws: string, placeId: string, data: ReviewsData | null) => {
  const k = `${ws}|${placeId}`;
  if (!data) { snapshots.delete(k); return; }
  if (snapshots.size >= SNAP_MAX) snapshots.delete(snapshots.keys().next().value!);
  snapshots.set(k, data);
};

const CIRCUIT_AFTER = 3;
const circuitMs = (fails: number) => Math.min(3_600_000, 300_000 * 2 ** (fails - CIRCUIT_AFTER));

async function recordFailure(deps: Deps, ws: string, placeId: string, e: PlacesError): Promise<void> {
  const at = deps.now();
  const prev = await deps.db.get<CacheRow>('SELECT * FROM google_places_cache WHERE workspace_id = ? AND place_id = ?', ws, placeId);
  const fails = (prev?.fail_count ?? 0) + 1;
  const until = fails >= CIRCUIT_AFTER ? new Date(at.getTime() + circuitMs(fails)).toISOString() : null;
  await deps.db.run(
    `INSERT INTO google_places_cache (workspace_id, place_id, fail_count, circuit_until, last_error) VALUES (?, ?, ?, ?, ?)${deps.db.dialect.upsert(['workspace_id', 'place_id'], 'fail_count = excluded.fail_count, circuit_until = excluded.circuit_until, last_error = excluded.last_error')}`,
    ws, placeId, fails, until, e.kind,
  );
  // a rejected key fails every place: remember it on the settings so the screen can say so and calls pause for 15 minutes
  if (e.kind === 'key_rejected') {
    const stamp = new Date(at.getTime() + 900_000).toISOString();
    await deps.db.run(
      `INSERT INTO google_reviews_settings (workspace_id, status, last_error, circuit_until, updated_at) VALUES (?, 'error', ?, ?, ?)${deps.db.dialect.upsert(['workspace_id'], "status = 'error', last_error = excluded.last_error, circuit_until = excluded.circuit_until")}`,
      ws, e.message, stamp, at.toISOString(),
    );
  }
}

export interface PlaceResult { data: (ReviewsData & { placeId: string; name: string }) | null; origin: 'cache' | 'live' | 'none'; error?: PlacesError }

/**
 * Review content of a place for a workspace: the cache while it is fresh, otherwise one live fetch (single flight per place), otherwise nothing. Never serves content
 * past its expiry, never throws for upstream problems (the caller shows the author's testimonials instead), and stops calling Google for a while after repeated failures.
 */
export async function getPlace(deps: Deps, ws: string, placeId: string, opts: { force?: boolean; noFetch?: boolean } = {}): Promise<PlaceResult> {
  const now = deps.now();
  const row = await deps.db.get<CacheRow>('SELECT * FROM google_places_cache WHERE workspace_id = ? AND place_id = ?', ws, placeId);
  if (!opts.force && row?.payload_json && row.expires_at && row.expires_at > now.toISOString()) {
    const data = JSON.parse(row.payload_json) as PlaceResult['data'];
    remember(ws, placeId, data);
    const ttl = deps.config.GOOGLE_REVIEWS_CACHE_TTL_S * 1000;
    if (ttl > 0 && new Date(row.expires_at).getTime() - now.getTime() < ttl * 0.2) await deps.jobs.enqueue('reviews.refresh', { ws, placeId }, { dedupeKey: `reviews.refresh:${ws}:${placeId}`, maxAttempts: 2, group: ws });
    return { data, origin: 'cache' };
  }
  if (opts.noFetch) return { data: null, origin: 'none' };
  const settings = await getSettings(deps, ws);
  if (!opts.force && ((row?.circuit_until && row.circuit_until > now.toISOString()) || (settings?.circuit_until && settings.circuit_until > now.toISOString()))) {
    return { data: null, origin: 'none', error: new PlacesError('circuit', 'Google lookups are paused after repeated errors') };
  }
  const { key } = await resolveKey(deps, ws);
  if (!key) return { data: null, origin: 'none', error: new PlacesError('no_key', 'No Google API key is configured') };
  return deps.flights.run('gplace', `${ws}:${placeId}`, async (): Promise<PlaceResult> => {
    try {
      await charge(deps, ws, 'reviews.fetch');
      const raw = await callPlaces(deps, key, `/v1/places/${encodeURIComponent(placeId)}`, { method: 'GET', mask: DETAILS_MASK });
      const fetchedAt = iso(deps);
      const data = normalizePlace(raw, fetchedAt);
      data.placeId = placeId;
      const ttlS = deps.config.GOOGLE_REVIEWS_CACHE_TTL_S;
      const expires = new Date(deps.now().getTime() + ttlS * 1000).toISOString();
      if (ttlS > 0) {
        await deps.db.run(
          `INSERT INTO google_places_cache (workspace_id, place_id, payload_json, fetched_at, expires_at, fail_count, circuit_until, last_error) VALUES (?, ?, ?, ?, ?, 0, NULL, NULL)${deps.db.dialect.upsert(['workspace_id', 'place_id'], 'payload_json = excluded.payload_json, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at, fail_count = 0, circuit_until = NULL, last_error = NULL')}`,
          ws, placeId, JSON.stringify(data), fetchedAt, expires,
        );
        remember(ws, placeId, data);
      }
      await deps.db.run("UPDATE google_reviews_settings SET status = 'ok', last_error = NULL, last_ok_at = ?, circuit_until = NULL WHERE workspace_id = ?", fetchedAt, ws);
      return { data, origin: 'live' };
    } catch (e) {
      if (!(e instanceof PlacesError)) throw e;
      if (e.kind !== 'quota') await recordFailure(deps, ws, placeId, e);
      deps.log.warn('google places fetch failed', { ws, kind: e.kind });
      return { data: null, origin: 'none', error: e };
    }
  });
}

/** Job `reviews.refresh`: refetch a place that is about to expire. */
export async function refreshJob(deps: Deps, payload: unknown): Promise<void> {
  const { ws, placeId } = payload as { ws?: string; placeId?: string };
  if (ws && placeId && PlaceIdSchema.safeParse(placeId).success) await getPlace(deps, ws, placeId, { force: true });
}

export async function purgeReviewCache(deps: Deps): Promise<number> {
  const r = await deps.db.run('DELETE FROM google_places_cache WHERE (expires_at IS NOT NULL AND expires_at < ?) OR (payload_json IS NULL AND (circuit_until IS NULL OR circuit_until < ?))', iso(deps), iso(deps));
  return r.changes;
}

// ---- builder: search, preview, test --------------------------------------------------------------------------------------------------------------------

export async function searchPlaces(deps: Deps, auth: Auth, input: z.infer<typeof SearchInput>) {
  const ws = auth.workspaceId;
  const { key } = await resolveKey(deps, ws);
  if (!key) throw new PlacesError('no_key', 'Add a Google API key in Settings > Integrations > Google reviews to search for places');
  await charge(deps, ws, 'reviews.search');
  await charge(deps, ws, 'reviews.fetch');
  const raw = (await callPlaces(deps, key, '/v1/places:searchText', { method: 'POST', mask: SEARCH_MASK, body: { textQuery: input.query, pageSize: 5 } })) as { places?: unknown[] };
  return {
    data: (Array.isArray(raw.places) ? raw.places : []).slice(0, 5).flatMap((x) => {
      const p = x as { id?: unknown; displayName?: { text?: unknown }; formattedAddress?: unknown; rating?: unknown; userRatingCount?: unknown };
      const id = clean(p.id, 200);
      return PlaceIdSchema.safeParse(id).success ? [{ placeId: id, name: clean(p.displayName?.text, 120), address: clean(p.formattedAddress, 200), rating: typeof p.rating === 'number' ? p.rating : null, total: typeof p.userRatingCount === 'number' ? p.userRatingCount : null }] : [];
    }),
  };
}

export async function previewPlace(deps: Deps, ws: string, placeId: string) {
  const r = await getPlace(deps, ws, placeId);
  if (!r.data) throw r.error ?? new PlacesError('upstream', 'No review data');
  return { place: { placeId, name: r.data.name, rating: r.data.rating, total: r.data.total, mapsUri: r.data.mapsUri }, reviews: r.data.reviews, origin: r.origin, fetchedAt: r.data.fetchedAt };
}

export async function testConnection(deps: Deps, auth: Auth, input: z.infer<typeof TestInput>) {
  const ws = auth.workspaceId;
  const settings = await getSettings(deps, ws);
  const placeId = input.placeId ?? settings?.default_place_id ?? '';
  if (!placeId) throw badRequest('NO_PLACE', 'Choose a default place (or pass a place id) to test with');
  const { key, source } = await resolveKey(deps, ws);
  if (!key) throw new PlacesError('no_key', 'No Google API key is configured');
  const r = await getPlace(deps, ws, placeId, { force: true });
  await audit(deps, { workspaceId: ws, actorId: auth.userId, action: 'google_reviews.test', detail: { placeId, ok: !!r.data, error: r.error?.kind ?? null, keySource: source } });
  if (!r.data) return { ok: false, keySource: source, error: { code: r.error?.code ?? 'PLACES_UPSTREAM', message: r.error?.message ?? 'No answer' } };
  return { ok: true, keySource: source, place: { placeId, name: r.data.name, rating: r.data.rating, total: r.data.total, mapsUri: r.data.mapsUri }, reviewsReturned: r.data.reviews.length };
}

// ---- pages: tokens, registration, rendering context ----------------------------------------------------------------------------------------------------

/** Public handle of a block: an HMAC of its address, so a token cannot be guessed from ids and never reveals them. */
export function tokenFor(deps: Deps, funnelId: string, stepId: string, blockId: string): string {
  return `rv${createHmac('sha256', deps.config.JWT_SECRET).update(`reviews:${funnelId}:${stepId}:${blockId}`).digest('base64url').slice(0, 24)}`;
}

function reviewNodes(doc: ProjectDoc): { id: string; place: string }[] {
  const out: { id: string; place: string }[] = [];
  walk(wrapperOf(doc.project), (n) => {
    const id = (n.attributes as Record<string, string> | undefined)?.id;
    if (n.type === 'fn-reviews' && id) out.push({ id, place: (n.fnReviews as ReviewsProps).placeId });
  });
  return out;
}

/** Called whenever a page document is stored: keeps `review_blocks` equal to the review blocks the page contains. */
export async function syncReviewBlocks(deps: Deps, ws: string, funnelId: string, stepId: string, doc: ProjectDoc): Promise<void> {
  const blocks = reviewNodes(doc);
  const at = iso(deps);
  for (const b of blocks) {
    await deps.db.run(
      `INSERT INTO review_blocks (token, workspace_id, funnel_id, step_id, block_id, place_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)${deps.db.dialect.upsert(['token'], 'place_id = excluded.place_id, updated_at = excluded.updated_at')}`,
      tokenFor(deps, funnelId, stepId, b.id), ws, funnelId, stepId, b.id, b.place, at,
    );
  }
  const keep = new Set(blocks.map((b) => b.id));
  for (const old of await deps.db.all<{ block_id: string }>('SELECT block_id FROM review_blocks WHERE step_id = ?', stepId)) if (!keep.has(old.block_id)) await deps.db.run('DELETE FROM review_blocks WHERE step_id = ? AND block_id = ?', stepId, old.block_id);
}

/** Loads cached review content (no network) for the blocks of a page into the snapshot map the synchronous renderer reads. */
export async function primeSnapshots(deps: Deps, ws: string, doc: ProjectDoc): Promise<void> {
  const nodes = reviewNodes(doc);
  let needsDefault = nodes.some((n) => !n.place);
  walk(wrapperOf(doc.project), (n) => { if (n.type === 'fn-review-cta' && !(n.fnReviewCta as ReviewCtaProps).placeId) needsDefault = true; });
  if (needsDefault || !defaults.has(ws)) defaults.set(ws, (await getSettings(deps, ws))?.default_place_id || null);
  const places = new Set(nodes.map((n) => n.place || defaults.get(ws) || '').filter(Boolean));
  for (const p of places) await getPlace(deps, ws, p, { noFetch: true });
}

/** Like `primeSnapshots`, but fetches missing or expired content first (publishing a static bundle takes its snapshot now). Failures are ignored: the bundle then carries the author's testimonials. */
export async function refreshForPublish(deps: Deps, ws: string, doc: ProjectDoc): Promise<void> {
  const nodes = reviewNodes(doc);
  if (!nodes.length) return;
  const def = (await getSettings(deps, ws))?.default_place_id || null;
  defaults.set(ws, def);
  for (const p of new Set(nodes.map((n) => n.place || def || '').filter(Boolean))) await getPlace(deps, ws, p).catch(() => undefined);
}

export function reviewsContext(deps: Deps, ws: string, funnelId: string, stepId: string): NonNullable<MarkupCtx['reviews']> {
  return {
    token: (blockId) => tokenFor(deps, funnelId, stepId, blockId),
    snapshot: (placeId) => snapshots.get(`${ws}|${placeId}`) ?? null,
    defaultPlaceId: defaults.get(ws) ?? null,
  };
}

// ---- public endpoint ---------------------------------------------------------------------------------------------------------------------------------

export interface PublicReviews { source: 'google' | 'fallback'; rating: number | null; total: number | null; mapsUri: string | null; reviews: ReviewsData['reviews']; fetchedAt: string | null; attribution: string }

/** `GET /public/reviews/:blockToken`. Unknown tokens are 404; every other failure answers 200 with `source: "fallback"` so the page keeps its static content. */
export async function publicReviews(deps: Deps, token: string): Promise<PublicReviews> {
  if (!/^rv[A-Za-z0-9_-]{24}$/.test(token)) throw notFound('Reviews');
  const row = await deps.db.get<{ workspace_id: string; place_id: string }>('SELECT workspace_id, place_id FROM review_blocks WHERE token = ?', token);
  if (!row) throw notFound('Reviews');
  const none: PublicReviews = { source: 'fallback', rating: null, total: null, mapsUri: null, reviews: [], fetchedAt: null, attribution: 'Google Maps' };
  const place = row.place_id || (await getSettings(deps, row.workspace_id))?.default_place_id || '';
  if (!place) return none;
  const r = await getPlace(deps, row.workspace_id, place);
  if (!r.data) return none;
  return { source: 'google', rating: r.data.rating, total: r.data.total, mapsUri: r.data.mapsUri, reviews: r.data.reviews, fetchedAt: r.data.fetchedAt ?? null, attribution: 'Google Maps' };
}
