import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useState } from 'react';
import { api, errorMessage } from '../../api/client';
import { useMutate } from '../../api/hooks';
import { Button } from '../../ui';
import { inputCls } from './kit';

export interface PlaceHit { placeId: string; name: string; address: string; rating: number | null; total: number | null }
export interface GoogleReviewsSettings { keyConfigured: boolean; keySource: string; defaultPlaceId: string | null; defaultPlaceName: string | null; status: string }

export const useGoogleSettings = () => useQuery({ queryKey: ['google-reviews', 'settings'], queryFn: () => api.get<GoogleReviewsSettings>('/api/google-reviews/settings'), staleTime: 30_000, retry: false });

/**
 * Finds the Google place a block should use (Places API Text Search through the server) or falls back to the workspace default. The block stores only the place id and name;
 * review content is never stored in the page.
 */
export function PlacePicker({ placeId, placeName, onPick, clearLabel = 'Use the default place' }: { placeId: string; placeName: string; onPick: (p: { placeId: string; placeName: string }) => void; clearLabel?: string }) {
  const settings = useGoogleSettings();
  const [q, setQ] = useState('');
  const search = useMutate((query: string) => api.post<{ data: PlaceHit[] }>('/api/google-reviews/search', { query }));
  const def = settings.data;
  return (
    <div className="flex flex-col gap-2" data-testid="place-picker">
      <p className="m-0 text-[0.8rem]" role="status">
        {placeId ? <>Place: <strong>{placeName || placeId}</strong></> : def?.defaultPlaceId ? <>Uses the default place: <strong>{def.defaultPlaceName || def.defaultPlaceId}</strong></> : 'No place chosen yet.'}
      </p>
      {def && !def.keyConfigured ? <p className="m-0 text-[0.75rem] text-warn" role="note">No Google API key is set up, so your own testimonials are shown. Add a key in Settings &gt; Integrations &gt; Google reviews.</p> : null}
      <form className="flex gap-1.5" onSubmit={(e) => { e.preventDefault(); if (q.trim().length >= 2) search.mutate(q.trim()); }}>
        <input aria-label="Search for your business on Google" className={inputCls} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Business name and city" disabled={def ? !def.keyConfigured : false} />
        <Button type="submit" size="sm" disabled={q.trim().length < 2 || search.isPending || (def ? !def.keyConfigured : false)} aria-label="Search places"><Search /></Button>
      </form>
      {search.error ? <p role="alert" className="m-0 text-[0.78rem] text-danger">{errorMessage(search.error)}</p> : null}
      {search.data ? (
        search.data.data.length === 0 ? <p className="m-0 text-[0.78rem] text-muted">No places found. Try the business name with its city.</p> : (
          <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-label="Places found">
            {search.data.data.map((p) => (
              <li key={p.placeId}>
                <button type="button" className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-left text-[0.8rem] hover:bg-surface-2" onClick={() => { onPick({ placeId: p.placeId, placeName: p.name }); search.reset(); setQ(''); }}>
                  <strong>{p.name}</strong><br /><span className="text-muted">{p.address}{p.rating ? ` · ${p.rating.toFixed(1)} (${p.total ?? 0})` : ''}</span>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
      {placeId ? <Button size="sm" onClick={() => onPick({ placeId: '', placeName: '' })}>{clearLabel}</Button> : null}
    </div>
  );
}
