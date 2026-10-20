import type { Deps } from '../deps.js';
import { emptyDoc, normalizeDoc } from '../pagemodel/doc.js';
import { regenerateFunnel } from './pages.js';

/**
 * One-time (idempotent) conversion of legacy block documents (version 1) to GrapesJS project documents (version 2).
 * Runs at startup: after it, no stored page needs the old block renderer. The original document is kept in `legacy_doc_json`.
 * Backups are converted lazily when they are read or restored (they are history, not served).
 */
const V2 = `doc_json NOT LIKE '{"version":2%'`;

export async function migrateLegacyPages(deps: Deps): Promise<{ pages: number; templateSteps: number; funnels: number }> {
  let pages = 0;
  const touched = new Map<string, string>(); // funnel id -> workspace id
  for (;;) {
    const rows = await deps.db.all<{ step_id: string; workspace_id: string; funnel_id: string; doc_json: string }>(
      `SELECT step_id, workspace_id, funnel_id, doc_json FROM step_pages WHERE ${V2} ORDER BY step_id LIMIT 100`,
    );
    if (rows.length === 0) break;
    for (const r of rows) {
      let raw: unknown = null;
      try {
        raw = JSON.parse(r.doc_json);
      } catch {
        /* unreadable: becomes an empty page below */
      }
      const res = normalizeDoc(raw, { scriptsOk: true });
      if (!res.ok) deps.log.warn('legacy page could not be converted, replaced by an empty page', { stepId: r.step_id, issues: res.issues.slice(0, 3) });
      const doc = res.ok ? res.doc : emptyDoc();
      const done = await deps.db.run('UPDATE step_pages SET doc_json = ?, legacy_doc_json = COALESCE(legacy_doc_json, ?) WHERE step_id = ? AND doc_json = ?', JSON.stringify(doc), r.doc_json, r.step_id, r.doc_json);
      if (done.changes) pages++;
      touched.set(r.funnel_id, r.workspace_id);
    }
  }
  let templateSteps = 0;
  for (;;) {
    const rows = await deps.db.all<{ id: string; doc_json: string }>(`SELECT id, doc_json FROM template_steps WHERE ${V2} LIMIT 100`);
    if (rows.length === 0) break;
    for (const r of rows) {
      let raw: unknown = null;
      try {
        raw = JSON.parse(r.doc_json);
      } catch {
        /* empty page */
      }
      const res = normalizeDoc(raw, { scriptsOk: false });
      const done = await deps.db.run('UPDATE template_steps SET doc_json = ? WHERE id = ? AND doc_json = ?', JSON.stringify(res.ok ? res.doc : emptyDoc()), r.id, r.doc_json);
      if (done.changes) templateSteps++;
    }
  }
  // Re-render the converted funnels so published pages use the new renderer (and pick up the new base design).
  for (const [funnelId, ws] of touched) await regenerateFunnel(deps, ws, funnelId);
  return { pages, templateSteps, funnels: touched.size };
}
