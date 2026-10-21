import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanProject, createPageBuilder } from '@pagemodel';
import { ToastProvider } from '../components/Toasts';
import { GoogleReviewsCard } from '../pages/settings/GoogleReviews';
import { createEditor } from './editor/createEditor';
import { loadDoc, readProject } from './editor/load';
import { PlacePicker } from './panels/PlacePicker';

vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ can: () => true }) }));
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const wrap = (ui: React.ReactElement) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ToastProvider>{ui}</ToastProvider></QueryClientProvider>);
afterEach(() => vi.unstubAllGlobals());

describe('Google reviews in the builder', () => {
  it('the blocks are in the library and a dropped block saves as a valid page with its own ids', () => {
    const ed = createEditor(null, { funnelId: 'f', stepId: 's', steps: [], canScripts: false }, { headless: true });
    expect(loadDoc(ed, { version: 2, project: createPageBuilder('t').project([]) }).ok).toBe(true);
    for (const id of ['google-reviews', 'google-reviews-carousel', 'google-rating-badge', 'google-review-request']) expect(ed.Blocks.get(id), id).toBeTruthy();
    const a = ed.Blocks.get('google-reviews')!.get('content') as never;
    const b = ed.Blocks.get('google-review-request')!.get('content') as never;
    ed.addComponents([a, a, b]);
    const project = readProject(ed);
    const r = cleanProject(project);
    expect(r.ok).toBe(true);
    const types = JSON.stringify(project);
    expect((types.match(/"type":"fn-reviews"/g) ?? []).length).toBe(2);
    const ids = [...types.matchAll(/"fn-(?:reviews|review-cta)"[^{}]*?"attributes":\{"id":"([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    ed.destroy();
  });
});

describe('place picker', () => {
  it('searches through the server and returns the chosen place; says when no key exists', async () => {
    let configured = true;
    vi.stubGlobal('fetch', vi.fn(async (u: string) => (u.endsWith('/settings') ? json({ keyConfigured: configured, keySource: configured ? 'workspace' : 'none', defaultPlaceId: 'ChIJdefaultdefault', defaultPlaceName: 'Main Branch', status: 'ok' }) : json({ data: [{ placeId: 'ChIJN1t_tDeuEmsRUsoyG83frY4', name: 'Corner Bakery', address: '1 Main St', rating: 4.7, total: 128 }] }))));
    const onPick = vi.fn();
    const { unmount } = wrap(<PlacePicker placeId="" placeName="" onPick={onPick} />);
    expect(await screen.findByText(/Main Branch/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Search for your business on Google'), 'corner bakery austin');
    await userEvent.click(screen.getByRole('button', { name: 'Search places' }));
    const list = await screen.findByRole('list', { name: 'Places found' });
    await userEvent.click(within(list).getByRole('button', { name: /Corner Bakery/ }));
    expect(onPick).toHaveBeenCalledWith({ placeId: 'ChIJN1t_tDeuEmsRUsoyG83frY4', placeName: 'Corner Bakery' });
    unmount();
    configured = false;
    wrap(<PlacePicker placeId="" placeName="" onPick={onPick} />);
    expect(await screen.findByRole('note')).toHaveTextContent(/No Google API key/);
    expect(screen.getByLabelText('Search for your business on Google')).toBeDisabled();
  });
});

describe('Settings > Google reviews', () => {
  it('shows only a hint of the stored key, saves a new one, and reports a test fetch', async () => {
    const calls: { u: string; m?: string; b?: unknown }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string, i?: RequestInit) => {
      calls.push({ u, m: i?.method, b: i?.body ? JSON.parse(String(i.body)) : undefined });
      if (u.endsWith('/test')) return json({ ok: true, keySource: 'workspace', place: { name: 'Corner Bakery', rating: 4.7, total: 128 }, reviewsReturned: 5 });
      return json({ keyConfigured: true, keySource: 'workspace', workspaceKeyHint: '…abcd', defaultPlaceId: 'ChIJN1t_tDeuEmsRUsoyG83frY4', defaultPlaceName: 'Corner Bakery', status: 'unverified', lastError: null, cacheTtlSeconds: 3600, dailyFetchLimit: 200 });
    }));
    wrap(<GoogleReviewsCard />);
    expect(await screen.findByLabelText('Key hint')).toHaveTextContent('…abcd');
    expect(document.body.textContent).not.toContain('AIza');
    await userEvent.type(screen.getByLabelText(/Replace your Places API key/), 'AIzaSyD-0000000000000000000000000000');
    expect(screen.getByLabelText(/Replace your Places API key/)).toHaveAttribute('type', 'password');
    await userEvent.click(screen.getByRole('button', { name: 'Save key' }));
    await waitFor(() => expect(calls.some((c) => c.m === 'PUT' && (c.b as { apiKey?: string })?.apiKey === 'AIzaSyD-0000000000000000000000000000')).toBe(true));
    await userEvent.click(screen.getByRole('button', { name: 'Test fetch' }));
    expect(await screen.findByTestId('test-result')).toHaveTextContent('Corner Bakery, rating 4.7 from 128 reviews, 5 review(s) returned');
  });
});
