import { CreditCard } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useMutate, usePaymentsStatus } from '../../api/hooks';
import type { PaymentsStatus } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { useToast } from '../../components/Toasts';
import { ConfirmDialog, CopyButton, ErrorBanner, Loading, TextField } from '../../components/ui';
import { Badge, Button, Switch } from '../../ui';

const STATE: Record<PaymentsStatus['state'], { tone: 'ok' | 'warn' | 'danger' | 'neutral'; label: string }> = {
  unavailable: { tone: 'neutral', label: 'Not available' }, not_connected: { tone: 'neutral', label: 'Not connected' }, onboarding_incomplete: { tone: 'warn', label: 'Onboarding incomplete' },
  restricted: { tone: 'danger', label: 'Charges disabled' }, connected: { tone: 'ok', label: 'Connected' },
};

/** Settings > Payments: the Stripe connection, test or live mode, what the account can do, checkout settings and the Stripe test cards. */
export function Payments() {
  const { can } = useAuth();
  const manage = can('billing:manage');
  const toast = useToast();
  const q = usePaymentsStatus();
  const s = q.data;
  const [descriptor, setDescriptor] = useState('');
  const [receipts, setReceipts] = useState(true);
  const [tax, setTax] = useState(false);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (!s) return;
    setDescriptor(s.settings.statementDescriptor ?? '');
    setReceipts(s.settings.receiptEmails);
    setTax(s.settings.taxEnabled);
  }, [s]);
  const go = useMutate((path: string) => api.post<{ url: string }>(path).then((r) => { window.location.assign(r.url); return r; }), [['payments']]);
  const disconnect = useMutate(() => api.post('/api/billing/connect/disconnect'), [['payments'], ['billing'], ['products']]);
  const save = useMutate(() => api.patch('/api/payments/settings', { statementDescriptor: descriptor.trim() || null, receiptEmails: receipts, taxEnabled: tax }), [['payments']]);
  const descriptorErr = /^[A-Za-z0-9 ]{0,22}$/.test(descriptor) ? undefined : 'Up to 22 letters, digits and spaces';
  const st = s ? STATE[s.state] : null;
  return (
    <section className="card stack" aria-label="Payments" id="payments">
      <div className="row between"><h2><CreditCard className="mr-1.5 inline size-5 align-text-bottom" aria-hidden="true" />Payments</h2>{st ? <Badge tone={st.tone}>{st.label}</Badge> : null}</div>
      {q.isLoading ? <Loading rows={2} /> : null}
      <ErrorBanner error={q.error ?? go.error ?? disconnect.error ?? save.error} onRetry={() => void q.refetch()} />
      {s ? (
        <>
          {s.mode === 'test' ? <div className="alert warn" role="status"><strong>Test mode.</strong> No real money moves. Use the Stripe test cards below to try a purchase.</div> : null}
          {s.mode === 'live' ? <div className="alert ok" role="status"><strong>Live mode.</strong> Payments are real and settle to your Stripe account.</div> : null}
          {s.mode === null ? <div className="alert" role="status">Stripe is not configured on this installation, so checkouts run in built-in test mode: orders are recorded but no card is charged.</div> : null}
          {s.stale ? <div className="alert warn" role="status">Stripe did not answer just now: this is the last state we saw.</div> : null}
          {s.state === 'not_connected' ? <p className="m-0">Connect your Stripe account to take payments in your funnels. Money goes straight to your account.</p> : null}
          {s.state === 'onboarding_incomplete' ? <p className="m-0">Stripe still needs details before you can take payments{s.connect?.requirementsDue.length ? `: ${s.connect.requirementsDue.map((r) => r.replace(/_/g, ' ')).join(', ')}` : ''}.</p> : null}
          {s.state === 'restricted' ? <p className="m-0">Stripe has disabled charges{s.connect?.disabledReason ? ` (${s.connect.disabledReason.replace(/[._]/g, ' ')})` : ''}. Open your Stripe dashboard to resolve it.</p> : null}
          {s.connect ? (
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
              <div><dt className="text-muted">Account</dt><dd className="m-0"><code>{s.connect.accountId}</code></dd></div>
              <div><dt className="text-muted">Charges</dt><dd className="m-0"><Badge tone={s.connect.chargesEnabled ? 'ok' : 'warn'}>{s.connect.chargesEnabled ? 'Enabled' : 'Not enabled'}</Badge></dd></div>
              <div><dt className="text-muted">Payouts</dt><dd className="m-0"><Badge tone={s.connect.payoutsEnabled ? 'ok' : 'warn'}>{s.connect.payoutsEnabled ? 'Enabled' : 'Not enabled'}</Badge></dd></div>
              {s.account ? (
                <>
                  <div><dt className="text-muted">Country · currency</dt><dd className="m-0">{s.account.country ?? 'Unknown'} · {s.account.currency ?? 'Unknown'}</dd></div>
                  <div><dt className="text-muted">Statement descriptor</dt><dd className="m-0">{s.account.statementDescriptor ?? 'Not set in Stripe'}</dd></div>
                  <div><dt className="text-muted">Payment methods</dt><dd className="m-0 flex flex-wrap gap-1">{s.account.paymentMethods.length ? s.account.paymentMethods.map((m) => <Badge key={m}>{m}</Badge>) : <span className="text-muted">None active yet</span>}</dd></div>
                </>
              ) : null}
            </dl>
          ) : null}
          {manage && s.state !== 'unavailable' ? (
            <div className="row">
              <Button variant={s.state === 'connected' ? 'default' : 'primary'} disabled={go.isPending} onClick={() => go.mutate('/api/billing/connect/start')}>{s.state === 'not_connected' ? 'Connect Stripe' : s.state === 'connected' ? 'Open Stripe settings' : 'Continue onboarding'}</Button>
              {s.connect ? <Button variant="danger" onClick={() => setConfirm(true)}>Disconnect</Button> : null}
            </div>
          ) : null}
          {!manage ? <p className="muted small m-0">You need the billing:manage permission to connect or change payment settings.</p> : null}

          {s.state !== 'unavailable' ? (
            <form className="stack" onSubmit={(e) => { e.preventDefault(); if (!descriptorErr) save.mutate(undefined, { onSuccess: () => toast.push('Payment settings saved', 'ok') }); }}>
              <h3>Checkout settings</h3>
              <TextField label="Statement descriptor suffix" value={descriptor} onChange={setDescriptor} disabled={!manage} error={descriptorErr} maxLength={40} hint="Appended to your Stripe statement descriptor on card statements (22 characters at most). Leave empty to use your account default." />
              <label className="flex items-center gap-2 text-sm font-medium"><Switch checked={receipts} disabled={!manage} onCheckedChange={setReceipts} aria-label="Email receipts" /> Ask Stripe to email a receipt for each payment</label>
              <label className="flex items-center gap-2 text-sm font-medium"><Switch checked={tax} disabled={!manage || !s.account?.taxAvailable} onCheckedChange={setTax} aria-label="Calculate tax with Stripe Tax" /> Calculate tax with Stripe Tax</label>
              <p className="muted small m-0">{s.account?.taxAvailable ? 'Stripe Tax is set up on your account: it adds tax at checkout. Tax is not counted as revenue.' : 'Stripe Tax is not set up on the connected account. Enable it in your Stripe dashboard to turn this on.'}</p>
              {manage ? <div><Button variant="primary" type="submit" disabled={save.isPending || !!descriptorErr}>{save.isPending ? 'Saving…' : 'Save settings'}</Button></div> : null}
            </form>
          ) : null}

          {s.testCards.length ? (
            <div className="stack">
              <h3>Stripe test cards</h3>
              <p className="muted small m-0">Use any future expiry date, any 3-digit CVC and any postal code. They only work in test mode.</p>
              <table className="table"><caption className="sr-only">Stripe test cards</caption>
                <thead><tr><th scope="col">Card number</th><th scope="col">What happens</th><th scope="col"><span className="sr-only">Copy</span></th></tr></thead>
                <tbody>{s.testCards.map((c) => <tr key={c.number}><td><code>{c.number}</code></td><td><strong>{c.outcome}.</strong> <span className="muted small">{c.note}</span></td><td><CopyButton text={c.number.replace(/ /g, '')} label="Copy" /></td></tr>)}</tbody>
              </table>
            </div>
          ) : null}
          {confirm ? <ConfirmDialog title="Disconnect Stripe?" message="Funnels stop taking payments through this account until you connect again. Products stay in your catalog; your Stripe account itself is untouched (revoke access in the Stripe dashboard)." confirmLabel="Disconnect" danger busy={disconnect.isPending} onCancel={() => setConfirm(false)} onConfirm={() => disconnect.mutate(undefined, { onSuccess: () => { setConfirm(false); toast.push('Stripe disconnected', 'ok'); } })} /> : null}
        </>
      ) : null}
    </section>
  );
}
