import { useRef, useState } from 'react';
import { api, ApiError, errorMessage } from '../../api/client';
import { money, useSpend, type ImportResult } from '../../api/growth';
import { useFunnels, useMutate } from '../../api/hooks';
import { useAuth } from '../../auth/AuthContext';
import { useToast } from '../../components/Toasts';
import { Empty, ErrorBanner, fmtNum, Loading, Modal, TextField } from '../../components/ui';
import { todayIso } from '../AnalyticsTab';

export const MAX_CSV_BYTES = 2_000_000;
export const SAMPLE_CSV = 'date,source,account,campaign,currency,spend,impressions,clicks\n2026-03-01,facebook,main,Spring sale,USD,120.50,10400,310\n2026-03-02,facebook,main,Spring sale,USD,98.00,8900,254\n';

/** Client-side checks that save a round trip; the server validates every row again. */
export function checkCsvFile(file: { name: string; size: number }): string | null {
  if (file.size === 0) return 'The file is empty.';
  if (file.size > MAX_CSV_BYTES) return `The file is ${(file.size / 1_000_000).toFixed(1)} MB; the limit is 2 MB. Split it by month.`;
  if (!/\.(csv|txt|tsv)$/i.test(file.name)) return 'Choose a .csv file exported from your ad manager.';
  return null;
}

export function ImportErrors({ r }: { r: ImportResult }) {
  return (
    <div className="stack">
      <p className="small"><strong>{r.valid}</strong> of {r.rows} rows are valid{r.skipped ? <>, <strong className="text-danger">{r.skipped}</strong> have problems</> : null}.{r.dryRun ? ' Nothing has been saved yet.' : ` ${r.created} added, ${r.updated} updated.`}</p>
      {r.errors.length ? (
        <div className="table-wrap card flush" style={{ maxHeight: 240, overflow: 'auto' }}>
          <table className="table"><caption className="sr-only">Problems found in the file</caption><thead><tr><th scope="col">Line</th><th scope="col">Column</th><th scope="col">Problem</th></tr></thead>
            <tbody>{r.errors.map((e, i) => <tr key={i}><td className="mono">{e.line}</td><td>{e.field}</td><td>{e.message}</td></tr>)}</tbody></table>
        </div>
      ) : null}
      {r.moreErrors ? <p className="muted small">More problems exist than are listed.</p> : null}
    </div>
  );
}

function ImportDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState<{ name: string; body: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [skip, setSkip] = useState(false);
  const [sum, setSum] = useState(false);
  const [source, setSource] = useState('');
  const [currency, setCurrency] = useState('');
  const [result, setResult] = useState<ImportResult | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const run = useMutate((dry: boolean) => api.postText<ImportResult>('/api/ads/spend/import', text!.body, 'text/csv', { dryRun: dry ? 'true' : undefined, skipInvalid: skip ? 'true' : undefined, duplicates: sum ? 'sum' : undefined, source: source.trim() || undefined, currency: currency.trim() || undefined }), [['ads'] as string[]]);
  const go = (dry: boolean) => {
    setErr(null);
    run.mutate(dry, {
      onSuccess: (r) => { setResult(r); if (!dry) { toast.push(`Imported ${r.created + r.updated} rows`, 'ok'); onClose(); } },
      onError: (e) => {
        if (e instanceof ApiError && e.code === 'IMPORT_INVALID') setResult({ ...(e.details as ImportResult), dryRun: true });
        else setErr(e);
      },
    });
  };
  return (
    <Modal wide title="Import ad spend from CSV" onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Close</button><button type="button" className="btn" disabled={!text || run.isPending} onClick={() => go(true)}>Check file</button><button type="button" className="btn primary" disabled={!text || run.isPending || (result !== null && result.valid === 0)} onClick={() => go(false)}>Import</button></>}>
      <div className="stack">
        <p className="small">Export a daily report from your ad manager with columns <span className="mono">date, source, campaign, currency, spend</span> (optional: <span className="mono">account, impressions, clicks</span>). Importing the same file again updates the rows instead of duplicating them. <button type="button" className="btn sm" onClick={() => { const u = URL.createObjectURL(new Blob([SAMPLE_CSV], { type: 'text/csv' })); const a = document.createElement('a'); a.href = u; a.download = 'ad-spend-sample.csv'; a.click(); URL.revokeObjectURL(u); }}>Download a sample</button></p>
        <div className="field"><label htmlFor="csv-file">CSV file</label><input id="csv-file" ref={input} type="file" accept=".csv,.txt,.tsv,text/csv" className="input" onChange={async (e) => {
          const f = e.target.files?.[0];
          setResult(null);
          if (!f) return setText(null);
          const p = checkCsvFile(f);
          setProblem(p);
          setText(p ? null : { name: f.name, body: await f.text() });
        }} /></div>
        {problem ? <div className="alert error" role="alert">{problem}</div> : null}
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
          <TextField label="Source for rows without one" value={source} placeholder="facebook" hint="Only if the file has no source column" onChange={setSource} />
          <TextField label="Currency for rows without one" value={currency} placeholder="USD" maxLength={3} onChange={(v) => setCurrency(v.toUpperCase())} />
        </div>
        <label className="check"><input type="checkbox" checked={skip} onChange={(e) => setSkip(e.target.checked)} />Import the valid rows even if some rows have problems</label>
        <label className="check"><input type="checkbox" checked={sum} onChange={(e) => setSum(e.target.checked)} />Add up rows that repeat the same day, source, campaign and currency (ad sets)</label>
        <ErrorBanner error={err} />
        {result ? <ImportErrors r={result} /> : null}
      </div>
    </Modal>
  );
}

function AddForm() {
  const toast = useToast();
  const funnels = useFunnels({ limit: 100 });
  const [f, setF] = useState({ day: todayIso(), source: '', campaign: '', currency: 'USD', spend: '', impressions: '', clicks: '', funnelId: '' });
  const save = useMutate(() => api.post('/api/ads/spend', { day: f.day, source: f.source.trim(), campaign: f.campaign.trim(), currency: f.currency.trim().toUpperCase(), spend: Number(f.spend), impressions: f.impressions ? Number(f.impressions) : null, clicks: f.clicks ? Number(f.clicks) : null, funnelId: f.funnelId || null }), [['ads'] as string[]]);
  const spendOk = f.spend !== '' && Number(f.spend) >= 0 && Number.isFinite(Number(f.spend));
  const valid = f.source.trim() && f.campaign.trim() && /^[A-Za-z]{3}$/.test(f.currency) && spendOk;
  return (
    <form className="card stack" noValidate aria-label="Add spend" onSubmit={(e) => { e.preventDefault(); if (valid) save.mutate(undefined, { onSuccess: () => { toast.push('Spend saved', 'ok'); setF({ ...f, spend: '', impressions: '', clicks: '' }); }, onError: (er) => toast.push(errorMessage(er), 'error') }); }}>
      <h2 style={{ margin: 0 }}>Add or correct a day</h2>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
        <div className="field"><label htmlFor="sp-day">Day</label><input id="sp-day" type="date" className="input" value={f.day} max={todayIso()} onChange={(e) => setF({ ...f, day: e.target.value })} /></div>
        <TextField label="Source" value={f.source} placeholder="facebook" onChange={(source) => setF({ ...f, source })} />
        <TextField label="Campaign" value={f.campaign} placeholder="Spring sale" onChange={(campaign) => setF({ ...f, campaign })} />
        <TextField label="Currency" value={f.currency} maxLength={3} onChange={(currency) => setF({ ...f, currency: currency.toUpperCase() })} />
        <TextField label="Spend" type="number" min={0} step="0.01" value={f.spend} error={f.spend !== '' && !spendOk ? 'Enter an amount of zero or more' : undefined} onChange={(spend) => setF({ ...f, spend })} />
        <TextField label="Impressions" type="number" min={0} value={f.impressions} onChange={(impressions) => setF({ ...f, impressions })} />
        <TextField label="Clicks" type="number" min={0} value={f.clicks} onChange={(clicks) => setF({ ...f, clicks })} />
        <div className="field"><label htmlFor="sp-funnel">Funnel (optional)</label><select id="sp-funnel" className="input" value={f.funnelId} onChange={(e) => setF({ ...f, funnelId: e.target.value })}><option value="">Not assigned</option>{funnels.data?.data.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></div>
      </div>
      <div className="row"><button className="btn primary" type="submit" disabled={!valid || save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</button><span className="muted small">The same day, source, campaign and currency replaces the earlier amount.</span></div>
    </form>
  );
}

export function SpendView() {
  const { can } = useAuth();
  const toast = useToast();
  const [importing, setImporting] = useState(false);
  const q = useSpend({ limit: 100 });
  const del = useMutate((id: string) => api.delete(`/api/ads/spend/${id}`), [['ads'] as string[]]);
  const write = can('ads:write');
  return (
    <div className="stack">
      <div className="row between">
        <p className="muted" style={{ margin: 0 }}>Ad spend is entered here or imported from your ad manager&apos;s CSV export. This app does not connect to the ad platforms to create or read campaigns.</p>
        {write ? <button type="button" className="btn primary" onClick={() => setImporting(true)}>Import CSV</button> : null}
      </div>
      {write ? <AddForm /> : <div className="alert">You can see ad spend. Entering it needs the ads:write permission.</div>}
      <ErrorBanner error={q.error} onRetry={() => void q.refetch()} />
      {q.isLoading ? <Loading rows={2} /> : null}
      {q.data && q.data.data.length === 0 ? <div className="card"><Empty title="No ad spend yet">Import a CSV or add a day above.</Empty></div> : null}
      {q.data && q.data.data.length ? (
        <section className="card flush table-wrap" aria-label="Ad spend">
          <table className="table">
            <caption className="sr-only">Ad spend rows, newest first</caption>
            <thead><tr><th scope="col">Day</th><th scope="col">Source</th><th scope="col">Campaign</th><th scope="col" className="num">Spend</th><th scope="col" className="num">Impressions</th><th scope="col" className="num">Clicks</th>{write ? <th scope="col"><span className="sr-only">Actions</span></th> : null}</tr></thead>
            <tbody>
              {q.data.data.map((r) => (
                <tr key={r.id}><td className="mono">{r.day}</td><td>{r.source}{r.account ? <span className="muted small"> · {r.account}</span> : null}</td><td>{r.campaign}</td><td className="num">{money(r.spend, r.currency)}</td><td className="num">{r.impressions === null ? '—' : fmtNum(r.impressions)}</td><td className="num">{r.clicks === null ? '—' : fmtNum(r.clicks)}</td>
                  {write ? <td><button type="button" className="btn sm" aria-label={`Delete spend for ${r.campaign} on ${r.day}`} onClick={() => del.mutate(r.id, { onError: (e) => toast.push(errorMessage(e), 'error') })}>Delete</button></td> : null}</tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
      {importing ? <ImportDialog onClose={() => setImporting(false)} /> : null}
    </div>
  );
}
