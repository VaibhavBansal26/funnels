import { z } from 'zod';
import type { FormBlock, FormField } from '../blocks/index.js';
import type { Deps } from '../deps.js';
import { AppError } from '../errors.js';
import { like } from '../repos/sql.js';
import { toCsv } from '../util/csv.js';
import { newId } from '../util/ids.js';
import { addDays, isDay, startOfDayUtc } from '../util/time.js';
import { notify } from './notifications.js';
import { EMAIL_RE, resolvePublicBlock, sanitizeUtms } from './publicblocks.js';
import { fireWebhookEvent } from './webhooks.js';

export const SubmitInput = z.object({
  fields: z.record(z.string(), z.union([z.string(), z.boolean(), z.number()])).default({}),
  _hp: z.string().max(200).optional(),
  consent: z.union([z.boolean(), z.string().max(10)]).optional(),
  submissionId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional(),
  visitorId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
  utms: z.unknown().optional(),
  url: z.string().max(500).optional(),
  preview: z.boolean().optional(),
});

const MAX_FIELDS = 40;

/** Validates against the block's own field definitions. Unknown keys are dropped. Returns cleaned values or throws 422 with per-field messages. */
export function validateSubmission(block: FormBlock, raw: Record<string, string | boolean | number>, consent: unknown): Record<string, string> {
  const errors: Record<string, string> = {};
  const values: Record<string, string> = {};
  for (const f of block.fields) {
    const v = raw[f.id];
    const text = v === undefined || v === null ? '' : typeof v === 'boolean' ? (v ? 'yes' : '') : String(v).trim();
    const problem = checkField(f, text);
    if (problem) errors[f.id] = problem;
    else if (text) values[f.id] = text;
  }
  if (block.consent.enabled && !(consent === true || consent === 'yes' || consent === 'on' || raw['_consent'] === 'yes')) errors['_consent'] = 'Consent is required';
  if (Object.keys(raw).length > MAX_FIELDS) errors['_'] = 'Too many fields';
  if (Object.keys(errors).length) throw new AppError(422, 'VALIDATION_ERROR', 'Please correct the highlighted fields', { fields: errors });
  return values;
}

function checkField(f: FormField, text: string): string | null {
  if (!text) return f.required ? `${f.label} is required` : null;
  const max = f.maxLength ?? (f.type === 'textarea' ? 5000 : 255);
  if (text.length > max) return `${f.label} must be at most ${max} characters`;
  switch (f.type) {
    case 'email':
      return EMAIL_RE.test(text) && text.length <= 254 ? null : 'Enter a valid email address';
    case 'phone': {
      const digits = text.replace(/\D/g, '');
      return /^[0-9+()\-.\s]+$/.test(text) && digits.length >= 5 && digits.length <= 15 ? null : 'Enter a valid phone number';
    }
    case 'select':
      return f.options?.includes(text) ? null : `Choose one of the listed options for ${f.label}`;
    case 'checkbox':
      return text === 'yes' ? null : `Invalid value for ${f.label}`;
    default:
      return null;
  }
}

interface LeadRow {
  id: string;
  workspace_id: string;
  email: string;
  name: string | null;
  phone: string | null;
  data_json: string;
  first_funnel_id: string | null;
  submissions: number;
  created_at: string;
  updated_at: string;
}

/** Dedupe by email within the workspace: later submissions update the same lead instead of creating a new one. */
export function upsertLead(deps: Deps, ws: string, lead: { email: string; name?: string | null; phone?: string | null; data?: Record<string, string>; funnelId: string; countSubmission?: boolean }): { id: string; created: boolean } {
  const email = lead.email.toLowerCase();
  const at = deps.now().toISOString();
  const existing = deps.db.get<LeadRow>('SELECT * FROM leads WHERE workspace_id = ? AND email = ?', ws, email);
  if (existing) {
    const merged = { ...(JSON.parse(existing.data_json) as Record<string, string>), ...(lead.data ?? {}) };
    deps.db.run(
      'UPDATE leads SET name = ?, phone = ?, data_json = ?, submissions = submissions + ?, updated_at = ? WHERE id = ?',
      lead.name || existing.name, lead.phone || existing.phone, JSON.stringify(merged), lead.countSubmission === false ? 0 : 1, at, existing.id,
    );
    return { id: existing.id, created: false };
  }
  const id = newId('lead');
  deps.db.run(
    'INSERT INTO leads (id, workspace_id, email, name, phone, data_json, first_funnel_id, submissions, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, ws, email, lead.name ?? null, lead.phone ?? null, JSON.stringify(lead.data ?? {}), lead.funnelId, lead.countSubmission === false ? 0 : 1, at, at,
  );
  return { id, created: true };
}

export interface SubmitResult {
  ok: true;
  recorded: boolean;
  duplicate?: boolean;
  leadId?: string;
}

export function submitForm(deps: Deps, p: { funnelId: string; stepId: string; blockId: string; input: z.infer<typeof SubmitInput> }): SubmitResult {
  const { funnel, step, block, workspaceId: ws } = resolvePublicBlock(deps, p.funnelId, p.stepId, p.blockId, 'form');
  // Bots fill the hidden field: pretend success so they learn nothing, store nothing.
  if (p.input._hp) return { ok: true, recorded: false };
  const values = validateSubmission(block, p.input.fields, p.input.consent ?? p.input.fields['_consent']);
  if (p.input.preview) return { ok: true, recorded: false };

  const emailField = block.fields.find((f) => f.type === 'email')!;
  const email = values[emailField.id];
  if (!email) throw new AppError(422, 'VALIDATION_ERROR', 'Please correct the highlighted fields', { fields: { [emailField.id]: 'An email address is required' } });
  const nameField = block.fields.find((f) => f.type === 'name');
  const phoneField = block.fields.find((f) => f.type === 'phone');

  const result = deps.db.tx((): SubmitResult => {
    const externalId = p.input.submissionId ? `form:${block.id}:${p.input.submissionId}` : null;
    if (externalId && deps.db.get('SELECT 1 FROM events WHERE funnel_id = ? AND type = ? AND external_id = ?', funnel.id, 'optin', externalId)) {
      return { ok: true, recorded: false, duplicate: true };
    }
    const lead = upsertLead(deps, ws, { email, name: nameField ? values[nameField.id] : null, phone: phoneField ? values[phoneField.id] : null, data: values, funnelId: funnel.id });
    deps.db.run(
      `INSERT INTO events (id, workspace_id, funnel_id, step_id, type, visitor_id, unique_visit, lead_id, external_id, utm_json, url, created_at)
       VALUES (?, ?, ?, ?, 'optin', ?, 0, ?, ?, ?, ?, ?)`,
      newId('evt'), ws, funnel.id, step.id, p.input.visitorId ?? null, lead.id, externalId, JSON.stringify(sanitizeUtms(p.input.utms)), p.input.url?.slice(0, 500) ?? null, deps.now().toISOString(),
    );
    notify(deps, ws, { type: 'new_lead', title: 'New lead', body: `${email} opted in on ${funnel.name}`, data: { leadId: lead.id, funnelId: funnel.id, stepId: step.id } });
    fireWebhookEvent(deps, ws, 'funnel.optin', {
      funnel: { id: funnel.id, name: funnel.name },
      step: { id: step.id, name: step.name },
      lead: { id: lead.id, email, name: nameField ? (values[nameField.id] ?? null) : null, phone: phoneField ? (values[phoneField.id] ?? null) : null },
      fields: values,
    });
    return { ok: true, recorded: true, leadId: lead.id };
  });
  return result;
}

export const LeadQuery = z.object({
  search: z.string().max(100).optional(),
  funnelId: z.string().max(64).optional(),
  from: z.string().refine(isDay, 'Use YYYY-MM-DD').optional(),
  to: z.string().refine(isDay, 'Use YYYY-MM-DD').optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

function leadFilter(ws: string, q: z.infer<typeof LeadQuery>) {
  const where = ['l.workspace_id = ?'];
  const params: (string | number)[] = [ws];
  if (q.search?.trim()) {
    where.push(`(l.email LIKE ? ESCAPE '\\' OR l.name LIKE ? ESCAPE '\\')`);
    params.push(like(q.search.trim()), like(q.search.trim()));
  }
  if (q.funnelId) {
    where.push('EXISTS (SELECT 1 FROM events e WHERE e.lead_id = l.id AND e.funnel_id = ? AND e.workspace_id = l.workspace_id)');
    params.push(q.funnelId);
  }
  if (q.from) {
    where.push('l.created_at >= ?');
    params.push(startOfDayUtc(q.from, 'UTC').toISOString());
  }
  if (q.to) {
    where.push('l.created_at < ?');
    params.push(startOfDayUtc(addDays(q.to, 1), 'UTC').toISOString());
  }
  return { clause: where.join(' AND '), params };
}

const serializeLead = (l: LeadRow & { funnel_name: string | null }) => ({
  id: l.id, email: l.email, name: l.name, phone: l.phone, data: JSON.parse(l.data_json) as Record<string, string>,
  firstFunnelId: l.first_funnel_id, firstFunnelName: l.funnel_name, submissions: l.submissions, createdAt: l.created_at, updatedAt: l.updated_at,
});

export function listLeads(deps: Deps, ws: string, q: z.infer<typeof LeadQuery>) {
  const { clause, params } = leadFilter(ws, q);
  const total = deps.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM leads l WHERE ${clause}`, ...params)!.n;
  const rows = deps.db.all<LeadRow & { funnel_name: string | null }>(
    `SELECT l.*, f.name AS funnel_name FROM leads l LEFT JOIN funnels f ON f.id = l.first_funnel_id WHERE ${clause} ORDER BY l.created_at DESC, l.rowid DESC LIMIT ? OFFSET ?`,
    ...params, q.limit, (q.page - 1) * q.limit,
  );
  return { data: rows.map(serializeLead), pagination: { page: q.page, limit: q.limit, total, totalPages: Math.max(1, Math.ceil(total / q.limit)) } };
}

export function leadsCsv(deps: Deps, ws: string, q: z.infer<typeof LeadQuery>): string {
  const { clause, params } = leadFilter(ws, q);
  const rows = deps.db.all<LeadRow & { funnel_name: string | null }>(
    `SELECT l.*, f.name AS funnel_name FROM leads l LEFT JOIN funnels f ON f.id = l.first_funnel_id WHERE ${clause} ORDER BY l.created_at DESC, l.rowid DESC LIMIT 50000`, ...params,
  );
  return toCsv(['Email', 'Name', 'Phone', 'First funnel', 'Submissions', 'Created', 'Last activity'], rows.map((l) => [l.email, l.name, l.phone, l.funnel_name, l.submissions, l.created_at, l.updated_at]));
}
