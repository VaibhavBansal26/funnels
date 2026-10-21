import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Editor } from 'grapesjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPageBuilder } from '@pagemodel';
import { TooltipProvider } from '../ui';
import { createEditor } from './editor/createEditor';
import { loadDoc } from './editor/load';
import { AiPanel } from './panels/AiPanel';
import { BuilderProvider, type BuilderUi } from './useEditor';

let can = true;
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ can: () => can }) }));

const ui: BuilderUi = { openAssets: vi.fn(), openShortcuts: vi.fn(), openPageSettings: vi.fn(), openHistory: vi.fn(), saveBlock: vi.fn(), toast: vi.fn(), save: vi.fn(async () => undefined), goToStep: vi.fn() };
let editor: Editor;
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

function mount() {
  editor = createEditor(null, { funnelId: 'f', stepId: 's', steps: [], canScripts: false }, { headless: true });
  const pm = createPageBuilder('t');
  loadDoc(editor, { version: 2, project: pm.project([pm.section([pm.stack([pm.heading('We bake the best cakes in town', { level: 1 }), pm.text('Order online and we deliver fresh to your door.')])]), pm.footer('© Bakery')]) });
  const qc = new QueryClient();
  return render(<QueryClientProvider client={qc}><TooltipProvider><BuilderProvider value={{ editor, env: { funnelId: 'f', stepId: 's', steps: [], canScripts: false }, ui }}><AiPanel /></BuilderProvider></TooltipProvider></QueryClientProvider>);
}
beforeEach(() => { can = true; vi.clearAllMocks(); });
afterEach(() => { editor?.destroy(); vi.unstubAllGlobals(); });
const h1 = () => editor.getWrapper()!.findType('fn-heading')[0]!;
const text = () => JSON.stringify(editor.getProjectData());

describe('AI assistant panel', () => {
  it('sends the outline and selection, shows a diff, previews as one undo step, and Undo changes reverts it', async () => {
    const f = vi.fn(async (_u: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return json({ summary: 'Shorter hero', source: 'model', ops: [{ op: 'setText', target: body.selectedId, text: 'Fresh cakes daily' }, { op: 'restyle', target: body.selectedId, style: { 'text-align': 'center' } }] });
    });
    vi.stubGlobal('fetch', f);
    mount();
    editor.select(h1());
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(screen.getByRole('status', { name: '' }) ?? null).toBeTruthy();
    await userEvent.type(screen.getByLabelText('What should change?'), 'Make the hero shorter');
    await userEvent.click(screen.getByRole('button', { name: /Suggest changes/ }));
    const proposal = await screen.findByTestId('ai-proposal');
    const body = JSON.parse(String(f.mock.calls[0]![1]!.body));
    expect(body.instruction).toBe('Make the hero shorter');
    expect(body.selectedId).toBe(h1().getId());
    expect(JSON.stringify(body.outline)).toContain('We bake the best cakes in town');
    expect(within(proposal).getByText('Suggested by the AI model. Review before applying.')).toBeInTheDocument();
    expect(proposal.querySelector('del')).toHaveTextContent('We bake the best cakes in town');
    expect(proposal.querySelector('ins')).toHaveTextContent('Fresh cakes daily');
    const before = text();
    expect(before).not.toContain('Fresh cakes daily');
    await userEvent.click(within(proposal).getByRole('button', { name: 'Preview on the page' }));
    expect(text()).toContain('Fresh cakes daily');
    await userEvent.click(within(proposal).getByRole('button', { name: 'Undo changes' }));
    expect(text().replace(/"attributes":\{"id":"[^"]+"\},/g, '')).toBe(before.replace(/"attributes":\{"id":"[^"]+"\},/g, ''));
    expect(screen.queryByTestId('ai-proposal')).toBeNull();
  });

  it('Keep changes leaves the page edited; Discard never touches it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ summary: 'Add FAQ', source: 'heuristic', ops: [{ op: 'insert', target: editor.getWrapper()!.getId(), position: 'end', node: { type: 'section', children: [{ type: 'faq', items: [{ q: 'Shipping?', a: '[Add answer.]' }] }] } }] })));
    mount();
    await userEvent.type(screen.getByLabelText('What should change?'), 'add an FAQ about shipping');
    await userEvent.click(screen.getByRole('button', { name: /Suggest changes/ }));
    let proposal = await screen.findByTestId('ai-proposal');
    expect(within(proposal).getByText(/Add a section at the end of the page/)).toBeInTheDocument();
    await userEvent.click(within(proposal).getByRole('button', { name: 'Discard' }));
    expect(text()).not.toContain('Shipping?');
    await userEvent.click(screen.getByRole('button', { name: /Suggest changes/ }));
    proposal = await screen.findByTestId('ai-proposal');
    await userEvent.click(within(proposal).getByRole('button', { name: 'Preview on the page' }));
    await userEvent.click(within(proposal).getByRole('button', { name: 'Keep changes' }));
    expect(text()).toContain('Shipping?');
    expect(editor.UndoManager.hasUndo()).toBe(true);
  });

  it('explains unsupported requests and server errors; examples fill the box; needs permissions', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ summary: 'No changes', source: 'heuristic', ops: [], message: 'The built-in assistant cannot translate.' })));
    mount();
    await userEvent.click(screen.getByRole('button', { name: 'Translate to Spanish' }));
    expect(screen.getByLabelText('What should change?')).toHaveValue('Translate to Spanish');
    await userEvent.click(screen.getByRole('button', { name: /Suggest changes/ }));
    const proposal = await screen.findByTestId('ai-proposal');
    expect(proposal).toHaveTextContent('cannot translate');
    expect(within(proposal).getByRole('button', { name: 'Preview on the page' })).toBeDisabled();
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { code: 'AI_DAILY_CAP_REACHED', message: 'The daily AI request limit has been reached' } }, 429)));
    await userEvent.click(within(proposal).getByRole('button', { name: 'Discard' }));
    await userEvent.click(screen.getByRole('button', { name: /Suggest changes/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('daily AI request limit');
  });

  it('shows a note instead of the controls without ai:use and funnels:write', () => {
    can = false;
    mount();
    expect(screen.getByRole('note')).toHaveTextContent(/permissions/);
    expect(screen.queryByLabelText('What should change?')).toBeNull();
  });
});
