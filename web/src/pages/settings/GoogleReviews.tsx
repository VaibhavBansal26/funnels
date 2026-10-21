import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '../../api/client';
import { useMutate } from '../../api/hooks';
import { useToast } from '../../components/Toasts';
import { ConfirmDialog, ErrorBanner, Loading, TextField } from '../../components/ui';
import { PlacePicker, useGoogleSettings } from '../../builder/panels/PlacePicker';

interface TestResult { ok: boolean; keySource: string; place?: { name: string; rating: number | null; total: number | null }; reviewsReturned?: number; error?: { code: string; message: string } }

const SOURCE: Record<string, string> = { workspace: 'Your own key', platform: 'The platform key', none: 'No key' };

/** Settings > Google reviews: the Places API key (stored encrypted, shown only as a hint), the default place, and a live test. */
export function GoogleReviewsCard() {
  const toast = useToast();
  const qc = useQueryClient();
  const q = useGoogleSettings();
  const [key, setKey] = useState('');
  const [clearing, setClearing] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const settingsKey = ['google-reviews', 'settings'];
  const save = useMutate((body: object) => api.put('/api/google-reviews/settings', body), [settingsKey]);
  const test = useMutate(() => api.post<TestResult>('/api/google-reviews/test', {}));
  const s = q.data as (typeof q.data & { workspaceKeyHint?: string | null; lastError?: string | null; cacheTtlSeconds?: number; dailyFetchLimit?: number }) | undefined;
  return (
    <section className="card stack" aria-label="Google reviews">
      <h2>Google reviews</h2>
      <p className="muted small">Show your Google rating and reviews on pages with the <strong>Google reviews</strong> block, and ask for new ones with the review button. Reviews are fetched by the server from the Google Places API with the key below, kept for a short time ({s?.cacheTtlSeconds ?? 3600} seconds) and shown with Google's attribution and a link to each author. Without a key the block shows the testimonials you typed into it.</p>
      {q.isLoading ? <Loading rows={2} /> : null}
      <ErrorBanner error={q.error ?? save.error ?? test.error} />
      {s ? (
        <>
          <p>Key in use: <strong>{SOURCE[s.keySource] ?? s.keySource}</strong>{s.workspaceKeyHint ? <> <code aria-label="Key hint">{s.workspaceKeyHint}</code></> : null}. Status: <span className={`badge ${s.status === 'ok' ? 'ok' : s.status === 'error' ? 'danger' : ''}`}>{s.status}</span></p>
          {s.lastError ? <div className="alert error" role="alert">{s.lastError}</div> : null}
          <form className="stack" onSubmit={(e) => { e.preventDefault(); if (!key) return; save.mutate({ apiKey: key }, { onSuccess: () => { setKey(''); toast.push('Key saved', 'ok'); } }); }}>
            <TextField label={s.workspaceKeyHint ? 'Replace your Places API key' : 'Places API key'} type="password" autoComplete="off" spellCheck={false} value={key} onChange={setKey} hint="Create a key in Google Cloud with the Places API (New) enabled. It is stored encrypted and never shown again." />
            <div className="row">
              <button type="submit" className="btn primary" disabled={!key || save.isPending}>Save key</button>
              {s.workspaceKeyHint ? <button type="button" className="btn danger" onClick={() => setClearing(true)}>Remove key</button> : null}
            </div>
          </form>
          <div className="stack">
            <h3>Default place</h3>
            <p className="muted small">Blocks that do not name a place use this one.</p>
            <PlacePicker placeId={s.defaultPlaceId ?? ''} placeName={s.defaultPlaceName ?? ''} onPick={(p) => save.mutate({ defaultPlaceId: p.placeId, defaultPlaceName: p.placeName }, { onSuccess: () => toast.push(p.placeId ? 'Default place saved' : 'Default place cleared', 'ok') })} />
          </div>
          <div className="stack">
            <div className="row">
              <button type="button" className="btn" disabled={!s.keyConfigured || !s.defaultPlaceId || test.isPending} onClick={() => test.mutate(undefined, { onSuccess: (r) => { setResult(r); void qc.invalidateQueries({ queryKey: settingsKey }); } })}>{test.isPending ? 'Testing…' : 'Test fetch'}</button>
              <span className="muted small">Makes one live call to Google ({s.dailyFetchLimit ?? 200} lookups per day are allowed).</span>
            </div>
            {result ? (
              <div className={`alert ${result.ok ? 'ok' : 'error'}`} role="status" data-testid="test-result">
                {result.ok ? `Google answered: ${result.place?.name}, rating ${result.place?.rating ?? 'n/a'} from ${result.place?.total ?? 0} reviews, ${result.reviewsReturned} review(s) returned.` : `${result.error?.message ?? 'No answer'} (${result.error?.code})`}
              </div>
            ) : null}
          </div>
          <p className="muted small">Google's terms limit how Places content may be stored and shown (attribution, no changes to the text, no review markup for search engines). See docs/REVIEWS.md; you are responsible for your own agreement with Google.</p>
        </>
      ) : null}
      {clearing ? <ConfirmDialog danger title="Remove your Google key?" confirmLabel="Remove" busy={save.isPending} message="Blocks go back to your own testimonials (or the platform key, if the platform has one)." onCancel={() => setClearing(false)} onConfirm={() => save.mutate({ clearKey: true }, { onSuccess: () => { setClearing(false); toast.push('Key removed', 'ok'); }, onError: () => setClearing(false) })} /> : null}
      <span className="sr-only" aria-live="polite">{save.error ? errorMessage(save.error) : ''}</span>
    </section>
  );
}
