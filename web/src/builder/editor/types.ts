// Adapted from the legacy builder (see docs/PROVENANCE.md): the legacy Section / Row / Column / element component model, its "gjs-element" droppable and
// draggable constraints, and the per-element settings (button action, form, countdown, checkout, FAQ, tabs, popup) are re-expressed here as proper
// GrapesJS component types with typed props (`fnAction`, `fnForm`, ...) instead of DOM attributes and iframes. Only these props are trusted by the server.
import type { Component, Editor } from 'grapesjs';
import { checkoutInner, countdownInner, formInner, progressInner, videoInner, type CountdownProps, type FormProps, type MarkupCtx, type ProductProps, type ProgressProps, type VideoProps } from '@pagemodel';
import { getEnv } from './env';
import { bindClassFlag, bindClassGroups, type ClassGroup } from './classgroups';
import { canDrop, TYPE_LABEL } from './rules';

type Defaults = Record<string, unknown>;
type Trait = Record<string, unknown>;

const typeOf = (c: Component): string => String(c.get('type') ?? 'default');
const dropFn = (dst: string) => (src: Component) => canDrop({ type: typeOf(src), tag: String(src.get('tagName') ?? '') }, dst);

export const randomId = (prefix = 'i'): string => `${prefix}${Math.random().toString(36).slice(2, 8)}`;

const ID_TRAIT: Trait = { type: 'text', name: 'id', label: 'Anchor / ID', placeholder: 'e.g. pricing', changeProp: false };
const ALIGN: ClassGroup = { prop: 'fnAlign', prefix: 'fn-al-', values: ['left', 'center', 'right', 'none'], fallback: 'none', none: 'none' };
const alignTrait = (): Trait => ({ type: 'select', name: 'fnAlign', label: 'Text alignment', changeProp: true, options: [{ id: 'none', label: 'Default' }, { id: 'left', label: 'Left' }, { id: 'center', label: 'Centre' }, { id: 'right', label: 'Right' }] });

const markupCtx = (editor: Editor): MarkupCtx => {
  const env = getEnv(editor);
  return { mode: 'builder', funnelId: env.funnelId, stepId: env.stepId, nextHref: '#' };
};

/** A view whose element content is produced by a pure markup function of the component's typed props: the same function the server publishes with. */
function dynamicView(propName: string, paint: (view: any) => string) {
  return {
    init(this: any) {
      this.listenTo(this.model, `change:${propName} change:attributes:id`, () => this.paintDynamic());
    },
    onRender(this: any) {
      this.paintDynamic();
    },
    paintDynamic(this: any) {
      try {
        this.el.innerHTML = paint(this);
      } catch {
        this.el.textContent = 'This component has invalid settings.';
      }
    },
  };
}

const idOf = (view: any): string => String(view.model.getAttributes().id ?? view.model.getId());

export function registerTypes(editor: Editor): void {
  const dc = editor.Components;
  const add = (id: string, def: { extend?: string; model?: Defaults & { defaults?: Defaults; init?: (this: Component) => void }; view?: Defaults; isComponent?: unknown }) => dc.addType(id, def as never);

  // ---- structure (legacy: Section > Row > Column) ----
  const SECTION_GROUPS: ClassGroup[] = [
    { prop: 'fnWidth', prefix: 'fn-w-', values: ['small', 'medium', 'wide', 'full'], fallback: 'wide' },
    { prop: 'fnPad', prefix: 'fn-pad-', values: ['none', 'sm', 'md', 'lg', 'xl'], fallback: 'lg' },
    { prop: 'fnTheme', prefix: 'fn-', values: ['light', 'dark', 'accent-bg', 'soft'], fallback: 'light', none: 'light' },
    { prop: 'fnSectionAlign', prefix: 'fn-align-', values: ['left', 'center'], fallback: 'left', none: 'left' },
  ];
  add('fn-section', {
    model: {
      defaults: {
        tagName: 'section', name: 'Section', droppable: dropFn('fn-section'), draggable: true, copyable: true,
        traits: [
          { type: 'select', name: 'fnWidth', label: 'Content width', changeProp: true, options: [{ id: 'small', label: 'Small (652px)' }, { id: 'medium', label: 'Medium (994px)' }, { id: 'wide', label: 'Wide (1170px)' }, { id: 'full', label: 'Full width' }] },
          { type: 'select', name: 'fnPad', label: 'Vertical padding', changeProp: true, options: ['none', 'sm', 'md', 'lg', 'xl'].map((v) => ({ id: v, label: v === 'none' ? 'None' : v.toUpperCase() })) },
          { type: 'select', name: 'fnTheme', label: 'Colour theme', changeProp: true, options: [{ id: 'light', label: 'Light' }, { id: 'dark', label: 'Dark (light text)' }, { id: 'accent-bg', label: 'Accent' }, { id: 'soft', label: 'Soft grey' }] },
          { type: 'select', name: 'fnSectionAlign', label: 'Content alignment', changeProp: true, options: [{ id: 'left', label: 'Left' }, { id: 'center', label: 'Centre' }] },
          ID_TRAIT,
        ],
      },
      init(this: Component) {
        bindClassGroups(this, SECTION_GROUPS);
      },
    },
  });
  const ROW_GROUPS: ClassGroup[] = [
    { prop: 'fnRatio', prefix: 'fn-ratio-', values: ['equal', '1-2', '2-1', '1-3', '3-1', '1-2-1'], fallback: 'equal', none: 'equal' },
    { prop: 'fnGap', prefix: 'fn-gap-', values: ['none', 'sm', 'md', 'lg'], fallback: 'md', none: 'md' },
    { prop: 'fnValign', prefix: 'fn-valign-', values: ['stretch', 'start', 'center', 'end'], fallback: 'stretch', none: 'stretch' },
  ];
  add('fn-row', {
    model: {
      defaults: {
        tagName: 'div', name: 'Row', droppable: dropFn('fn-row'), draggable: true, copyable: true,
        traits: [
          { type: 'select', name: 'fnRatio', label: 'Column ratio', changeProp: true, options: [{ id: 'equal', label: 'Equal' }, { id: '1-2', label: '1 : 2' }, { id: '2-1', label: '2 : 1' }, { id: '1-3', label: '1 : 3' }, { id: '3-1', label: '3 : 1' }, { id: '1-2-1', label: '1 : 2 : 1' }] },
          { type: 'select', name: 'fnGap', label: 'Gap', changeProp: true, options: [{ id: 'none', label: 'None' }, { id: 'sm', label: 'Small' }, { id: 'md', label: 'Medium' }, { id: 'lg', label: 'Large' }] },
          { type: 'select', name: 'fnValign', label: 'Vertical alignment', changeProp: true, options: [{ id: 'stretch', label: 'Stretch' }, { id: 'start', label: 'Top' }, { id: 'center', label: 'Middle' }, { id: 'end', label: 'Bottom' }] },
          { type: 'checkbox', name: 'fnKeep', label: 'Keep columns side by side on phones', changeProp: true },
        ],
      },
      init(this: Component) {
        bindClassGroups(this, ROW_GROUPS);
        bindClassFlag(this, 'fnKeep', 'fn-keep');
      },
    },
  });
  add('fn-column', {
    model: {
      defaults: {
        tagName: 'div', name: 'Column', droppable: dropFn('fn-column'), draggable: (src: Component) => typeOf(src) === 'fn-column', copyable: true,
        // Resizing a column changes its share of the row (flex-grow relative to its siblings), so gaps and wrapping keep working.
        resizable: {
          tl: 0, tc: 0, tr: 0, bl: 0, bc: 0, br: 0, cl: 0, cr: 1, minDim: 40, step: 1,
          updateTarget(el: HTMLElement, rect: { w: number }, opts: { component?: Component }) {
            const sibs = [...(el.parentElement?.children ?? [])].filter((s) => s !== el) as HTMLElement[];
            if (!sibs.length || !opts.component) return;
            const view = el.ownerDocument.defaultView!;
            const growSum = sibs.reduce((n, s) => n + (parseFloat(view.getComputedStyle(s).flexGrow) || 1), 0);
            const widthSum = sibs.reduce((n, s) => n + s.getBoundingClientRect().width, 0);
            const grow = Math.max(0.1, Math.min(12, Math.round(((growSum * rect.w) / Math.max(widthSum, 1)) * 10) / 10));
            opts.component.addStyle({ 'flex-grow': String(grow) });
          },
        },
        traits: [{ type: 'number', name: 'fnGrow', label: 'Share of the row', changeProp: true, min: 0.5, max: 12, step: 0.5 }],
      },
      init(this: Component) {
        const read = () => Number.parseFloat(String(this.getStyle()['flex-grow'] ?? '')) || 1;
        this.set('fnGrow', read(), { silent: true });
        this.on('change:fnGrow', () => this.addStyle({ 'flex-grow': String(this.get('fnGrow') || 1) }));
      },
    },
  });

  // ---- text ----
  add('fn-heading', {
    extend: 'text',
    model: {
      defaults: {
        tagName: 'h2', name: 'Heading', droppable: false,
        traits: [{ type: 'select', name: 'fnLevel', label: 'Heading level', changeProp: true, options: [1, 2, 3, 4, 5, 6].map((n) => ({ id: String(n), label: `H${n}` })) }, alignTrait(), ID_TRAIT],
      },
      init(this: Component) {
        bindClassGroups(this, [ALIGN]);
        this.set('fnLevel', String(this.get('tagName') ?? 'h2').replace('h', ''), { silent: true });
        this.on('change:fnLevel', () => this.set('tagName', `h${this.get('fnLevel')}`));
      },
    },
  });
  add('fn-text', {
    extend: 'text',
    model: { defaults: { tagName: 'p', name: 'Text', droppable: false, traits: [alignTrait(), ID_TRAIT] }, init(this: Component) { bindClassGroups(this, [ALIGN]); } },
  });

  const BUTTON_GROUPS: ClassGroup[] = [
    { prop: 'fnVariant', prefix: 'fn-btn-', values: ['primary', 'secondary', 'outline', 'ghost'], fallback: 'primary' },
    { prop: 'fnSize', prefix: 'fn-btn-', values: ['sm', 'md', 'lg'], fallback: 'md', none: 'md' },
    ALIGN,
  ];
  add('fn-button', {
    extend: 'link',
    model: {
      defaults: {
        tagName: 'a', name: 'Button', droppable: false, fnAction: { type: 'none' },
        traits: [
          { type: 'fn-action', name: 'fnAction', label: 'When clicked', changeProp: true },
          { type: 'select', name: 'fnVariant', label: 'Style', changeProp: true, options: [{ id: 'primary', label: 'Primary' }, { id: 'secondary', label: 'Secondary' }, { id: 'outline', label: 'Outline' }, { id: 'ghost', label: 'Ghost' }] },
          { type: 'select', name: 'fnSize', label: 'Size', changeProp: true, options: [{ id: 'sm', label: 'Small' }, { id: 'md', label: 'Medium' }, { id: 'lg', label: 'Large' }] },
          { type: 'checkbox', name: 'fnBlock', label: 'Full width', changeProp: true },
          { type: 'checkbox', name: 'fnPill', label: 'Pill shape', changeProp: true },
          alignTrait(),
        ],
      },
      init(this: Component) {
        bindClassGroups(this, BUTTON_GROUPS);
        bindClassFlag(this, 'fnBlock', 'fn-btn-block');
        bindClassFlag(this, 'fnPill', 'fn-pill');
      },
    },
    // Buttons never navigate inside the canvas.
    view: { events: { click: 'noNav' }, noNav(this: any, e: Event) { e.preventDefault(); } },
  });

  // ---- lists, dividers, spacing ----
  const LIST_GROUPS: ClassGroup[] = [];
  add('fn-list', {
    model: {
      defaults: {
        tagName: 'ul', name: 'List', droppable: dropFn('fn-list'),
        traits: [
          { type: 'checkbox', name: 'fnOrdered', label: 'Numbered list', changeProp: true },
          { type: 'checkbox', name: 'fnChecks', label: 'Check-mark bullets', changeProp: true },
          { type: 'fn-list-items', name: 'fnItems', label: 'Items' },
        ],
      },
      init(this: Component) {
        void LIST_GROUPS;
        this.set('fnOrdered', this.get('tagName') === 'ol', { silent: true });
        bindClassFlag(this, 'fnChecks', 'fn-list-check');
        this.on('change:fnOrdered', () => {
          const ordered = !!this.get('fnOrdered');
          this.set('tagName', ordered ? 'ol' : 'ul');
          if (ordered) this.set('fnChecks', false);
        });
      },
    },
  });
  add('fn-divider', { model: { defaults: { tagName: 'hr', name: 'Divider', droppable: false, void: true, traits: [] } } });
  add('fn-spacer', {
    model: {
      defaults: { tagName: 'div', name: 'Spacer', droppable: false, resizable: { tl: 0, tr: 0, bl: 0, br: 0, cl: 0, cr: 0, tc: 0, bc: 1, minDim: 4, step: 4 }, traits: [{ type: 'number', name: 'fnHeight', label: 'Height (px)', changeProp: true, min: 4, max: 400, step: 4 }], attributes: { 'aria-hidden': 'true' } },
      init(this: Component) {
        this.set('fnHeight', Number.parseInt(String(this.getStyle().height ?? '40'), 10) || 40, { silent: true });
        this.on('change:fnHeight', () => this.addStyle({ height: `${Math.max(4, Math.min(400, Number(this.get('fnHeight')) || 40))}px` }));
      },
    },
  });

  // ---- media ----
  add('image', {
    model: {
      defaults: {
        name: 'Image', droppable: false, activeOnRender: false,
        resizable: { tl: 1, tr: 1, bl: 1, br: 1, tc: 0, bc: 0, cl: 1, cr: 1, ratioDefault: true, minDim: 32, step: 1 },
        traits: [{ type: 'fn-asset', name: 'src', label: 'Image' }, { type: 'text', name: 'alt', label: 'Alt text (describe the image)' }, { type: 'text', name: 'title', label: 'Title (tooltip)' }, alignTrait()],
      },
      init(this: Component) {
        bindClassGroups(this, [ALIGN]);
      },
    },
  });
  add('fn-video', {
    model: { defaults: { tagName: 'div', name: 'Video', droppable: false, fnVideo: { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'Video' }, traits: [{ type: 'fn-video', name: 'fnVideo', label: 'Video', changeProp: true }] } },
    view: dynamicView('fnVideo', (v) => videoInner(v.model.get('fnVideo') as VideoProps, markupCtx(editor))),
  });
  add('fn-countdown', {
    model: { defaults: { tagName: 'div', name: 'Countdown', droppable: false, fnCountdown: { mode: 'evergreen', minutes: 30, label: 'Offer ends in', expiredText: 'This offer has ended' }, traits: [{ type: 'fn-countdown', name: 'fnCountdown', label: 'Countdown', changeProp: true }] } },
    view: dynamicView('fnCountdown', (v) => countdownInner(idOf(v), v.model.get('fnCountdown') as CountdownProps, markupCtx(editor))),
  });
  add('fn-progress', {
    model: { defaults: { tagName: 'div', name: 'Progress bar', droppable: false, fnProgress: { value: 60, label: 'Progress' }, traits: [{ type: 'fn-progress', name: 'fnProgress', label: 'Progress bar', changeProp: true }] } },
    view: dynamicView('fnProgress', (v) => progressInner(v.model.get('fnProgress') as ProgressProps)),
  });

  // ---- lead capture and checkout (server derives the forms/products from these props) ----
  add('fn-form', {
    model: {
      defaults: {
        tagName: 'div', name: 'Form', droppable: false,
        fnForm: {
          name: 'Opt-in form', fields: [{ id: 'name', type: 'name', label: 'First name', required: true }, { id: 'email', type: 'email', label: 'Email address', required: true }], submitLabel: 'Get instant access',
          consent: { enabled: true, text: 'I agree to receive emails and can unsubscribe at any time.' }, success: { type: 'next_step' },
        } satisfies FormProps,
        traits: [{ type: 'fn-form', name: 'fnForm', label: 'Form', changeProp: true }],
      },
    },
    view: dynamicView('fnForm', (v) => formInner(idOf(v), v.model.get('fnForm') as FormProps, markupCtx(editor))),
  });
  add('fn-checkout', {
    model: {
      defaults: {
        tagName: 'div', name: 'Checkout', droppable: false,
        fnProduct: { productName: 'My product', description: 'What the buyer gets.', price: 49, currency: 'USD', buttonLabel: 'Buy now', orderBump: false, oneClickUpsell: false, success: { type: 'next_step' } } satisfies ProductProps,
        traits: [{ type: 'fn-product', name: 'fnProduct', label: 'Product', changeProp: true }],
      },
    },
    view: dynamicView('fnProduct', (v) => checkoutInner(idOf(v), v.model.get('fnProduct') as ProductProps, markupCtx(editor))),
  });
  add('fn-code', {
    model: { defaults: { tagName: 'div', name: 'Custom code', droppable: false, fnCode: { html: '<p>Custom HTML</p>', css: '', js: '' }, traits: [{ type: 'fn-code', name: 'fnCode', label: 'Custom code', changeProp: true }] } },
    // The canvas never runs custom code: it shows the source (escaped) so the editor cannot be attacked through stored page content.
    view: dynamicView('fnCode', (v) => {
      const c = v.model.get('fnCode') as { html: string; css: string; js: string };
      const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
      return `<pre class="fn-code-preview">${esc((c.html || '').slice(0, 600))}${c.css ? `\n/* css: ${c.css.length} chars */` : ''}${c.js ? `\n// script: ${c.js.length} chars (runs on the published page only)` : ''}</pre>`;
    }),
  });

  // ---- FAQ, tabs, popup ----
  add('fn-faq', { model: { defaults: { tagName: 'div', name: 'FAQ', droppable: dropFn('fn-faq'), traits: [{ type: 'fn-faq-items', name: 'fnFaq', label: 'Questions' }] } } });
  add('fn-faq-item', {
    model: { defaults: { tagName: 'details', name: 'FAQ item', droppable: false, traits: [] } },
    // The canvas shows every answer open (an editor-only attribute set on the element, never saved); clicking a question edits it instead of toggling.
    view: {
      events: { click: 'keepOpen' },
      onRender(this: any) { this.el.setAttribute('open', ''); },
      keepOpen(this: any, e: Event) { if ((e.target as HTMLElement).closest('summary')) e.preventDefault(); },
    },
  });
  add('fn-tabs', {
    model: { defaults: { tagName: 'div', name: 'Tabs', droppable: false, traits: [{ type: 'fn-tabs-items', name: 'fnTabs', label: 'Tabs' }] } },
  });
  add('fn-tab-nav', { model: { defaults: { tagName: 'div', name: 'Tab bar', droppable: dropFn('fn-tab-nav'), copyable: false } } });
  add('fn-tab-btn', {
    extend: 'text',
    model: { defaults: { tagName: 'button', name: 'Tab', droppable: false, attributes: { type: 'button' }, copyable: false } },
    view: { events: { click: 'activate' }, activate(this: any, e: Event) { e.preventDefault(); editor.trigger('fn:tab-activate', this.model); } },
  });
  add('fn-tab-panel', { model: { defaults: { tagName: 'div', name: 'Tab panel', droppable: dropFn('fn-tab-panel'), draggable: false, copyable: false } } });
  add('fn-popup', {
    model: {
      defaults: {
        tagName: 'div', name: 'Popup', droppable: false, draggable: (_s: Component, t: Component) => typeOf(t) === 'wrapper',
        traits: [{ type: 'text', name: 'id', label: 'Popup ID (used by buttons that open it)' }, { type: 'fn-popup-open', name: 'fnPopupOpen', label: 'Preview' }],
      },
    },
  });
  add('fn-popup-dialog', { model: { defaults: { tagName: 'div', name: 'Dialog', droppable: dropFn('fn-popup-dialog'), draggable: false, copyable: false, removable: false } } });
  add('fn-box', {
    model: { defaults: { tagName: 'div', name: 'Box', droppable: dropFn('fn-box'), traits: [ID_TRAIT] } },
  });

  void TYPE_LABEL;
}
