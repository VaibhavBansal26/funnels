import { Copy, Download, Sparkles } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api, downloadFile } from '../api/client';
import { useMutate, useProductAnalytics } from '../api/hooks';
import type { PeriodSummary, ProductReport, ProductRow } from '../api/types';
import { Badge, Button, Select } from '../ui';
import { LineChart } from './Charts';
import { Sparkline } from './Sparkline';
import { useToast } from './Toasts';
import { Empty, ErrorBanner, fmtMoney, fmtNum, fmtPct, Loading, Modal } from './ui';

const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => iso(new Date(Date.now() - n * 86_400_000));
export const pct = (fraction: number) => fmtPct(fraction * 100);

/** CSV text for the table on screen is produced by the server (formula-injection neutralised there); this is the file name. */
const exportName = (from: string, to: string) => `products-${from}-to-${to}.csv`;

function SummaryCard({ scope, funnelId, productId, range, tz, currency, title = 'Summarise this period' }: { scope: 'workspace' | 'funnel' | 'product'; funnelId?: string; productId?: string; range: { from: string; to: string }; tz: string; currency?: string; title?: string }) {
  const toast = useToast();
  const run = useMutate(() => api.post<PeriodSummary>('/api/analytics/summary', { scope, funnelId, productId, from: range.from, to: range.to, tz, currency: currency || undefined }));
  const d = run.data;
  const text = d ? `${d.narrative}\n\n${d.actions.map((a) => `${a.priority}. ${a.title}: ${a.detail}`).join('\n')}` : '';
  return (
    <section className="card stack" aria-label="Period summary">
      <div className="row between">
        <div><h2>{title}</h2><span className="muted small">Every number comes from your orders; the writer only explains them, and any number it adds is thrown away.</span></div>
        <Button variant="primary" disabled={run.isPending} onClick={() => run.mutate(undefined)}><Sparkles /> {run.isPending ? 'Summarising…' : d ? 'Summarise again' : 'Summarise this period'}</Button>
      </div>
      <ErrorBanner error={run.error} />
      {d ? (
        <div className="stack">
          <p data-testid="summary-narrative">{d.narrative}</p>
          <ol className="m-0 flex list-none flex-col gap-2 p-0">
            {d.actions.map((a) => (
              <li key={a.priority} className="flex gap-3"><Badge tone={a.priority === 1 ? 'danger' : a.priority === 2 ? 'warn' : 'info'}>Priority {a.priority}</Badge><span><strong>{a.title}.</strong> {a.detail}</span></li>
            ))}
          </ol>
          <div className="row between">
            <span className="muted small">{d.source === 'model' ? 'Written by the AI model, numbers verified' : d.source === 'fallback' ? 'The model answer was rejected (it contained a number that is not in your data): written by the built-in analyst' : 'Written by the built-in analyst'}</span>
            <Button size="sm" onClick={() => { void navigator.clipboard?.writeText(text); toast.push('Summary copied', 'ok'); }}><Copy /> Copy</Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function Detail({ row, report, onClose, range, tz }: { row: ProductRow; report: ProductReport; onClose: () => void; range: { from: string; to: string }; tz: string }) {
  const series = row.series.map((p) => ({ date: p.t.slice(0, 10), gross: p.gross, net: p.net, orders: p.orders }));
  const rate = (r: { offered: number; taken: number; rate: number }) => (r.offered ? `${pct(r.rate)} (${r.taken} of ${r.offered})` : 'Not offered');
  const money = (n: number) => fmtMoney(n, row.currency);
  return (
    <Modal side title={`${row.name} (${row.currency})`} onClose={onClose}>
      <div className="flex flex-col gap-5" aria-label={`Details of ${row.name}`}>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          {([['Orders', fmtNum(row.orders)], ['Units', fmtNum(row.units)], ['Gross', money(row.gross)], ['Refunded', money(row.refunded)], ['Lost to disputes', money(row.disputedLost)], ['Net revenue', money(row.net)], ['Average order', money(row.aov)], ['Refund rate', pct(row.refundRate)], ['Checkout conversion', `${pct(row.checkout.conversion)} (${row.checkout.orders} of ${fmtNum(row.checkout.visitors)} visitors)`], ['Order bump taken', rate(row.takeRates.bump)], ['Upsell taken', rate(row.takeRates.upsell)], ['Downsell taken', rate(row.takeRates.downsell)], ['New customers', fmtNum(row.customers.new)], ['Repeat customers', fmtNum(row.customers.repeat)]] as const).map(([k, v]) => (
            <div key={k}><dt className="text-muted">{k}</dt><dd className="m-0 font-semibold">{v}</dd></div>
          ))}
        </dl>
        <LineChart title={`Revenue trend for ${row.name}`} data={series} lines={[{ key: 'gross', label: 'Gross', color: '#2563eb' }, { key: 'net', label: 'Net', color: '#16a34a' }]} valueFormat={(n) => fmtMoney(n, row.currency)} />
        <section aria-label="Funnels">
          <h3 className="m-0 mb-2 text-sm font-semibold">Where it sells</h3>
          {row.topFunnels.length === 0 ? <p className="muted small m-0">No funnel sold it in this period.</p> : (
            <table className="table"><caption className="sr-only">Funnel breakdown for {row.name}</caption>
              <thead><tr><th scope="col">Funnel</th><th scope="col" className="num">Orders</th><th scope="col" className="num">Gross</th><th scope="col" className="num">Net</th></tr></thead>
              <tbody>{row.topFunnels.map((f) => <tr key={f.funnelId}><td>{f.name}</td><td className="num">{fmtNum(f.orders)}</td><td className="num">{money(f.gross)}</td><td className="num">{money(f.net)}</td></tr>)}</tbody>
            </table>
          )}
          {row.topSteps.length ? <p className="muted small mt-2 mb-0">Top steps: {row.topSteps.map((s) => `${s.name} in ${s.funnelName} (${money(s.gross)})`).join(', ')}</p> : null}
        </section>
        {row.productId ? <SummaryCard scope="product" productId={row.productId} range={range} tz={tz} currency={row.currency} title="Summarise this product" /> : null}
        <span className="sr-only">{report.range.from}</span>
      </div>
    </Modal>
  );
}

/**
 * Product analytics: totals per currency (never added together), the revenue trend, a table with a sparkline per product, a detail drawer with the funnel
 * breakdown, CSV export and the "Summarise this period" card. Used workspace-wide (Products page) and per funnel (funnel analytics tab).
 */
export function ProductAnalytics({ funnelId }: { funnelId?: string }) {
  const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', []);
  const [range, setRange] = useState({ from: daysAgo(29), to: iso(new Date()) });
  const [currency, setCurrency] = useState('');
  const [open, setOpen] = useState<ProductRow | null>(null);
  const toast = useToast();
  const q = useProductAnalytics({ from: range.from, to: range.to, tz, currency: currency || undefined }, funnelId);
  const r = q.data;
  const currencies = r?.totals.map((t) => t.currency) ?? [];
  const shown = currency ? r?.totals.filter((t) => t.currency === currency) ?? [] : r?.totals ?? [];
  const ok = range.from <= range.to;
  return (
    <div className="stack">
      <div className="filters" role="group" aria-label="Date range">
        <div className="field"><label htmlFor="pa-from">From</label><input id="pa-from" type="date" className="input" value={range.from} max={range.to} onChange={(e) => setRange({ ...range, from: e.target.value })} /></div>
        <div className="field"><label htmlFor="pa-to">To</label><input id="pa-to" type="date" className="input" value={range.to} min={range.from} max={iso(new Date())} onChange={(e) => setRange({ ...range, to: e.target.value })} /></div>
        {[7, 30, 90].map((n) => <Button key={n} size="sm" onClick={() => setRange({ from: daysAgo(n - 1), to: iso(new Date()) })}>Last {n} days</Button>)}
        {currencies.length > 1 ? <div className="w-32"><Select aria-label="Currency" value={currency} onValueChange={setCurrency} options={[{ value: '', label: 'All currencies' }, ...currencies.map((c) => ({ value: c, label: c }))]} /></div> : null}
        <span className="muted small">Days are bucketed in {tz}</span>
        <span className="flex-1" />
        <Button size="sm" disabled={!r || r.products.length === 0} onClick={() => void downloadFile('/api/analytics/products/export', exportName(range.from, range.to), { from: range.from, to: range.to, tz, funnelId, currency: currency || undefined }).catch(() => toast.push('The export failed', 'error'))}><Download /> Export CSV</Button>
      </div>
      {!ok ? <div className="alert warn" role="alert">The start date must not be after the end date.</div> : null}
      <ErrorBanner error={q.error} onRetry={() => void q.refetch()} />
      {q.isLoading ? <Loading rows={3} /> : null}
      {r && r.products.length === 0 ? <Empty title="No product sales in this period">Orders show up here per product once a checkout sells one.</Empty> : null}
      {r && r.products.length > 0 ? (
        <>
          {shown.map((t) => (
            <section key={t.currency} className="stack" aria-label={`Totals in ${t.currency}`}>
              {r.totals.length > 1 ? <h2>{t.currency}</h2> : null}
              <div className="grid stats">
                <div className="stat"><div className="v">{fmtMoney(t.gross, t.currency)}</div><div className="l">Gross · {fmtNum(t.orders)} orders, {fmtNum(t.units)} units</div></div>
                <div className="stat"><div className="v">{fmtMoney(t.net, t.currency)}</div><div className="l">Net revenue after {fmtMoney(t.refunded, t.currency)} refunded</div></div>
                <div className="stat"><div className="v">{fmtMoney(t.aov, t.currency)}</div><div className="l">Average order · refund rate {pct(t.refundRate)}</div></div>
                <div className="stat"><div className="v">{fmtNum(t.customers.total)}</div><div className="l">Customers · {fmtNum(t.customers.new)} new, {fmtNum(t.customers.repeat)} repeat</div></div>
              </div>
              <section className="card" aria-label={`Revenue trend in ${t.currency}`}>
                <h2>Revenue trend</h2>
                <LineChart title={`Daily revenue in ${t.currency}`} data={t.series.map((p) => ({ date: p.t.slice(0, 10), gross: p.gross, net: p.net }))} lines={[{ key: 'gross', label: 'Gross', color: '#2563eb' }, { key: 'net', label: 'Net', color: '#16a34a' }]} valueFormat={(n) => fmtMoney(n, t.currency)} />
              </section>
            </section>
          ))}
          <section className="card flush table-wrap" aria-label="Products">
            <table className="table">
              <caption className="sr-only">Performance per product and currency</caption>
              <thead><tr><th scope="col">Product</th><th scope="col">Trend</th><th scope="col" className="num">Orders</th><th scope="col" className="num">Gross</th><th scope="col" className="num">Refunded</th><th scope="col" className="num">Net</th><th scope="col" className="num">AOV</th><th scope="col" className="num">Conversion</th><th scope="col" className="num">Bump</th><th scope="col" className="num">Upsell</th></tr></thead>
              <tbody>
                {r.products.map((p) => (
                  <tr key={`${p.productId ?? p.name}-${p.currency}`}>
                    <td><button type="button" className="link-btn font-semibold text-primary hover:underline" onClick={() => setOpen(p)} aria-label={`Open details of ${p.name} in ${p.currency}`}>{p.name}</button>{r.totals.length > 1 ? <span className="muted small"> {p.currency}</span> : null}</td>
                    <td className="text-primary"><Sparkline values={p.series.map((s) => s.net)} label={`Net revenue of ${p.name}`} /></td>
                    <td className="num">{fmtNum(p.orders)}</td><td className="num">{fmtMoney(p.gross, p.currency)}</td><td className="num">{fmtMoney(p.refunded, p.currency)}</td><td className="num">{fmtMoney(p.net, p.currency)}</td>
                    <td className="num">{fmtMoney(p.aov, p.currency)}</td><td className="num">{p.checkout.visitors ? pct(p.checkout.conversion) : '–'}</td>
                    <td className="num">{p.takeRates.bump.offered ? pct(p.takeRates.bump.rate) : '–'}</td><td className="num">{p.takeRates.upsell.offered ? pct(p.takeRates.upsell.rate) : '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      ) : null}
      <SummaryCard scope={funnelId ? 'funnel' : 'workspace'} funnelId={funnelId} range={range} tz={tz} currency={currency} />
      {open && r ? <Detail row={open} report={r} range={range} tz={tz} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}
