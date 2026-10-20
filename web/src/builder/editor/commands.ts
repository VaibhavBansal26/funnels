// Adapted from the legacy builder (see docs/PROVENANCE.md): its command set (undo, redo, device switch, preview, history, settings, save, popup) and the move up /
// move down element buttons, as GrapesJS commands plus keymaps. The legacy toolbar of per-element "add row / add element" buttons is replaced by
// real drag and drop, the floating toolbar below and the keyboard shortcuts.
import type { Component, Editor } from 'grapesjs';
import { svgIcon, TOOLBAR_ICONS, type IconKey } from './icons';
import { isElementType } from './rules';

const typeOf = (c: Component): string => String(c.get('type') ?? 'default');
const TEXTY = new Set(['fn-heading', 'fn-text', 'fn-button', 'fn-tab-btn', 'text', 'link']);

/** The component the keyboard and toolbar act on (the first of a multi selection). */
const target = (editor: Editor): Component | undefined => editor.getSelected();

function moveBy(editor: Editor, delta: -1 | 1): boolean {
  const sel = target(editor);
  const parent = sel?.parent();
  if (!sel || !parent) return false;
  const siblings = parent.components();
  const i = siblings.indexOf(sel);
  const to = i + delta;
  if (to < 0 || to >= siblings.length) return false;
  sel.move(parent, { at: to });
  editor.select(sel);
  return true;
}

/** Moves the selection out of its parent, right after the parent (an escape hatch from nesting, the keyboard version of dragging out). */
function moveOut(editor: Editor): boolean {
  const sel = target(editor);
  const parent = sel?.parent();
  const grand = parent?.parent();
  if (!sel || !parent || !grand || !isElementType(typeOf(sel)) && typeOf(sel) !== 'fn-row') return false;
  const at = grand.components().indexOf(parent) + 1;
  const dropInto = grand;
  if (!dropInto.get('droppable')) return false;
  sel.move(dropInto, { at });
  editor.select(sel);
  return true;
}

export function installCommands(editor: Editor): void {
  const cm = editor.Commands;
  cm.add('fn:move-up', { run: (ed) => void moveBy(ed, -1) });
  cm.add('fn:move-down', { run: (ed) => void moveBy(ed, 1) });
  cm.add('fn:move-out', { run: (ed) => void moveOut(ed) });
  cm.add('fn:select-parent', { run: (ed) => { const p = target(ed)?.parent(); if (p && p !== ed.getWrapper()) ed.select(p); } });
  cm.add('fn:ai-rewrite', { run: (ed) => void ed.trigger('fn:ai-rewrite', target(ed)) });
  cm.add('fn:save', { run: (ed) => void ed.trigger('fn:save') });
  cm.add('fn:help', { run: (ed) => void ed.trigger('fn:help') });
  cm.add('fn:delete', { run: (ed) => void ed.runCommand('core:component-delete') });

  const km = editor.Keymaps;
  km.add('fn:save', '⌘+s, ctrl+s', 'fn:save', { prevent: true });
  km.add('fn:duplicate', '⌘+d, ctrl+d', 'tlb-clone', { prevent: true });
  km.add('fn:move-up', 'alt+up', 'fn:move-up', { prevent: true });
  km.add('fn:move-down', 'alt+down', 'fn:move-down', { prevent: true });
  km.add('fn:move-out', 'alt+left', 'fn:move-out', { prevent: true });
  km.add('fn:select-parent', 'shift+up', 'fn:select-parent', { prevent: true });
  km.add('fn:help', 'shift+/', 'fn:help');
  km.add('fn:preview', '⌘+shift+p, ctrl+shift+p', (ed: Editor) => void (ed.Commands.isActive('core:preview') ? ed.stopCommand('core:preview') : ed.runCommand('core:preview')), { prevent: true });
}

/** Floating element toolbar: move handle, select parent, duplicate, delete, plus "rewrite with AI" for text. Rebuilt per selection. */
export function installToolbar(editor: Editor): () => void {
  const build = (c: Component) => {
    const t = typeOf(c);
    const items: Record<string, unknown>[] = [];
    if (c.get('draggable') !== false) items.push({ id: 'fn-move', label: TOOLBAR_ICONS.move(), command: 'tlb-move', attributes: { draggable: true, title: 'Drag to move', 'aria-label': 'Drag to move' } });
    if (c.parent() && c.parent() !== editor.getWrapper()) items.push({ id: 'fn-parent', label: TOOLBAR_ICONS.parent(), command: 'fn:select-parent', attributes: { title: 'Select parent (Shift+Up)', 'aria-label': 'Select parent' } });
    if (c.get('copyable') !== false) items.push({ id: 'fn-clone', label: TOOLBAR_ICONS.clone(), command: 'tlb-clone', attributes: { title: 'Duplicate (Ctrl+D)', 'aria-label': 'Duplicate' } });
    if (TEXTY.has(t) && t !== 'fn-tab-btn') items.push({ id: 'fn-ai', label: TOOLBAR_ICONS.ai(), command: 'fn:ai-rewrite', attributes: { title: 'Rewrite with AI', 'aria-label': 'Rewrite with AI' } });
    if (c.get('removable') !== false) items.push({ id: 'fn-delete', label: TOOLBAR_ICONS.remove(), command: 'tlb-delete', attributes: { title: 'Delete (Del)', 'aria-label': 'Delete' } });
    return items;
  };
  const onSelect = (c: Component) => c.set('toolbar', build(c) as never);
  editor.on('component:selected', onSelect);
  return () => void editor.off('component:selected', onSelect);
}

/** Inline rich text: bold, italic, underline, strikethrough, link (edited in the app's own dialog), clear formatting. Headings and buttons use the same toolbar. */
export function installRte(editor: Editor): void {
  const rte = editor.RichTextEditor;
  for (const a of [...rte.getAll()].map((x) => x.name)) rte.remove(a);
  const mk = (name: string, title: string, icon: IconKey, command: string) =>
    rte.add(name, { icon: svgIcon(icon), attributes: { title, 'aria-label': title }, result: (r: any) => r.exec(command), state: (r: any, doc: Document) => (r && r.doc?.queryCommandState?.(command) ? 1 : 0) } as never);
  mk('bold', 'Bold (Ctrl+B)', 'bold', 'bold');
  mk('italic', 'Italic (Ctrl+I)', 'italic', 'italic');
  mk('underline', 'Underline (Ctrl+U)', 'underline', 'underline');
  mk('strikethrough', 'Strikethrough', 'strike', 'strikeThrough');
  rte.add('link', {
    icon: svgIcon('link'),
    attributes: { title: 'Link', 'aria-label': 'Link' },
    result: (r: any) => {
      const sel = r.selection?.() as Selection | null;
      const anchor = sel?.anchorNode?.parentElement?.closest('a') ?? null;
      editor.trigger('fn:rte-link', { rte: r, range: sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null, href: anchor?.getAttribute('href') ?? '' });
    },
    state: (_r: any, doc: Document) => (doc.getSelection()?.anchorNode?.parentElement?.closest('a') ? 1 : 0),
  } as never);
  mk('clear', 'Clear formatting', 'clear', 'removeFormat');
}
