import { useMemo, useState } from 'react';
import { api, downloadFile, errorMessage } from '../../api/client';
import { growthKeys, money, ratio, useAttribution, useMappings, usePerformance, type Performance } from '../../api/growth';
import { useFunnels, useMutate } from '../../api/hooks';
import { useAuth } from '../../auth/AuthContext';
import { useToast } from '../../components/Toasts';
import { Empty, ErrorBanner, fmtNum, Loading, Modal } from '../../components/ui';
import { Badge } from '../../ui';
import { daysAgo, todayIso } from '../AnalyticsTab';

export function Range({ range, setRange, tz }: { range: { from: string; to: string }; setRange: (r: { from: string; to: string }) => void; tz: string }) {
  return (
    <>
      <div className="field"><label htmlFor="ads-from">From</label><input id="ads-from" type="date" className="input" value={range.from} max={range.to} onChange={(e) => setRange({ ...range, from: e.target.value })} /></div>
      <div className="field"><label htmlFor="ads-to">To</label><input id="ads-to" type="date" className="input" value={range.to} min={range.from} max={todayIso()} onChange={(e) => setRange({ ...range, to: e.target.value })} /></div>
      {[7, 30, 90].map((n) => <button key={n} type="button" className="btn sm" onClick={() => setRange({ from: daysAgo(n - 1), to: todayIso() })}>Last {n} days</button>)}
      <span className="muted small">Revenue days are bucketed in {tz}</span>
    </>
  );
}

const tzOf = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

function MapDialog({ item, campaigns, onClose }: { item: { source: string; campaign: string; hint: string | null }; campaigns: string[]; onClose: () => void }) {
  const toast = useToast();
  const [utm, setUtm] = useState(item.hint ?? '');
  const save = useMutate(() => api.put('/api/ads/mappings', { source: item.source, campaign: item.campaign, utmCampaign: utm.trim() }), [['ads'] as string[]]);
  return (
    <Modal title="Match this campaign to your traffic" onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" disabled={!utm.trim() || save.isPending} onClick={() => save.mutate(undefined, { onSuccess: () => { toast.push('Mapped. The report now joins this spend to that traffic.', 'ok'); onClose(); }, onError: (e) => toast.push(errorMessage(e), 'error') })}>Save mapping</button></>}>
      <div className="stack">
        <p className="small">Spend on <strong>{item.campaign}</strong> ({item.source}) never shows up in your traffic. Choose the <span className="mono">utm_campaign</span> value your ads use, or type it.</p>
        <div className="field"><label htmlFor="map-utm">utm_campaign</label><input id="map-utm" className="input" list="map-campaigns" value={utm} onChange={(e) => setUtm(e.target.value)} data-autofocus /><datalist id="map-campaigns">{campaigns.map((c) => <option key={c} value={c} />)}</datalist></div>
        {campaigns.length === 0 ? <p className="muted small">No campaign names were seen in the traffic of this period. Add UTM parameters to your ad links (utm_campaign=...).</p> : null}
      </div>
    </Modal>
  );
}

export function PerformanceView({ funnelId }: { funnelId?: string }) {
  const { can } = useAuth();
  const toast = useToast();
  const tz = useMemo(tzOf, []);
  const [range, setRange] = useState({ from: daysAgo(29), to: todayIso() });
  const [model, setModel] = useState<'first' | 'last'>('last');
  const [groupBy, setGroupBy] = useState<'campaign' | 'source' | 'funnel' | 'day'>(funnelId ? 'campaign' : 'campaign');
  const [currency, setCurrency] = useState('');
  const [funnel, setFunnel] = useState('');
  const [mapping, setMapping] = useState<Performance['unmatched'][number] | null>(null);
  const [exporting, setExporting] = useState(false);
  const funnels = useFunnels({ limit: 100 });
  const query = { from: range.from, to: range.to, tz, model, groupBy, currency: currency || undefined, funnelId: funnelId ?? (funnel || undefined) };
  const q = usePerformance(query);
  const maps = useMappings();
  const del = useMutate((id: string) => api.delete(`/api/ads/mappings/${id}`), [['ads'] as string[]]);
  const p = q.data;
  const cur = p?.currency ?? 'USD';
  const rangeOk = range.from <= range.to;
  const empty = p && p.rows.length === 0 && p.other.orders + p.other.leads + p.other.visits === 0;
  return (
    <div className="stack">
      <div className="filters" role="group" aria-label="Report options">
        <Range range={range} setRange={setRange} tz={tz} />
        <div className="field"><label htmlFor="ads-model">Attribution</label><select id="ads-model" className="input" value={model} onChange={(e) => setModel(e.target.value as 'first' | 'last')}><option value="last">Last touch</option><option value="first">First touch</option></select></div>
        <div className="field"><label htmlFor="ads-group">Group by</label><select id="ads-group" className="input" value={groupBy} onChange={(e) => setGroupBy(e.target.value as typeof groupBy)}><option value="campaign">Campaign</option><option value="source">Source</option>{funnelId ? null : <option value="funnel">Funnel</option>}<option value="day">Day</option></select></div>
        {p && p.currencies.length > 1 ? <div className="field"><label htmlFor="ads-cur">Currency</label><select id="ads-cur" className="input" value={cur} onChange={(e) => setCurrency(e.target.value)}>{p.currencies.map((c) => <option key={c} value={c}>{c}</option>)}</select></div> : null}
        {!funnelId ? <div className="field"><label htmlFor="ads-funnel">Funnel</label><select id="ads-funnel" className="input" value={funnel} onChange={(e) => setFunnel(e.target.value)}><option value="">All funnels</option>{funnels.data?.data.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></div> : null}
        <button type="button" className="btn" disabled={exporting || !rangeOk} onClick={async () => { setExporting(true); try { await downloadFile('/api/ads/performance/export', 'ads-performance.csv', query); } catch (e) { toast.push(errorMessage(e), 'error'); } finally { setExporting(false); } }}>{exporting ? 'Exporting…' : 'Export CSV'}</button>
      </div>
      {!rangeOk ? <div className="alert warn" role="alert">The start date must not be after the end date.</div> : null}
      <ErrorBanner error={q.error} onRetry={() => void q.refetch()} />
      {q.isLoading ? <Loading rows={2} /> : null}
      {p && p.currencies.length > 1 ? <div className="alert" role="status">Amounts are shown in <strong>{cur}</strong> only. Other currencies in this period: {p.currencies.filter((c) => c !== cur).join(', ')}. They are never added together.</div> : null}
      {p ? (
        <>
          <div className="grid stats">
            <div className="stat"><div className="v">{money(p.totals.spend, cur)}</div><div className="l">Ad spend{p.totals.clicks !== null ? ` · ${fmtNum(p.totals.clicks)} clicks` : ''}</div></div>
            <div className="stat"><div className="v">{money(p.totals.revenue, cur)}</div><div className="l">Revenue from these campaigns · {fmtNum(p.totals.orders)} orders</div></div>
            <div className="stat"><div className="v">{p.totals.roas === null ? '—' : `${ratio(p.totals.roas)}x`}</div><div className="l">ROAS (revenue / spend)</div></div>
            <div className="stat"><div className="v" style={{ color: p.totals.profit < 0 ? 'var(--danger)' : undefined }}>{money(p.totals.profit, cur)}</div><div className="l">Profit (revenue − spend)</div></div>
            <div className="stat"><div className="v">{money(p.totals.cpl, cur)}</div><div className="l">Cost per lead · {fmtNum(p.totals.leads)} leads</div></div>
            <div className="stat"><div className="v">{money(p.totals.cpa, cur)}</div><div className="l">Cost per order</div></div>
          </div>
          {empty ? <div className="card"><Empty title="No ad spend or tracked traffic in this period">Import spend from your ad manager&apos;s CSV export on the Spend tab, and add <span className="mono">utm_campaign</span> to your ad links so visits and orders can be matched.</Empty></div> : (
            <section className="card flush table-wrap" aria-label="Performance">
              <table className="table">
                <caption className="sr-only">Ad performance by {groupBy}, in {cur}</caption>
                <thead><tr>
                  <th scope="col">{groupBy === 'campaign' ? 'Campaign' : groupBy === 'source' ? 'Source' : groupBy === 'funnel' ? 'Funnel' : 'Day'}</th>
                  <th scope="col" className="num">Spend</th><th scope="col" className="num">Visits</th><th scope="col" className="num">Leads</th><th scope="col" className="num">Orders</th><th scope="col" className="num">Revenue</th>
                  <th scope="col" className="num">CPL</th><th scope="col" className="num">CPA</th><th scope="col" className="num">ROAS</th><th scope="col" className="num">Profit</th>
                </tr></thead>
                <tbody>
                  {p.rows.map((r) => (
                    <tr key={r.key}>
                      <td>{groupBy === 'campaign' ? <><strong>{r.campaign}</strong> <span className="muted small">{r.source}</span></> : groupBy === 'source' ? <strong>{r.source}</strong> : groupBy === 'funnel' ? <strong>{r.funnelName ?? '(not assigned to a funnel)'}</strong> : <span className="mono">{r.day}</span>}</td>
                      <td className="num">{money(r.spend, cur)}</td><td className="num">{fmtNum(r.visits)}</td><td className="num">{fmtNum(r.leads)}</td><td className="num">{fmtNum(r.orders)}</td><td className="num">{money(r.revenue, cur)}</td>
                      <td className="num">{money(r.cpl, cur)}</td><td className="num">{money(r.cpa, cur)}</td><td className="num">{r.roas === null ? '—' : `${ratio(r.roas)}x`}</td><td className="num" style={{ color: r.profit < 0 ? 'var(--danger)' : undefined }}>{money(r.profit, cur)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
          {p.other.orders + p.other.leads > 0 ? <p className="muted small">Not counted above: {fmtNum(p.other.orders)} orders ({money(p.other.revenue, cur)}) and {fmtNum(p.other.leads)} leads from campaigns without recorded spend (organic, email and so on).</p> : null}
          {p.unmatched.length ? (
            <section className="card stack" aria-label="Spend not matched to traffic">
              <div><h2 style={{ margin: 0 }}>Spend that does not match your traffic</h2><span className="muted small">These campaign names never appear as <span className="mono">utm_campaign</span> on your pages in this period, so their results cannot be counted. Match them to the value your ads use.</span></div>
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {p.unmatched.map((u) => (
                  <li key={`${u.source}/${u.campaign}`} className="row between">
                    <span><strong>{u.campaign}</strong> <span className="muted small">{u.source} · {money(u.spend, cur)}</span>{u.hint ? <> <Badge tone="info">Looks like {u.hint}</Badge></> : null}</span>
                    {can('ads:write') ? <button type="button" className="btn sm" onClick={() => setMapping(u)}>Match…</button> : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {maps.data && maps.data.data.length ? (
            <details className="card">
              <summary>Campaign mappings ({maps.data.data.length})</summary>
              <ul className="m-0 mt-2 flex list-none flex-col gap-2 p-0">
                {maps.data.data.map((m) => (
                  <li key={m.id} className="row between small"><span><strong>{m.campaign}</strong> <span className="muted">({m.source})</span> → <span className="mono">{m.utmCampaign}</span>{m.utmSource ? <span className="muted"> from {m.utmSource}</span> : null}</span>{can('ads:write') ? <button type="button" className="btn sm" onClick={() => del.mutate(m.id, { onError: (e) => toast.push(errorMessage(e), 'error') })}>Remove</button> : null}</li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      ) : null}
      {mapping && p ? <MapDialog item={mapping} campaigns={p.campaigns} onClose={() => setMapping(null)} /> : null}
    </div>
  );
}

export function AttributionView() {
  const toast = useToast();
  const tz = useMemo(tzOf, []);
  const [range, setRange] = useState({ from: daysAgo(29), to: todayIso() });
  const [model, setModel] = useState<'first' | 'last'>('last');
  const [dimension, setDimension] = useState('source_medium');
  const [currency, setCurrency] = useState('');
  const query = { from: range.from, to: range.to, tz, model, dimension, currency: currency || undefined };
  const q = useAttribution(query);
  const [exporting, setExporting] = useState(false);
  const r = q.data;
  const cur = r?.currency ?? 'USD';
  const cols = dimension === 'source' ? ['source'] : dimension === 'medium' ? ['medium'] : dimension === 'campaign' ? ['campaign'] : dimension === 'content' ? ['content'] : dimension === 'source_medium' ? ['source', 'medium'] : ['source', 'medium', 'campaign'];
  return (
    <div className="stack">
      <div className="filters" role="group" aria-label="Report options">
        <Range range={range} setRange={setRange} tz={tz} />
        <div className="field"><label htmlFor="at-model">Touch</label><select id="at-model" className="input" value={model} onChange={(e) => setModel(e.target.value as 'first' | 'last')}><option value="last">Last touch</option><option value="first">First touch</option></select></div>
        <div className="field"><label htmlFor="at-dim">Break down by</label><select id="at-dim" className="input" value={dimension} onChange={(e) => setDimension(e.target.value)}><option value="source_medium">Source / medium</option><option value="source">Source</option><option value="medium">Medium</option><option value="campaign">Campaign</option><option value="content">Ad (utm_content)</option><option value="source_medium_campaign">Source / medium / campaign</option></select></div>
        {r && r.currencies.length > 1 ? <div className="field"><label htmlFor="at-cur">Currency</label><select id="at-cur" className="input" value={cur} onChange={(e) => setCurrency(e.target.value)}>{r.currencies.map((c) => <option key={c} value={c}>{c}</option>)}</select></div> : null}
        <button type="button" className="btn" disabled={exporting} onClick={async () => { setExporting(true); try { await downloadFile('/api/ads/attribution/export', 'attribution.csv', query); } catch (e) { toast.push(errorMessage(e), 'error'); } finally { setExporting(false); } }}>{exporting ? 'Exporting…' : 'Export CSV'}</button>
      </div>
      <ErrorBanner error={q.error} onRetry={() => void q.refetch()} />
      {q.isLoading ? <Loading rows={2} /> : null}
      {r ? (
        r.rows.length === 0 ? <div className="card"><Empty title="Nothing attributed in this period">Visits are recorded with their UTM parameters and click ids once the beacon runs on your live pages.</Empty></div> : (
          <section className="card flush table-wrap" aria-label="Attribution">
            <table className="table">
              <caption className="sr-only">Attribution by {dimension.replace(/_/g, ' / ')}, {model} touch, revenue in {cur}</caption>
              <thead><tr>{cols.map((c) => <th key={c} scope="col">{c[0]!.toUpperCase() + c.slice(1)}</th>)}<th scope="col" className="num">Visits</th><th scope="col" className="num">Leads</th><th scope="col" className="num">Orders</th><th scope="col" className="num">Revenue</th><th scope="col" className="num">Orders / visits</th></tr></thead>
              <tbody>
                {r.rows.map((row, i) => (
                  <tr key={i}>
                    {cols.map((c) => <td key={c}>{(row as Record<string, unknown>)[c] as string}</td>)}
                    <td className="num">{fmtNum(row.visits)}</td><td className="num">{fmtNum(row.leads)}</td><td className="num">{fmtNum(row.orders)}</td><td className="num">{money(row.revenue, cur)}</td><td className="num">{row.conversionRate === null ? '—' : `${row.conversionRate.toFixed(2)}%`}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr><th scope="row" colSpan={cols.length}>Total</th><td className="num">{fmtNum(r.totals.visits)}</td><td className="num">{fmtNum(r.totals.leads)}</td><td className="num">{fmtNum(r.totals.orders)}</td><td className="num">{money(r.totals.revenue, cur)}</td><td /></tr></tfoot>
            </table>
          </section>
        )
      ) : null}
      <p className="muted small">First touch is the earliest campaign, click or referrer a visitor arrived with; last touch is the latest one (a direct visit never replaces it). &quot;(direct)&quot; is traffic with no recorded source. Visits count visitors whose touch fell in the period.</p>
    </div>
  );
}

export { growthKeys };
