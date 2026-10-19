import type { Deps } from '../deps.js';
import { notFound } from '../errors.js';
import { newId } from '../util/ids.js';

interface Row {
  id: string;
  type: string;
  title: string;
  body: string;
  data_json: string;
  read_at: string | null;
  created_at: string;
}

const serialize = (r: Row) => ({ id: r.id, type: r.type, title: r.title, body: r.body, data: JSON.parse(r.data_json) as unknown, readAt: r.read_at, createdAt: r.created_at });

/** Stores an in-app notification and pushes it to connected SSE clients of the workspace. */
export async function notify(deps: Deps, ws: string, n: { type: 'new_lead' | 'new_sale'; title: string; body: string; data: Record<string, unknown> }) {
  const id = newId('ntf');
  const at = deps.now().toISOString();
  await deps.db.run('INSERT INTO notifications (id, workspace_id, type, title, body, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, ws, n.type, n.title, n.body, JSON.stringify(n.data), at);
  const row = serialize({ id, type: n.type, title: n.title, body: n.body, data_json: JSON.stringify(n.data), read_at: null, created_at: at });
  deps.bus.publish(ws, { type: 'notification', data: row });
  return row;
}

export async function listNotifications(deps: Deps, ws: string, limit = 50) {
  const rows = await deps.db.all<Row>('SELECT * FROM notifications WHERE workspace_id = ? ORDER BY created_at DESC, id DESC LIMIT ?', ws, Math.min(Math.max(limit, 1), 100));
  const unread = (await deps.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM notifications WHERE workspace_id = ? AND read_at IS NULL', ws))!.n;
  return { data: rows.map(serialize), unread };
}

export async function markRead(deps: Deps, ws: string, id: string): Promise<void> {
  const r = await deps.db.run('UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE workspace_id = ? AND id = ?', deps.now().toISOString(), ws, id);
  if (r.changes === 0) throw notFound('Notification');
}

export async function markAllRead(deps: Deps, ws: string): Promise<void> {
  await deps.db.run('UPDATE notifications SET read_at = ? WHERE workspace_id = ? AND read_at IS NULL', deps.now().toISOString(), ws);
}
