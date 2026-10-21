import { useMemo, useState } from 'react';
import { api } from '../api/client';
import { useAnalytics, useMutate } from '../api/hooks';
import type { FunnelDetail, Insights } from '../api/types';
import { LineChart, type ChartLine } from '../components/Charts';
import { ErrorBanner, fmtMoney, fmtNum, fmtPct, Loading, RangePicker } from '../components/ui';

const LINES: (ChartLine & { default: boolean })[] = [
  { key: 'pageViews', label: 'Page views', color: '#2563eb', default: true },
  { key: 'uniqueVisits', label: 'Unique visits', color: '#7c3aed', default: true },
  { key: 'optIns', label: 'Opt-ins', color: '#16a34a', default: true },
  { key: 'orders', label: 'Orders', color: '#d97706', default: false },
];

export const todayIso = () => new Date().toISOString().slice(0, 10);
export const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

export function AnalyticsTab({ funnel }: { funnel: FunnelDetail }) {
  const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', []);
  const [range, setRange] = useState({ from: daysAgo(29), to: todayIso() });
  const [on, setOn] = useState<string[]>(LINES.filter((l) => l.default).map((l) => l.key));
  const q = useAnalytics(funnel.id, { from: range.from, to: range.to, tz });
  const insights = useMutate(() => api.post<Insights>('/api/ai/insights', { funnelId: funnel.id, from: range.from, to: range.to, tz }));
  const s = q.data?.summary;
  const rangeOk = range.from <= range.to;

  return (
    <div className="stack">
      <RangePicker range={range} setRange={setRange} tz={tz} />
      {!rangeOk ? <div className="alert warn" role="alert">The start date must not be after the end date.</div> : null}
      <ErrorBanner error={q.error} onRetry={() => void q.refetch()} />
      {q.isLoading ? <Loading rows={2} /> : null}
      {s ? (
        <>
          <div className="grid stats">
            <div className="stat"><div className="v">{fmtNum(s.pageViews.all)}</div><div className="l">Page views ({fmtNum(s.pageViews.unique)} unique visitors)</div></div>
            <div className="stat"><div className="v">{fmtNum(s.optIns.all)}</div><div className="l">Opt-ins · {fmtPct(s.optIns.conversionRate)} conversion</div></div>
            <div className="stat"><div className="v">{fmtNum(s.sales.orders)}</div><div className="l">Orders · {fmtPct(s.sales.conversionRate)} conversion</div></div>
            <div className="stat"><div className="v">{fmtMoney(s.sales.gross)}</div><div className="l">Gross sales</div></div>
            <div className="stat"><div className="v">{fmtMoney(s.earningsPerView.all)}</div><div className="l">Earnings per view ({fmtMoney(s.earningsPerView.unique)} per unique)</div></div>
          </div>

          <section className="card" aria-label="Daily trend">
            <div className="row between">
              <h2>Daily trend</h2>
              <div className="row" role="group" aria-label="Chart series">
                {LINES.map((l) => (
                  <label key={l.key} className="check small"><input type="checkbox" checked={on.includes(l.key)} onChange={() => setOn(on.includes(l.key) ? on.filter((k) => k !== l.key) : [...on, l.key])} />{l.label}</label>
                ))}
              </div>
            </div>
            {on.length ? <LineChart title={`Daily trend for ${funnel.name}`} data={q.data!.series.map((p) => ({ ...p }))} lines={LINES.filter((l) => on.includes(l.key))} valueFormat={(n) => fmtNum(n)} /> : <p className="muted">Select at least one series.</p>}
          </section>

          <section className="card flush table-wrap" aria-label="Step breakdown">
            <table className="table">
              <caption className="sr-only">Per-step breakdown</caption>
              <thead><tr><th scope="col">Step</th><th scope="col" className="num">Views</th><th scope="col" className="num">Unique</th><th scope="col" className="num">Opt-ins</th><th scope="col" className="num">Opt-in rate</th><th scope="col" className="num">Orders</th><th scope="col" className="num">Sales rate</th><th scope="col" className="num">Gross</th><th scope="col" className="num">EPV</th></tr></thead>
              <tbody>
                {q.data!.steps.map((st) => (
                  <tr key={st.stepId}>
                    <td><strong>{st.name}</strong> <span className="muted small mono">{st.path}</span></td>
                    <td className="num">{fmtNum(st.pageViews.all)}</td><td className="num">{fmtNum(st.pageViews.unique)}</td><td className="num">{fmtNum(st.optIns.all)}</td><td className="num">{fmtPct(st.optIns.conversionRate)}</td>
                    <td className="num">{fmtNum(st.sales.orders)}</td><td className="num">{fmtPct(st.sales.conversionRate)}</td><td className="num">{fmtMoney(st.sales.gross)}</td><td className="num">{fmtMoney(st.earningsPerView.all)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="card stack" aria-label="AI insights">
            <div className="row between">
              <div><h2>AI insights</h2><span className="muted small">Numbers come from your data; the assistant only explains them.</span></div>
              <button type="button" className="btn primary" disabled={insights.isPending || !rangeOk} onClick={() => insights.mutate(undefined)}>{insights.isPending ? 'Analysing…' : insights.data ? 'Refresh insights' : 'Explain performance'}</button>
            </div>
            <ErrorBanner error={insights.error} />
            {insights.data ? (
              <div className="stack">
                <p>{insights.data.summary}</p>
                {insights.data.weakestStepId ? <p><span className="badge warn">Weakest step</span> {q.data!.steps.find((x) => x.stepId === insights.data!.weakestStepId)?.name}</p> : null}
                <ol>{insights.data.actions.map((a) => <li key={a.title}><strong>{a.title}.</strong> {a.detail}</li>)}</ol>
                <span className="muted small">{insights.data.source === 'model' ? 'Written by the AI model' : 'Written by the built-in analyst (no model output used)'}</span>
              </div>
            ) : null}
          </section>
        </>
      ) : null}
    </div>
  );
}
