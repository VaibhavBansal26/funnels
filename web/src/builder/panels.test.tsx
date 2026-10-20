import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { Editor } from 'grapesjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPageBuilder } from '@pagemodel';
import { TooltipProvider } from '../ui';
import { createEditor } from './editor/createEditor';
import { loadDoc } from './editor/load';
import { canDrop } from './editor/rules';
import { Inspector } from './panels/Inspector';
import { BlocksPanel, insertBlock } from './panels/BlocksPanel';
import { LayersPanel } from './panels/LayersPanel';
import { ProductTrait } from './panels/traits';
import { BuilderProvider, type BuilderUi } from './useEditor';

vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ can: () => true, session: { user: { permissions: [] }, workspace: { name: 'W' } } }) }));
vi.mock('../api/hooks', async (orig) => ({ ...(await orig<typeof import('../api/hooks')>()), useCustomBlocks: () => ({ data: { data: [] }, isLoading: false }), useMutate: () => ({ mutate: vi.fn(), isPending: false, error: null, reset: vi.fn() }) }));

const ui: BuilderUi = { openAssets: vi.fn(), openShortcuts: vi.fn(), openPageSettings: vi.fn(), openHistory: vi.fn(), saveBlock: vi.fn(), toast: vi.fn(), save: vi.fn(async () => undefined), goToStep: vi.fn() };
let editor: Editor;

function mount(node: React.ReactNode, canScripts = false) {
  editor = createEditor(null, { funnelId: 'f', stepId: 's', steps: [{ id: 's', name: 'Landing' }, { id: 't', name: 'Thanks' }], canScripts }, { headless: true });
  const pm = createPageBuilder('t');
  const project = pm.project([
    pm.section([pm.stack([pm.heading('First headline', { level: 1 }), pm.text('Some copy'), pm.button('Go', { type: 'next_step' })])]),
    pm.section([pm.stack([pm.heading('Second headline'), pm.checkout('co', { productName: 'Course', price: 49, currency: 'USD', buttonLabel: 'Buy now' })])]),
  ]);
  expect(loadDoc(editor, { version: 2, project }).ok).toBe(true);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <BuilderProvider value={{ editor, env: { funnelId: 'f', stepId: 's', steps: [{ id: 's', name: 'Landing' }, { id: 't', name: 'Thanks' }], canScripts }, ui }}>{node}</BuilderProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 40)); });

beforeEach(() => vi.clearAllMocks());
afterEach(() => editor?.destroy());

describe('drop rules (shared by the canvas, the Layers panel and click-to-insert)', () => {
  it('sections only go on the page, rows in sections, columns in rows; elements go in columns (or in a section, which wraps them)', () => {
    expect(canDrop({ type: 'fn-section', tag: 'section' }, 'wrapper')).toBe(true);
    expect(canDrop({ type: 'fn-section', tag: 'section' }, 'fn-column')).toBe(false);
    expect(canDrop({ type: 'fn-section', tag: 'section' }, 'fn-section')).toBe(false);
    expect(canDrop({ type: 'fn-row', tag: 'div' }, 'fn-section')).toBe(true);
    expect(canDrop({ type: 'fn-row', tag: 'div' }, 'fn-row')).toBe(false);
    expect(canDrop({ type: 'fn-column', tag: 'div' }, 'fn-row')).toBe(true);
    expect(canDrop({ type: 'fn-column', tag: 'div' }, 'fn-section')).toBe(false);
    expect(canDrop({ type: 'fn-heading', tag: 'h2' }, 'fn-column')).toBe(true);
    expect(canDrop({ type: 'fn-heading', tag: 'h2' }, 'fn-row')).toBe(false);
    expect(canDrop({ type: 'fn-heading', tag: 'h2' }, 'fn-heading')).toBe(false); // leaf content holds nothing
    expect(canDrop({ type: 'fn-faq-item', tag: 'details' }, 'fn-faq')).toBe(true);
    expect(canDrop({ type: 'fn-faq-item', tag: 'details' }, 'fn-column')).toBe(false);
  });
});

describe('Layers panel', () => {
  it('shows the page structure as a tree and selects the element of a clicked row', async () => {
    mount(<LayersPanel />);
    await flush();
    const tree = screen.getByRole('tree', { name: 'Page layers' });
    const items = within(tree).getAllByRole('treeitem');
    expect(items.length).toBeGreaterThanOrEqual(2);
    fireEvent.click(items[0]!);
    await flush();
    expect(editor.getSelected()?.get('type')).toBe('fn-section');
    expect(items[0]!.getAttribute('aria-selected') ?? items[0]!.getAttribute('aria-current')).toBeTruthy();
  });

  it('locks and unlocks a layer (a locked layer cannot be selected or moved on the canvas)', async () => {
    mount(<LayersPanel />);
    await flush();
    const first = within(screen.getByRole('tree', { name: 'Page layers' })).getAllByRole('treeitem')[0]!;
    fireEvent.click(within(first).getByRole('button', { name: 'Lock layer' }));
    await flush();
    const section = editor.getWrapper()!.components().at(0)!;
    expect(editor.Layers.isLocked(section)).toBe(true);
    fireEvent.click(within(screen.getAllByRole('treeitem')[0]!).getByRole('button', { name: 'Unlock layer' }));
    await flush();
    expect(editor.Layers.isLocked(section)).toBe(false);
  });

  it('is an empty state, not a blank box, for an empty page', async () => {
    mount(<LayersPanel />);
    editor.getWrapper()!.components().reset();
    await flush();
    expect(screen.queryByRole('treeitem')).toBeNull();
    expect(screen.getByText('The page is empty')).toBeInTheDocument();
  });
});

describe('Blocks panel', () => {
  it('groups blocks by category and filters them by search (label, keywords and category)', async () => {
    mount(<BlocksPanel />);
    await flush();
    expect(screen.getByRole('button', { name: /^Add Hero\./ })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Search blocks'), { target: { value: 'faq' } });
    await flush();
    expect(screen.getAllByRole('button', { name: /FAQ/ }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /^Add Hero\./ })).toBeNull();
    fireEvent.change(screen.getByLabelText('Search blocks'), { target: { value: 'zzzz-nothing' } });
    await flush();
    expect(screen.getByText(/No block matches/)).toBeInTheDocument();
  });

  it('hides the custom code block from users who may not author scripts', async () => {
    const { unmount } = mount(<BlocksPanel />, false);
    fireEvent.change(screen.getByLabelText('Search blocks'), { target: { value: 'custom code' } });
    await flush();
    expect(screen.queryByRole('button', { name: /Custom code/ })).toBeNull();
    unmount();
    editor.destroy();
    mount(<BlocksPanel />, true);
    fireEvent.change(screen.getByLabelText('Search blocks'), { target: { value: 'custom code' } });
    await flush();
    expect(screen.getByRole('button', { name: /Custom code/ })).toBeInTheDocument();
  });

  it('click-to-insert follows the same drop rules: an element goes next to the selection, a section goes to the page', async () => {
    mount(<BlocksPanel />);
    await flush();
    const h1 = editor.getWrapper()!.findType('fn-heading')[0]!;
    editor.select(h1);
    const para = insertBlock(editor, editor.Blocks.get('paragraph')!)!;
    expect(para.parent()).toBe(h1.parent());
    expect(h1.parent()!.components().indexOf(para)).toBe(h1.parent()!.components().indexOf(h1) + 1);
    editor.select(h1);
    const section = insertBlock(editor, editor.Blocks.get('section-faq')!)!;
    expect(section.parent()).toBe(editor.getWrapper());
  });
});

describe('Inspector', () => {
  it('asks to select something when nothing is selected, then offers Style, Settings and Advanced', async () => {
    mount(<Inspector />);
    await flush();
    expect(screen.getByText('Select an element')).toBeInTheDocument();
    editor.select(editor.getWrapper()!.findType('fn-heading')[0]!);
    await flush();
    const tabs = screen.getByRole('tablist', { name: 'Inspector' });
    expect(within(tabs).getAllByRole('tab').map((t) => t.textContent?.trim())).toEqual(['Style', 'Settings', 'Advanced']);
  });

  it('styles the element, not its class: a typography change writes one rule on the element', async () => {
    mount(<Inspector />);
    const h1 = editor.getWrapper()!.findType('fn-heading')[0]!;
    editor.select(h1);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Centre' }));
    await flush();
    const rule = editor.Css.getRule(`#${h1.getId()}`);
    expect(rule?.getStyle()['text-align']).toBe('center');
    expect(editor.UndoManager.hasUndo()).toBe(true);
  });
});

describe('typed props editors', () => {
  it('two quick edits of one product both stick (the second does not overwrite the first with a stale copy)', async () => {
    mount(<Inspector />);
    const co = editor.getWrapper()!.findType('fn-checkout')[0]!;
    editor.select(co);
    await flush();
    fireEvent.mouseDown(screen.getByRole('tab', { name: /Settings/ }), { button: 0 }); // Radix tabs activate on mouse down
    await flush();
    const price = screen.getByLabelText('Price', { selector: 'input' });
    const name = screen.getByLabelText('Product name');
    fireEvent.change(price, { target: { value: '79' } });
    fireEvent.change(name, { target: { value: 'Growth plan' } }); // no re-render in between, exactly like fast typing in two fields
    const p = co.get('fnProduct') as { price: number; productName: string };
    expect(p.price).toBe(79);
    expect(p.productName).toBe('Growth plan');
  });

  it('exports ProductTrait for the settings tab', () => {
    expect(typeof ProductTrait).toBe('function');
  });
});
