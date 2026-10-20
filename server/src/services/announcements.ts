import { z } from 'zod';
import type { Auth } from '../auth/context.js';
import type { Deps } from '../deps.js';
import { conflict, notFound } from '../errors.js';
import { newId } from '../util/ids.js';
import { audit } from './audit.js';

/** Announcements (docs/ADMIN.md): messages every signed-in user sees as a banner while they are active. Critical ones cannot be dismissed. */
const LEVELS = ['info', 'warning', 'critical'] as const;
export const AnnouncementInput = z.object({
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(1000),
  level: z.enum(LEVELS).default('info'),
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().nullable().optional(),
});
export const AnnouncementPatch = AnnouncementInput.partial();

interface Row { id: string; title: string; body: string; level: (typeof LEVELS)[number]; starts_at: string; ends_at: string | null; created_by: string; created_at: string }
const view = (r: Row) => ({ id: r.id, title: r.title, body: r.body, level: r.level, startsAt: r.starts_at, endsAt: r.ends_at, createdBy: r.created_by, createdAt: r.created_at, dismissible: r.level !== 'critical' });

function checkWindow(startsAt: string, endsAt: string | null) {
  if (endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) throw conflict('INVALID_WINDOW', 'The end must be after the start');
}

export async function listAll(deps: Deps) {
  return { data: (await deps.db.all<Row>('SELECT * FROM announcements ORDER BY starts_at DESC, id DESC LIMIT 200')).map(view) };
}

export async function create(deps: Deps, auth: Auth, input: z.infer<typeof AnnouncementInput>, ip?: string) {
  const at = deps.now().toISOString();
  const startsAt = input.startsAt ?? at;
  checkWindow(startsAt, input.endsAt ?? null);
  const id = newId('ann');
  await deps.db.run('INSERT INTO announcements (id, title, body, level, starts_at, ends_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, input.title, input.body, input.level, startsAt, input.endsAt ?? null, auth.userId, at);
  await audit(deps, { workspaceId: null, actorId: auth.userId, action: 'admin.announcement.created', target: id, detail: { title: input.title, level: input.level }, ip });
  return view((await deps.db.get<Row>('SELECT * FROM announcements WHERE id = ?', id))!);
}

export async function update(deps: Deps, auth: Auth, id: string, patch: z.infer<typeof AnnouncementPatch>, ip?: string) {
  const cur = await deps.db.get<Row>('SELECT * FROM announcements WHERE id = ?', id);
  if (!cur) throw notFound('Announcement');
  const next = { title: patch.title ?? cur.title, body: patch.body ?? cur.body, level: patch.level ?? cur.level, startsAt: patch.startsAt ?? cur.starts_at, endsAt: patch.endsAt === undefined ? cur.ends_at : patch.endsAt };
  checkWindow(next.startsAt, next.endsAt);
  await deps.db.run('UPDATE announcements SET title = ?, body = ?, level = ?, starts_at = ?, ends_at = ? WHERE id = ?', next.title, next.body, next.level, next.startsAt, next.endsAt, id);
  await audit(deps, { workspaceId: null, actorId: auth.userId, action: 'admin.announcement.updated', target: id, ip });
  return view((await deps.db.get<Row>('SELECT * FROM announcements WHERE id = ?', id))!);
}

export async function remove(deps: Deps, auth: Auth, id: string, ip?: string): Promise<void> {
  const { changes } = await deps.db.run('DELETE FROM announcements WHERE id = ?', id);
  if (changes === 0) throw notFound('Announcement');
  await audit(deps, { workspaceId: null, actorId: auth.userId, action: 'admin.announcement.deleted', target: id, ip });
}

/** What this user should see right now: active, and not dismissed by them. */
export async function activeFor(deps: Deps, userId: string) {
  const now = deps.now().toISOString();
  const rows = await deps.db.all<Row>(
    `SELECT a.* FROM announcements a WHERE a.starts_at <= ? AND (a.ends_at IS NULL OR a.ends_at > ?)
       AND NOT EXISTS (SELECT 1 FROM announcement_dismissals d WHERE d.announcement_id = a.id AND d.user_id = ?)
     ORDER BY CASE a.level WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, a.starts_at DESC, a.id LIMIT 20`,
    now, now, userId,
  );
  return { data: rows.map(view) };
}

export async function dismiss(deps: Deps, userId: string, id: string): Promise<void> {
  const a = await deps.db.get<Row>('SELECT * FROM announcements WHERE id = ?', id);
  if (!a) throw notFound('Announcement');
  if (a.level === 'critical') throw conflict('NOT_DISMISSIBLE', 'Critical announcements stay until they end');
  await deps.db.run(`INSERT INTO announcement_dismissals (announcement_id, user_id, dismissed_at) VALUES (?, ?, ?)${deps.db.dialect.onConflictDoNothing()}`, id, userId, deps.now().toISOString());
}
