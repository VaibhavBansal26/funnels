import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Build } from '../api/aibuild';
import { ToastProvider } from '../components/Toasts';
import { AiBuilderWizard, validateBrief } from './AiBuilder';

vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ can: () => true }) }));

const stages = (statuses: string[]) => ['understanding', 'strategy', 'products', 'copy:s1', 'assembly', 'validation', 'saving'].map((id, i) => ({ id, label: `Stage ${id}`, status: statuses[i] ?? 'pending' }));
const build = (over: Partial<Build> = {}): Build => ({ id: 'gen_1', status: 'running', provider: 'heuristic', model: null, source: null, funnelId: null, stages: stages(['done', 'running']), assumptions: ['No tone was given, so the voice is friendly.'], usage: { inputTokens: 0, outputTokens: 0, calls: 0 }, degraded: false, error: null, createdAt: '', completedAt: null, ...over });
const done = (): Build => build({
  status: 'succeeded', source: 'fallback', degraded: true, funnelId: 'fn_1', model: 'fake-1', stages: stages(['done', 'done', 'skipped', 'fallback', 'done', 'done', 'done']), usage: { inputTokens: 800, outputTokens: 600, calls: 3 },
  strategy: { funnelType: 'local_lead', rationale: 'Local enquiry page.', steps: [{ key: 's1', kind: 'landing', name: 'Landing page', primary: 'form' }, { key: 's2', kind: 'thankyou', name: 'Thank-you page', primary: 'none' }], templates: [{ slug: 'local-restaurant-bakery', name: 'Bakery', score: 7, reason: 'same industry' }] },
  report: { ok: true, checks: [{ id: 'placeholders', status: 'warn', step: 's1', detail: '3 placeholder(s) in [brackets] to replace before launch' }, { id: 'contrast', status: 'pass', step: 's1', detail: 'ok' }], repairs: [], fallbacks: [{ stage: 'copy:s1', reason: 'The AI model took too long to answer.' }] },
  steps: [{ key: 's1', stepId: 'stp_1', name: 'Landing page', kind: 'landing' }, { key: 's2', stepId: 'stp_2', name: 'Thank-you page', kind: 'thankyou' }],
  products: [{ slot: 'main', name: 'Custom cake', amount: 60, currency: 'USD' }],
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function mount(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const f = vi.fn(async (u: string, i?: RequestInit) => handler(String(u), i));
  vi.stubGlobal('fetch', f);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([{ path: '*', element: <QueryClientProvider client={qc}><ToastProvider><AiBuilderWizard /></ToastProvider></QueryClientProvider> }]);
  render(<RouterProvider router={router} />);
  return f;
}
afterEach(() => vi.unstubAllGlobals());

describe('AI funnel builder wizard', () => {
  it('validates the description, then posts the brief with options and shows progress', async () => {
    const f = mount((u, i) => (u === '/api/ai/builds' && i?.method === 'POST' ? json(build({ status: 'queued', stages: [] }), 202) : u.startsWith('/api/ai/builds/gen_1') ? json(build()) : u.startsWith('/api/products') ? json({ data: [], total: 0 }) : json({})));
    expect(validateBrief({ prompt: ' ', offer: '' }).prompt).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'Build my funnel' }));
    expect(screen.getByText('Describe your business in a sentence or two')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/Describe your business/), 'Bakery in Austin selling cakes');
    await userEvent.click(screen.getByLabelText(/Create draft products/));
    await userEvent.click(screen.getByLabelText(/Remove emails/));
    await userEvent.click(screen.getByRole('button', { name: 'Build my funnel' }));
    const progress = await screen.findByTestId('build-progress');
    const post = f.mock.calls.find(([u, i]) => u === '/api/ai/builds' && i?.method === 'POST')!;
    expect(JSON.parse(post[1]!.body as string)).toEqual({ prompt: 'Bakery in Austin selling cakes', options: { products: 'create', redactPii: true } });
    expect(within(progress).getByRole('list', { name: 'Progress' }).querySelectorAll('li')).toHaveLength(7);
    expect(within(progress).getByText('Stage strategy').closest('li')).toHaveAttribute('aria-current', 'step');
    expect(localStorage.getItem('funnels.ai.build')).toBe('gen_1');
  });

  it('resumes a build after a refresh and can cancel it', async () => {
    localStorage.setItem('funnels.ai.build', 'gen_1');
    const f = mount((u, i) => (u === '/api/ai/builds/gen_1/cancel' ? json(build({ status: 'canceled' })) : u === '/api/ai/builds/gen_1' ? json(build()) : json({ data: [] })));
    expect(await screen.findByTestId('build-progress')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(f.mock.calls.some(([u, i]) => u === '/api/ai/builds/gen_1/cancel' && i?.method === 'POST')).toBe(true));
  });

  it('shows the result: plan, assumptions, draft products, checks, fallback notice, and rewrites one page', async () => {
    localStorage.setItem('funnels.ai.build', 'gen_1');
    const f = mount((u) => (u === '/api/ai/builds/gen_1/steps/s1/regenerate' ? json({ source: 'heuristic', stepId: 'stp_1', version: 3 }) : u === '/api/ai/builds/gen_1' ? json(done()) : json({ data: [] })));
    const result = await screen.findByTestId('build-result');
    expect(within(result).getByText(/Your funnel is ready/)).toBeInTheDocument();
    expect(within(result).getByText(/built-in writer instead of the AI model/)).toBeInTheDocument();
    expect(within(result).getByRole('region', { name: 'Assumptions' })).toHaveTextContent('No tone was given');
    expect(within(result).getByRole('region', { name: 'Draft products' })).toHaveTextContent('Custom cake: 60 USD');
    expect(within(result).getByRole('region', { name: 'Checks' })).toHaveTextContent(/1 of 2 checks passed, 1 to review/);
    await userEvent.click(within(result).getByRole('button', { name: 'Rewrite Landing page' }));
    await waitFor(() => expect(f.mock.calls.some(([u]) => u === '/api/ai/builds/gen_1/steps/s1/regenerate')).toBe(true));
  });

  it('a failed build explains why and offers to try again', async () => {
    localStorage.setItem('funnels.ai.build', 'gen_1');
    mount(() => json(build({ status: 'failed', error: { code: 'BUILD_FAILED', message: 'Something went wrong while building the funnel.' } })));
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong');
    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(localStorage.getItem('funnels.ai.build')).toBeNull();
  });
});
