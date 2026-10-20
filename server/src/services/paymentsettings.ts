import { z } from 'zod';
import type { Auth } from '../auth/context.js';
import type { Deps } from '../deps.js';
import { audit } from './audit.js';

export interface PaymentSettings {
  statementDescriptor: string | null;
  receiptEmails: boolean;
  taxEnabled: boolean;
}

export const PaymentSettingsPatch = z.object({
  statementDescriptor: z.string().trim().regex(/^[A-Za-z0-9 ]{0,22}$/, 'Up to 22 letters, digits and spaces').nullable().optional(),
  receiptEmails: z.boolean().optional(),
  taxEnabled: z.boolean().optional(),
});

export async function paymentSettings(deps: Deps, ws: string): Promise<PaymentSettings> {
  const r = await deps.db.get<{ statement_descriptor: string | null; receipt_emails: number; tax_enabled: number }>('SELECT statement_descriptor, receipt_emails, tax_enabled FROM payment_settings WHERE workspace_id = ?', ws);
  return { statementDescriptor: r?.statement_descriptor ?? null, receiptEmails: (r?.receipt_emails ?? 1) === 1, taxEnabled: r?.tax_enabled === 1 };
}

export async function updatePaymentSettings(deps: Deps, auth: Auth, patch: z.infer<typeof PaymentSettingsPatch>, ip?: string): Promise<PaymentSettings> {
  const cur = await paymentSettings(deps, auth.workspaceId);
  const next: PaymentSettings = {
    statementDescriptor: patch.statementDescriptor === undefined ? cur.statementDescriptor : patch.statementDescriptor || null,
    receiptEmails: patch.receiptEmails ?? cur.receiptEmails,
    taxEnabled: patch.taxEnabled ?? cur.taxEnabled,
  };
  await deps.db.run(
    `INSERT INTO payment_settings (workspace_id, statement_descriptor, receipt_emails, tax_enabled, updated_at) VALUES (?, ?, ?, ?, ?)${deps.db.dialect.upsert(['workspace_id'], 'statement_descriptor = excluded.statement_descriptor, receipt_emails = excluded.receipt_emails, tax_enabled = excluded.tax_enabled, updated_at = excluded.updated_at')}`,
    auth.workspaceId, next.statementDescriptor, next.receiptEmails ? 1 : 0, next.taxEnabled ? 1 : 0, deps.now().toISOString(),
  );
  await audit(deps, { workspaceId: auth.workspaceId, actorId: auth.userId, action: 'payments.settings_changed', ip, detail: { ...next } });
  return next;
}
