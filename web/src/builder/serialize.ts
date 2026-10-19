import { parseDocument, renderPage, type PageDocument } from '@blocks';

export type SaveCheck = { ok: true; doc: PageDocument; body: { doc: PageDocument; version: number; backup: boolean } } | { ok: false; issues: { path: string; message: string }[] };

/**
 * Validates the editor document with the shared schema (the same one the server applies) and builds the save request.
 * `version` is the step version the editor loaded, which gives optimistic-concurrency protection on the server.
 */
export function prepareSave(doc: unknown, version: number, backup: boolean): SaveCheck {
  const r = parseDocument(doc);
  if (!r.ok) return { ok: false, issues: r.issues };
  return { ok: true, doc: r.doc, body: { doc: r.doc, version, backup } };
}

/** JSON round trip used by save/load: what the server stores must render exactly as what the editor shows. */
export function roundTrip(doc: PageDocument): { doc: PageDocument; identical: boolean } {
  const parsed = parseDocument(JSON.parse(JSON.stringify(doc)));
  if (!parsed.ok) throw new Error(`Document does not survive a save/load round trip: ${parsed.issues[0]?.message}`);
  const ctx = { funnelId: 'f', stepId: 's', stepName: 'x', mode: 'builder' as const };
  return { doc: parsed.doc, identical: renderPage(doc, ctx) === renderPage(parsed.doc, ctx) };
}

/** Human-readable issue list for the "fix before saving" panel. */
export function describeIssues(issues: { path: string; message: string }[]): string[] {
  return issues.slice(0, 8).map((i) => (i.path ? `${i.path.replace(/\./g, ' › ')}: ${i.message}` : i.message));
}
