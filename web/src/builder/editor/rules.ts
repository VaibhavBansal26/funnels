// Adapted from the legacy builder (see docs/PROVENANCE.md): its drag/drop constraints (".gjs-column-inner, .gjs-row .gjs-column" selectors on every
// element, sections only on the wrapper, rows only in sections) expressed as one pure function instead of selector strings on each component.

/** Component types that are structure, not content. */
const STRUCTURE = new Set(['wrapper', 'fn-section', 'fn-row', 'fn-column', 'fn-popup', 'fn-popup-dialog', 'fn-faq-item', 'fn-tab-nav', 'fn-tab-btn', 'fn-tab-panel']);
const CONTAINERS = new Set(['fn-column', 'fn-box', 'fn-tab-panel', 'fn-popup-dialog']);

export interface Dragged {
  type: string;
  tag?: string;
}

/**
 * May a component of kind `src` be dropped INTO a component of type `dst`?
 *  - the page accepts anything (non-sections are wrapped in a section automatically);
 *  - a section holds rows and elements, a row holds columns, a column / card / tab panel / popup holds elements and nested rows;
 *  - FAQ items, tab buttons and list items only live in their own parent; leaf content (text, forms, ...) holds nothing.
 */
export function canDrop(src: Dragged, dst: string): boolean {
  if (src.type === 'wrapper') return false;
  if (src.tag === 'li') return dst === 'fn-list';
  switch (dst) {
    case 'wrapper':
      return !['fn-column', 'fn-faq-item', 'fn-tab-btn', 'fn-tab-panel', 'fn-tab-nav', 'fn-popup-dialog'].includes(src.type);
    case 'fn-section':
      return !['fn-section', 'fn-column', 'fn-popup', 'fn-faq-item', 'fn-tab-btn', 'fn-tab-nav', 'fn-tab-panel', 'fn-popup-dialog'].includes(src.type);
    case 'fn-row':
      return src.type === 'fn-column';
    case 'fn-faq':
      return src.type === 'fn-faq-item';
    case 'fn-tab-nav':
      return src.type === 'fn-tab-btn';
    default:
      if (CONTAINERS.has(dst)) return !STRUCTURE.has(src.type) || src.type === 'fn-row';
      return false;
  }
}

/** Elements are everything that can sit in a column. */
export const isElementType = (type: string): boolean => !STRUCTURE.has(type);

/** The legacy builder's component names for layers (kept: "Section", "Row", "Column") plus ours. */
export const TYPE_LABEL: Record<string, string> = {
  wrapper: 'Page', 'fn-section': 'Section', 'fn-row': 'Row', 'fn-column': 'Column', 'fn-heading': 'Heading', 'fn-text': 'Text', 'fn-button': 'Button', 'fn-list': 'List',
  'fn-divider': 'Divider', 'fn-spacer': 'Spacer', image: 'Image', 'fn-video': 'Video', 'fn-faq': 'FAQ', 'fn-faq-item': 'FAQ item', 'fn-tabs': 'Tabs', 'fn-tab-nav': 'Tab bar',
  'fn-tab-btn': 'Tab', 'fn-tab-panel': 'Tab panel', 'fn-countdown': 'Countdown', 'fn-progress': 'Progress bar', 'fn-form': 'Form', 'fn-checkout': 'Checkout', 'fn-code': 'Custom code', 'fn-reviews': 'Google reviews', 'fn-review-cta': 'Review request',
  'fn-popup': 'Popup', 'fn-popup-dialog': 'Dialog', 'fn-box': 'Box', link: 'Link', text: 'Text', textnode: 'Text', default: 'Box',
};
