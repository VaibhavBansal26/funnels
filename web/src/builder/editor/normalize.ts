import type { Component, Editor } from 'grapesjs';
import { canDrop, isElementType } from './rules';
import { randomId } from './types';

const NEEDS_ID = new Set(['fn-form', 'fn-checkout', 'fn-countdown', 'fn-code', 'fn-popup', 'fn-reviews', 'fn-review-cta']);
const typeOf = (c: Component): string => String(c.get('type') ?? 'default');

/**
 * Keeps the page well formed while the author drags things around:
 *  - loose content dropped on the page or directly into a section is wrapped in the section > row > column scaffolding it needs;
 *  - form, checkout, countdown, custom-code and popup components always carry a unique id (the server addresses forms and products by it).
 * Runs synchronously inside the "add" event, so the wrapping and the drop form ONE undo step.
 */
const FULL_BLEED = new Set(['nav', 'footer', 'header']);
/** While a stored page is being loaded nothing may be rewritten: opening a page must never change it. */
export const setNormalizing = (editor: Editor, on: boolean): void => void ((editor as unknown as { __fnPaused?: boolean }).__fnPaused = !on);

export function installNormalizer(editor: Editor): () => void {
  let busy = false;

  const wrap = (c: Component) => {
    const parent = c.parent();
    if (!parent) return;
    const pt = typeOf(parent);
    const t = typeOf(c);
    const isWrapper = pt === 'wrapper' || parent === editor.getWrapper();
    if (isWrapper && t !== 'fn-section' && t !== 'fn-popup' && !FULL_BLEED.has(String(c.get('tagName')))) {
      const at = parent.components().indexOf(c);
      const section = parent.components().add({ type: 'fn-section', tagName: 'section', classes: ['fn-section', 'fn-w-wide', 'fn-pad-md'] }, { at }) as Component;
      let host: Component = section;
      if (t !== 'fn-row') {
        const row = section.components().add({ type: 'fn-row', tagName: 'div', classes: ['fn-row'] }) as Component;
        host = row.components().add({ type: 'fn-column', tagName: 'div', classes: ['fn-column'] }) as Component;
      }
      c.move(host, { at: 0 });
      return;
    }
    if (pt === 'fn-section' && isElementType(t)) {
      const at = parent.components().indexOf(c);
      const row = parent.components().add({ type: 'fn-row', tagName: 'div', classes: ['fn-row'] }, { at }) as Component;
      const col = row.components().add({ type: 'fn-column', tagName: 'div', classes: ['fn-column'] }) as Component;
      c.move(col, { at: 0 });
    }
  };

  const ensureId = (c: Component) => {
    if (!NEEDS_ID.has(typeOf(c))) return;
    const id = String(c.getAttributes().id ?? '');
    const dup = id && editor.getWrapper()?.find(`#${CSS.escape(id)}`).filter((o) => o !== c).length;
    if (!id || dup) c.addAttributes({ id: randomId(typeOf(c).replace('fn-', '').slice(0, 1)) });
  };

  const onAdd = (c: Component) => {
    if (busy || (editor as unknown as { __fnPaused?: boolean }).__fnPaused) return;
    busy = true;
    try {
      ensureId(c);
      c.components().forEach?.((k: Component) => ensureId(k));
      c.forEachChild?.((k: Component) => ensureId(k));
      wrap(c);
    } finally {
      busy = false;
    }
  };
  editor.on('component:add', onAdd);
  return () => void editor.off('component:add', onAdd);
}

/** Make the page itself reject content that cannot live at the top level. */
export function setWrapperRules(editor: Editor): void {
  editor.getWrapper()?.addAttributes({ id: 'fnroot' });
  editor.getWrapper()?.set({ droppable: (src: Component) => canDrop({ type: typeOf(src), tag: String(src.get('tagName') ?? '') }, 'wrapper'), name: 'Page' });
}
