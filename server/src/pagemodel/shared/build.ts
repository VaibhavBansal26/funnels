import type { ButtonActionProps, CountdownProps, FormProps, ProductProps } from './props.js';
import { PROJECT_VERSION, emptyProject, type GjsNode, type GjsProject, type GjsRule } from './clean.js';
import { FONT_STACKS } from './css.js';

/**
 * Programmatic construction of project data: used by the legacy converter, the native template seeds, the default page and the
 * builder's block library (so a block dragged from the panel is exactly what a template contains). The result is always passed
 * through `cleanProject` before it is stored or rendered, so this module needs no escaping of its own.
 */
export type Width = 'full' | 'wide' | 'medium' | 'small';
export type Pad = 'none' | 'sm' | 'md' | 'lg' | 'xl';
export type Align = 'left' | 'center' | 'right';
export type Theme = 'light' | 'dark' | 'accent' | 'soft';

export interface NodeOpts {
  id?: string;
  classes?: string[];
  style?: Record<string, string>;
  name?: string;
}

/** Relative luminance based dark/light decision for a CSS colour (hex, rgb()). Unknown colours count as light. */
export function isDarkColor(color: string): boolean {
  const c = color.trim().toLowerCase();
  let r: number, g: number, b: number;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(c);
  if (hex) {
    let h = hex[1]!;
    if (h.length === 3) h = [...h].map((x) => x + x).join('');
    r = parseInt(h.slice(0, 2), 16);
    g = parseInt(h.slice(2, 4), 16);
    b = parseInt(h.slice(4, 6), 16);
  } else {
    const m = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/.exec(c);
    if (!m) return false;
    r = +m[1]!;
    g = +m[2]!;
    b = +m[3]!;
  }
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return L < 0.3;
}

export type InlineNode = GjsNode;
export type RowOpts = NodeOpts & { gap?: 'none' | 'sm' | 'md' | 'lg'; ratio?: '1-2' | '2-1' | '1-3' | '3-1' | '1-2-1'; valign?: 'start' | 'center' | 'end'; keep?: boolean };

/** Short copy with **bold**, *italic* and [text](url) becomes text components (what the rich text editor would have produced). */
export function inlineNodes(raw: string): InlineNode[] {
  const re = /\[([^\]\n]{1,200})\]\(([^)\s]{1,2000})\)|\*\*([^*\n]{1,500})\*\*|\*([^*\n]{1,500})\*/g;
  const out: InlineNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  const t = (content: string): InlineNode => ({ type: 'textnode', content });
  while ((m = re.exec(raw))) {
    if (m.index > last) out.push(t(raw.slice(last, m.index)));
    if (m[1] !== undefined) out.push({ type: 'link', tagName: 'a', attributes: { href: m[2]!, rel: 'noopener noreferrer nofollow' }, components: [t(m[1])] });
    else if (m[3] !== undefined) out.push({ type: 'text', tagName: 'b', components: [t(m[3])] });
    else out.push({ type: 'text', tagName: 'i', components: [t(m[4]!)] });
    last = re.lastIndex;
  }
  if (last < raw.length) out.push(t(raw.slice(last)));
  return out.length ? out : [t('')];
}

export function createPageBuilder(prefix = 'p') {
  let n = 0;
  const rules: GjsRule[] = [];
  const nextId = () => `${prefix}${++n}`;

  /** Applies shared options; a node that needs styles gets an id and a matching rule. */
  const fin = (node: GjsNode, o: NodeOpts = {}): GjsNode => {
    const classes = [...((node.classes as string[] | undefined) ?? []), ...(o.classes ?? [])];
    if (classes.length) node.classes = classes;
    const attrs = { ...((node.attributes as Record<string, string> | undefined) ?? {}) };
    if (o.id) attrs.id = o.id;
    if (o.style && Object.keys(o.style).length) {
      attrs.id ??= nextId();
      rules.push({ selectors: [`#${attrs.id}`], style: o.style });
    }
    if (Object.keys(attrs).length) node.attributes = attrs;
    if (o.name) node.name = o.name;
    return node;
  };
  const text = (type: string, tagName: string, content: string, classes: string[], o: NodeOpts = {}): GjsNode =>
    fin({ type, tagName, classes, components: inlineNodes(content) }, o);
  const alignClass = (a?: Align) => (a ? [`fn-al-${a}`] : []);
const row = (cols: GjsNode[], o: RowOpts = {}): GjsNode => {
      const classes = ['fn-row'];
      if (o.gap && o.gap !== 'md') classes.push(`fn-gap-${o.gap}`);
      if (o.ratio) classes.push(`fn-ratio-${o.ratio}`);
      if (o.valign) classes.push(`fn-valign-${o.valign}`);
      if (o.keep) classes.push('fn-keep');
      return fin({ type: 'fn-row', tagName: 'div', classes, components: cols }, { ...o, name: o.name ?? 'Row' });
  };
const col = (children: GjsNode[], o: NodeOpts & { grow?: number } = {}): GjsNode => {
      const style = { ...(o.style ?? {}) };
      if (o.grow && o.grow !== 1) style['flex-grow'] = String(o.grow);
      return fin({ type: 'fn-column', tagName: 'div', classes: ['fn-column'], components: children }, { ...o, style, name: o.name ?? 'Column' });
  };

  const api = {
    nextId,
    rules,
    section(children: GjsNode[], o: NodeOpts & { width?: Width; padding?: Pad; theme?: Theme; background?: string; align?: 'left' | 'center'; anchor?: string; backgroundImage?: string } = {}): GjsNode {
      const theme = o.theme ?? (o.background && isDarkColor(o.background) ? 'dark' : 'light');
      const classes = ['fn-section', `fn-w-${o.width ?? 'wide'}`, `fn-pad-${o.padding ?? 'lg'}`];
      if (theme === 'dark') classes.push('fn-dark');
      if (theme === 'accent') classes.push('fn-accent-bg');
      if (theme === 'soft') classes.push('fn-soft');
      if (o.align === 'center') classes.push('fn-align-center');
      const style = { ...(o.style ?? {}) };
      if (o.background) style.background = o.background;
      if (o.backgroundImage) {
        style['background-image'] = `url(${o.backgroundImage})`;
        style['background-size'] = 'cover';
        style['background-position'] = 'center';
      }
      return fin({ type: 'fn-section', tagName: 'section', classes, components: children }, { ...o, style, id: o.anchor ?? o.id, name: o.name ?? 'Section' });
    },
    /** One row with one column per entry. */
    row,
    col,
    cols(columns: GjsNode[][], o: RowOpts = {}): GjsNode {
      return row(columns.map((c) => col(c)), o);
    },
    /** A row with a single column: the usual home of a stack of elements. */
    stack(children: GjsNode[], o: RowOpts = {}): GjsNode {
      return row([col(children)], o);
    },
    heading(content: string, o: NodeOpts & { level?: number; align?: Align; color?: string; anchor?: string } = {}): GjsNode {
      const level = Math.min(6, Math.max(1, Math.round(o.level ?? 2)));
      const style = { ...(o.style ?? {}) };
      if (o.color) style.color = o.color;
      return text('fn-heading', `h${level}`, content, alignClass(o.align), { ...o, style, id: o.anchor ?? o.id, name: o.name ?? 'Heading' });
    },
    text(content: string, o: NodeOpts & { align?: Align; color?: string; muted?: boolean; size?: string; anchor?: string } = {}): GjsNode {
      const style = { ...(o.style ?? {}) };
      if (o.color) style.color = o.color;
      if (o.size) style['font-size'] = o.size;
      return text('fn-text', 'p', content, [...alignClass(o.align), ...(o.muted ? ['fn-muted'] : [])], { ...o, style, id: o.anchor ?? o.id, name: o.name ?? 'Text' });
    },
    badgeText(content: string, o: NodeOpts = {}): GjsNode {
      return text('fn-text', 'p', content, ['fn-badge', 'fn-self-center'], { ...o, name: o.name ?? 'Badge' });
    },
    eyebrow(content: string, o: NodeOpts & { align?: Align } = {}): GjsNode {
      return text('fn-text', 'p', content, ['fn-eyebrow', ...alignClass(o.align)], { ...o, name: o.name ?? 'Eyebrow' });
    },
    button(label: string, action: ButtonActionProps = { type: 'next_step' }, o: NodeOpts & { variant?: 'primary' | 'secondary' | 'outline' | 'ghost'; size?: 'sm' | 'md' | 'lg'; align?: Align; block?: boolean; pill?: boolean } = {}): GjsNode {
      const classes = ['fn-btn', `fn-btn-${o.variant ?? 'primary'}`];
      if (o.size && o.size !== 'md') classes.push(`fn-btn-${o.size}`);
      if (o.block) classes.push('fn-btn-block');
      if (o.pill) classes.push('fn-pill');
      classes.push(...alignClass(o.align));
      return fin({ type: 'fn-button', tagName: 'a', classes, fnAction: action, components: inlineNodes(label) }, { ...o, name: o.name ?? 'Button' });
    },
    image(src: string, alt: string, o: NodeOpts & { width?: number; align?: Align; radius?: string } = {}): GjsNode {
      const style = { ...(o.style ?? {}) };
      if (o.radius) style['border-radius'] = o.radius;
      const attrs: Record<string, string> = { src, alt };
      if (o.width) attrs.width = String(o.width);
      return fin({ type: 'image', tagName: 'img', classes: ['fn-img', ...alignClass(o.align)], attributes: attrs }, { ...o, style, name: o.name ?? 'Image' });
    },
    video(url: string, title = 'Video', o: NodeOpts = {}): GjsNode {
      return fin({ type: 'fn-video', tagName: 'div', fnVideo: { url, title } }, { ...o, name: o.name ?? 'Video' });
    },
    divider: (o: NodeOpts = {}): GjsNode => fin({ type: 'fn-divider', tagName: 'hr', classes: ['fn-divider'] }, { ...o, name: o.name ?? 'Divider' }),
    spacer(height = 32, o: NodeOpts = {}): GjsNode {
      return fin({ type: 'fn-spacer', tagName: 'div', classes: ['fn-spacer'], attributes: { 'aria-hidden': 'true' } }, { ...o, style: { height: `${height}px`, ...(o.style ?? {}) }, name: o.name ?? 'Spacer' });
    },
    list(items: string[], o: NodeOpts & { ordered?: boolean; icon?: 'check' | 'dot'; align?: Align } = {}): GjsNode {
      const classes = ['fn-list', ...(!o.ordered && o.icon !== 'dot' ? ['fn-list-check'] : []), ...alignClass(o.align)];
      return fin(
        { type: 'fn-list', tagName: o.ordered ? 'ol' : 'ul', classes, components: items.map((i) => ({ type: 'text', tagName: 'li', components: inlineNodes(i) })) },
        { ...o, name: o.name ?? 'List' },
      );
    },
    faq(items: { q: string; a: string }[], o: NodeOpts = {}): GjsNode {
      return fin(
        {
          type: 'fn-faq', tagName: 'div', classes: ['fn-faq'],
          components: items.map((i) => ({
            type: 'default', tagName: 'details', classes: ['fn-faq-item'], name: 'FAQ item',
            components: [
              { type: 'text', tagName: 'summary', components: inlineNodes(i.q) },
              { type: 'text', tagName: 'div', components: inlineNodes(i.a) },
            ],
          })),
        },
        { ...o, name: o.name ?? 'FAQ' },
      );
    },
    tabs(items: { label: string; children: GjsNode[] }[], o: NodeOpts = {}): GjsNode {
      return fin(
        {
          type: 'fn-tabs', tagName: 'div', classes: ['fn-tabs'],
          components: [
            { type: 'default', tagName: 'div', classes: ['fn-tab-nav'], name: 'Tab bar', components: items.map((i, k) => ({ type: 'text', tagName: 'button', classes: ['fn-tab-btn', ...(k === 0 ? ['fn-active'] : [])], attributes: { type: 'button' }, components: inlineNodes(i.label) })) },
            ...items.map((i, k) => ({ type: 'default', tagName: 'div', classes: ['fn-tab-panel'], name: `Tab ${k + 1}`, ...(k === 0 ? {} : { attributes: { hidden: '' } }), components: i.children })),
          ],
        },
        { ...o, name: o.name ?? 'Tabs' },
      );
    },
    countdown(p: Omit<CountdownProps, 'expiredText'> & { expiredText?: string }, o: NodeOpts = {}): GjsNode {
      return fin({ type: 'fn-countdown', tagName: 'div', fnCountdown: { expiredText: 'This offer has ended', ...p } }, { ...o, name: o.name ?? 'Countdown' });
    },
    progress(value: number, label?: string, o: NodeOpts = {}): GjsNode {
      return fin({ type: 'fn-progress', tagName: 'div', fnProgress: { value, ...(label ? { label } : {}) } }, { ...o, name: o.name ?? 'Progress bar' });
    },
    form(id: string, p: Partial<FormProps> & Pick<FormProps, 'fields'>, o: NodeOpts = {}): GjsNode {
      const props: FormProps = {
        name: 'Form', submitLabel: 'Submit', consent: { enabled: false, text: 'I agree to be contacted.' }, success: { type: 'next_step' }, ...p,
      };
      return fin({ type: 'fn-form', tagName: 'div', fnForm: props }, { ...o, id, name: o.name ?? 'Form' });
    },
    checkout(id: string, p: Partial<ProductProps> & Pick<ProductProps, 'productName' | 'price'>, o: NodeOpts = {}): GjsNode {
      const props: ProductProps = { currency: 'USD', buttonLabel: 'Buy now', orderBump: false, oneClickUpsell: false, success: { type: 'next_step' }, ...p };
      return fin({ type: 'fn-checkout', tagName: 'div', fnProduct: props }, { ...o, id, name: o.name ?? (props.orderBump ? 'Order bump' : props.oneClickUpsell ? 'One-click upsell' : 'Checkout') });
    },
    code(html: string, css = '', js = '', o: NodeOpts = {}): GjsNode {
      return fin({ type: 'fn-code', tagName: 'div', classes: ['fn-code'], fnCode: { html, css, js } }, { ...o, name: o.name ?? 'Custom code' });
    },
    popup(id: string, children: GjsNode[], o: NodeOpts = {}): GjsNode {
      return fin(
        {
          type: 'fn-popup', tagName: 'div', classes: ['fn-popup'],
          components: [{ type: 'default', tagName: 'div', classes: ['fn-popup-dialog', 'fn-column'], name: 'Dialog', components: [{ type: 'text', tagName: 'button', classes: ['fn-popup-close'], attributes: { type: 'button', 'aria-label': 'Close' }, components: [{ type: 'textnode', content: '×' }] }, ...children] }],
        },
        { ...o, id, name: o.name ?? 'Popup' },
      );
    },
    card(children: GjsNode[], o: NodeOpts & { featured?: boolean } = {}): GjsNode {
      return fin({ type: 'fn-box', tagName: 'div', classes: ['fn-card', ...(o.featured ? ['fn-featured'] : [])], components: children }, { ...o, name: o.name ?? 'Card' });
    },
    box(children: GjsNode[], o: NodeOpts = {}): GjsNode {
      return fin({ type: 'fn-box', tagName: 'div', components: children }, { ...o, name: o.name ?? 'Box' });
    },
    link(label: string, href: string, o: NodeOpts & { classes?: string[] } = {}): GjsNode {
      return fin({ type: 'link', tagName: 'a', attributes: { href }, components: inlineNodes(label) }, { ...o, name: o.name ?? 'Link' });
    },
    navbar(brand: string, links: { label: string; href: string }[], cta?: { label: string; action: ButtonActionProps }, o: NodeOpts = {}): GjsNode {
      return fin(
        {
          type: 'fn-box', tagName: 'nav', classes: ['fn-navbar'], attributes: { 'aria-label': 'Main' },
          components: [
            { type: 'link', tagName: 'a', classes: ['fn-brand'], attributes: { href: '#' }, components: inlineNodes(brand) },
            { type: 'fn-box', tagName: 'div', classes: ['fn-nav-links'], name: 'Links', components: [...links.map((l) => api.link(l.label, l.href)), ...(cta ? [api.button(cta.label, cta.action, { size: 'sm' })] : [])] },
          ],
        },
        { ...o, name: o.name ?? 'Navbar' },
      );
    },
    footer(content: string, links: { label: string; href: string }[] = [], o: NodeOpts = {}): GjsNode {
      return fin(
        { type: 'fn-box', tagName: 'footer', classes: ['fn-footer'], components: [...(links.length ? [{ type: 'fn-box', tagName: 'div', classes: ['fn-nav-links'], attributes: { style: '' }, components: links.map((l) => api.link(l.label, l.href)) } as GjsNode] : []), text('fn-text', 'p', content, [], {})] },
        { ...o, name: o.name ?? 'Footer' },
      );
    },
    /** Wraps children for the page: global colours and font become CSS variables on the page root. */
    project(children: GjsNode[], o: { accent?: string; background?: string; font?: keyof typeof FONT_STACKS } = {}): GjsProject {
      const p = emptyProject();
      const root = p.pages[0]!.frames[0]!.component;
      root.components = children;
      const vars: Record<string, string> = {};
      if (o.accent) vars['--fn-accent'] = o.accent;
      if (o.background) vars['--fn-bg'] = o.background;
      if (o.font && FONT_STACKS[o.font]) vars['--fn-font'] = FONT_STACKS[o.font]!;
      if (Object.keys(vars).length) {
        root.attributes = { id: 'fnroot' };
        rules.unshift({ selectors: ['#fnroot'], style: vars });
      }
      p.styles = [...rules];
      return p;
    },
  };
  return api;
}

export type PageBuilder = ReturnType<typeof createPageBuilder>;

export const PROJECT_DOC_VERSION = PROJECT_VERSION;
