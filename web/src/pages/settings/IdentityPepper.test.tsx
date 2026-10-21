import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../components/Toasts';
import { IdentityPepper, pepperErrorMessage } from './IdentityPepper';
import { ApiError } from '../../api/client';

let perms: string[] = ['analytics_identity:manage', 'analytics:export'];
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ can: (p: string) => perms.includes(p) }) }));

const info = { pepper: 'a'.repeat(8) + 'b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8', version: 2, algorithm: 'HMAC-SHA256', fingerprint: '1a2b3c4d', rotatedAt: '2030-01-02T00:00:00.000Z' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const err = (code: string, message: string, status = 400) => json({ error: { code, message } }, status);

function mount(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>) {
  const f = vi.fn(fetchImpl);
  vi.stubGlobal('fetch', f);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><ToastProvider><IdentityPepper /></ToastProvider></QueryClientProvider>);
  return f;
}

afterEach(() => { vi.unstubAllGlobals(); perms = ['analytics_identity:manage', 'analytics:export']; });

describe('identity pepper settings', () => {
  it('shows the fingerprint without revealing the pepper until asked', async () => {
    mount(async () => json(info));
    expect(await screen.findByLabelText('Pepper fingerprint')).toHaveTextContent('1a2b3c4d');
    expect(screen.queryByLabelText('Identity pepper')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Show the pepper' }));
    expect(screen.getByLabelText('Identity pepper')).toHaveTextContent(info.pepper);
    expect(screen.getByRole('button', { name: 'Copy fingerprint 1a2b3c4d' })).toBeInTheDocument();
  });

  it('imports a pepper with the confirmation and clears the form on success', async () => {
    const f = mount(async (_u, init) => (init?.method === 'PUT' ? json({ ...info, fingerprint: 'deadbeef', version: 3 }) : json(info)));
    await screen.findByLabelText('Pepper fingerprint');
    await userEvent.type(screen.getByLabelText('Pepper'), 'Zx9-correct-horse-battery-staple-ABCDEFG');
    await userEvent.type(screen.getByLabelText('Type the pepper again'), 'Zx9-correct-horse-battery-staple-ABCDEFG');
    await userEvent.click(screen.getByRole('button', { name: 'Import pepper' }));
    await waitFor(() => expect(f.mock.calls.some(([, i]) => i?.method === 'PUT')).toBe(true));
    const put = f.mock.calls.find(([, i]) => i?.method === 'PUT')!;
    expect(put[0]).toBe('/api/v1/analytics/identity-pepper');
    expect(JSON.parse(put[1]!.body as string)).toEqual({ pepper: 'Zx9-correct-horse-battery-staple-ABCDEFG', confirm: 'Zx9-correct-horse-battery-staple-ABCDEFG' });
    await waitFor(() => expect(screen.getByLabelText('Pepper')).toHaveValue(''));
  });

  it('shows INVALID_PEPPER on the pepper field and PEPPER_CONFIRM_MISMATCH on the confirmation field', async () => {
    let next: Response = err('INVALID_PEPPER', 'The pepper must be at least 32 characters');
    mount(async (_u, init) => (init?.method === 'PUT' ? next.clone() : json(info)));
    await screen.findByLabelText('Pepper fingerprint');
    await userEvent.type(screen.getByLabelText('Pepper'), 'short');
    await userEvent.type(screen.getByLabelText('Type the pepper again'), 'short');
    await userEvent.click(screen.getByRole('button', { name: 'Import pepper' }));
    expect(await screen.findByText('The pepper must be at least 32 characters')).toBeInTheDocument();
    expect(screen.getByLabelText('Pepper')).toHaveAttribute('aria-invalid', 'true');
    next = err('PEPPER_CONFIRM_MISMATCH', 'The confirmation does not match the pepper');
    await userEvent.click(screen.getByRole('button', { name: 'Import pepper' }));
    expect(await screen.findByText(/two values do not match/)).toBeInTheDocument();
    expect(screen.getByLabelText('Type the pepper again')).toHaveAttribute('aria-invalid', 'true');
  });

  it('rotate warns that the join with other apps breaks, and only rotates after confirming', async () => {
    const f = mount(async (_u, init) => (init?.method === 'POST' ? json({ ...info, fingerprint: 'cafe0000' }) : json(info)));
    await screen.findByLabelText('Pepper fingerprint');
    await userEvent.click(screen.getByRole('button', { name: 'Rotate' }));
    expect(screen.getByRole('dialog')).toHaveTextContent(/breaks the join with any other app until the same pepper is set there/);
    expect(f.mock.calls.some(([, i]) => i?.method === 'POST')).toBe(false);
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Rotate' }));
    await waitFor(() => expect(f.mock.calls.some(([u, i]) => i?.method === 'POST' && String(u).endsWith('/rotate'))).toBe(true));
  });

  it('is disabled with an explanation without both permissions and never fetches the pepper', async () => {
    perms = ['analytics_identity:manage'];
    const f = mount(async () => json(info));
    expect(screen.getByRole('note')).toHaveTextContent(/analytics:export/);
    expect(screen.getByRole('button', { name: 'Rotate' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Show the pepper' })).toBeDisabled();
    expect(screen.getByLabelText('Pepper')).toBeDisabled();
    expect(f).not.toHaveBeenCalled();
  });

  it('error messages: known codes get friendly text, others pass through', () => {
    expect(pepperErrorMessage(new ApiError(400, 'PEPPER_CONFIRM_MISMATCH', 'x'))).toMatch(/do not match/);
    expect(pepperErrorMessage(new ApiError(400, 'INVALID_PEPPER', 'too short'))).toBe('too short');
    expect(pepperErrorMessage(new ApiError(500, 'HTTP_ERROR', 'boom'))).toBe('boom');
  });
});
