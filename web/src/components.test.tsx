import { createBuilder } from '@blocks';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api/client';
import type { FunnelDetail, Step } from './api/types';
import { AuthProvider } from './auth/AuthContext';
import { Inspector, type InspectorProps } from './builder/Inspector';
import { ConflictDialog } from './components/ConflictDialog';
import { ToastProvider, useToast } from './components/Toasts';
import { ErrorBanner, Modal } from './components/ui';
import { LoginPage } from './pages/AuthPages';
import { StepsTab } from './pages/StepsTab';

const wrap = (ui: React.ReactElement, path = '/') => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([{ path: '*', element: <QueryClientProvider client={qc}><ToastProvider><AuthProvider>{ui}</AuthProvider></ToastProvider></QueryClientProvider> }], { initialEntries: [path] });
  return render(<RouterProvider router={router} />);
};

afterEach(() => vi.unstubAllGlobals());

function inspectorProps(block: InspectorProps['block'], over: Partial<InspectorProps> = {}): InspectorProps {
  return { block, steps: [{ id: 's1', name: 'Landing' }, { id: 's2', name: 'Thanks' }], onChange: vi.fn(), onRemove: vi.fn(), onDuplicate: vi.fn(), onMove: vi.fn(), onMoveOut: vi.fn(), onMoveIntoPrevious: vi.fn(), onAddColumn: vi.fn(), onRemoveColumn: vi.fn(), canMoveUp: true, canMoveDown: true, ...over };
}

describe('block inspector', () => {
  it('edits a heading: text, level and toolbar actions', async () => {
    const p = inspectorProps(createBuilder('h').heading('Hello'));
    render(<Inspector {...p} />);
    const text = screen.getByLabelText('Text');
    fireEvent.change(text, { target: { value: 'Hello world' } });
    expect(p.onChange).toHaveBeenCalledWith({ text: 'Hello world' }, 'h1:text');
    fireEvent.change(screen.getByLabelText('Level'), { target: { value: '1' } });
    expect(p.onChange).toHaveBeenCalledWith({ level: 1 }, 'h1:level');
    await userEvent.click(screen.getByRole('button', { name: 'Move block up' }));
    expect(p.onMove).toHaveBeenCalledWith(-1);
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(p.onRemove).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Move block out of its container' })).toBeDisabled();
  });

  it('button action editor offers steps, links and anchors', () => {
    const p = inspectorProps(createBuilder('b').button('Go'));
    render(<Inspector {...p} />);
    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'step' } });
    expect(p.onChange).toHaveBeenLastCalledWith({ action: { type: 'step', stepId: 's1' } }, 'b1:action');
    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'link' } });
    expect(p.onChange).toHaveBeenLastCalledWith({ action: { type: 'link', url: 'https://' } }, 'b1:action');
  });

  it('shows the target step selector for step actions', () => {
    const blk = { ...createBuilder('b').button('Go'), action: { type: 'step' as const, stepId: 's2' } };
    render(<Inspector {...inspectorProps(blk)} />);
    expect((screen.getByLabelText('Target step') as HTMLSelectElement).value).toBe('s2');
  });

  it('form editor: validates field ids, edits and removes fields', async () => {
    const form = createBuilder('f').form({ fields: [{ id: 'email', type: 'email', label: 'Email', required: true }, { id: 'name', type: 'name', label: 'Name', required: false }] });
    const p = inspectorProps(form);
    const { rerender } = render(<Inspector {...p} />);
    fireEvent.change(screen.getAllByLabelText('Label')[1]!, { target: { value: 'Full name' } });
    const call = (p.onChange as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
    expect(call[0].fields[1]).toMatchObject({ id: 'name', label: 'Full name' });
    await userEvent.click(screen.getByRole('button', { name: 'Remove field 2' }));
    expect((p.onChange as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0].fields).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Remove field 1' }).hasAttribute('disabled')).toBe(false);
    // an invalid id coming back from the document is reported on the field
    const f = form as Extract<typeof form, { type: 'form' }>;
    const bad = { ...f, fields: [f.fields[0]!, { ...f.fields[1]!, id: 'Bad Id' }] };
    rerender(<Inspector {...inspectorProps(bad)} />);
    expect(screen.getAllByRole('alert')[0]).toHaveTextContent(/lowercase/i);
    expect(screen.getAllByLabelText('Field id')[1]).toHaveAttribute('aria-invalid', 'true');
  });

  it('checkout: bump and upsell are mutually exclusive; price edits are numbers', () => {
    const p = inspectorProps(createBuilder('c').checkout({ productName: 'Course', price: 49 }));
    render(<Inspector {...p} />);
    fireEvent.click(screen.getByLabelText(/Order bump/));
    expect(p.onChange).toHaveBeenLastCalledWith({ orderBump: true, oneClickUpsell: false }, 'c1:orderBump,oneClickUpsell');
    fireEvent.change(screen.getByLabelText('Price'), { target: { value: '19.5' } });
    expect(p.onChange).toHaveBeenLastCalledWith({ price: 19.5 }, 'c1:price');
  });

  it('columns: add and remove columns, with limits', async () => {
    const cols = createBuilder('x').columns([[], [], [], [], []]);
    const p = inspectorProps(cols);
    render(<Inspector {...p} />);
    expect(screen.getByRole('button', { name: 'Add column' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Remove column 2' }));
    expect(p.onRemoveColumn).toHaveBeenCalledWith(1);
  });

  it('renders the AI slot for text blocks and reports invalid colors', () => {
    const p = inspectorProps({ ...createBuilder('p').paragraph('Hi'), color: 'red;x:y' } as InspectorProps['block'], { aiSlot: <div>AI helper</div> });
    render(<Inspector {...p} />);
    expect(screen.getByText('AI helper')).toBeInTheDocument();
    expect(screen.getByText('Invalid color')).toBeInTheDocument();
  });
});

describe('step list: keyboard reordering', () => {
  const step = (i: number): Step => ({ id: `s${i}`, funnelId: 'f', name: `Step ${i}`, path: `/p${i}`, position: i, title: null, seoDescription: null, customCss: null, headerTrackingCode: null, footerTrackingCode: null, version: 1, isDomainHome: false, isDomain404: false, createdAt: '', updatedAt: '' });
  const funnel = { id: 'f', name: 'F', domain: null, steps: [step(1), step(2), step(3)] } as unknown as FunnelDetail;

  it('Alt+ArrowDown moves the focused step and sends the contiguous order; failures roll back', async () => {
    const f = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    vi.stubGlobal('fetch', f);
    wrap(<StepsTab funnel={funnel} />);
    const rows = () => screen.getAllByRole('listitem').map((li) => within(li).getByText(/^Step \d$/).textContent);
    expect(rows()).toEqual(['Step 1', 'Step 2', 'Step 3']);
    const first = screen.getAllByRole('listitem')[0]!;
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown', altKey: true });
    await waitFor(() => expect(rows()).toEqual(['Step 2', 'Step 1', 'Step 3']));
    await waitFor(() => expect(f).toHaveBeenCalled());
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('/api/funnels/f/steps/order');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ orders: [{ stepId: 's2', order: 1 }, { stepId: 's1', order: 2 }, { stepId: 's3', order: 3 }] });
  });

  it('plain arrows do nothing, and a server error restores the original order with an alert', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'INCOMPLETE_ORDER', message: 'The list must include every step' } }), { status: 400 })));
    wrap(<StepsTab funnel={funnel} />);
    const rows = () => screen.getAllByRole('listitem').map((li) => within(li).getByText(/^Step \d$/).textContent);
    const first = screen.getAllByRole('listitem')[0]!;
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(rows()).toEqual(['Step 1', 'Step 2', 'Step 3']);
    await userEvent.click(screen.getByRole('button', { name: 'Move Step 1 down' }));
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0));
    await waitFor(() => expect(rows()).toEqual(['Step 1', 'Step 2', 'Step 3']));
  });

  it('first step cannot move up and last cannot move down', () => {
    wrap(<StepsTab funnel={funnel} />);
    expect(screen.getByRole('button', { name: 'Move Step 1 up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Step 3 down' })).toBeDisabled();
  });
});

describe('API error display', () => {
  it('shows message and code, offers retry', async () => {
    const retry = vi.fn();
    render(<ErrorBanner error={new ApiError(409, 'DOMAIN_NOT_ACTIVE', 'The domain is not verified yet')} onRetry={retry} />);
    expect(screen.getByRole('alert')).toHaveTextContent('The domain is not verified yet');
    expect(screen.getByRole('alert')).toHaveTextContent('DOMAIN_NOT_ACTIVE');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalled();
  });
  it('renders nothing without an error and a friendly text for network failures', () => {
    const { container, rerender } = render(<ErrorBanner error={null} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<ErrorBanner error={new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server. Check your connection and try again.')} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Cannot reach the server');
  });
  it('conflict dialog lists conflicts, validates replacements and submits them', async () => {
    const onConfirm = vi.fn();
    render(<ConflictDialog conflicts={[{ path: '/promo', resolved_path: '/promo-1001', conflictsWith: { funnelName: 'A', stepName: 'Landing' } }]} onConfirm={onConfirm} onCancel={() => undefined} />);
    expect(screen.getByText('A → Landing')).toBeInTheDocument();
    const input = screen.getByLabelText('New path for /promo');
    fireEvent.change(input, { target: { value: 'bad path' } });
    expect(screen.getByRole('alert')).toHaveTextContent('letters, digits');
    expect(screen.getByRole('button', { name: /Rename paths/ })).toBeDisabled();
    fireEvent.change(input, { target: { value: '/promo-2' } });
    await userEvent.click(screen.getByRole('button', { name: /Rename paths/ }));
    expect(onConfirm).toHaveBeenCalledWith([{ path: '/promo', resolved_path: '/promo-2' }]);
  });
});

describe('login form validation', () => {
  it('blocks submission and shows accessible field errors, then shows server errors', async () => {
    const f = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Invalid email or password' } }), { status: 401 }));
    vi.stubGlobal('fetch', f);
    wrap(<LoginPage />, '/login');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(screen.getByText('Enter your email address')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
    expect(f).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText('Email'), 'a@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong-password');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Invalid email or password')).toBeInTheDocument();
    expect(JSON.parse(f.mock.calls[0]![1].body)).toEqual({ email: 'a@example.com', password: 'wrong-password' });
  });
});

describe('modal and toasts', () => {
  it('modal is labelled, focuses its first control, closes on Escape and traps Tab', async () => {
    const onClose = vi.fn();
    render(<Modal title="Edit thing" onClose={onClose}><button>First</button><button>Last</button></Modal>);
    const dialog = screen.getByRole('dialog', { name: 'Edit thing' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('button', { name: 'Close dialog' })).toHaveFocus();
    screen.getByRole('button', { name: 'Last' }).focus();
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Close dialog' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('toasts announce and can be dismissed', async () => {
    function Button() {
      const t = useToast();
      return <button onClick={() => t.push('Saved!', 'ok')}>go</button>;
    }
    render(<ToastProvider ttl={0}><Button /></ToastProvider>);
    await userEvent.click(screen.getByText('go'));
    expect(screen.getByRole('status')).toHaveTextContent('Saved!');
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    expect(screen.queryByText('Saved!')).not.toBeInTheDocument();
  });
});
