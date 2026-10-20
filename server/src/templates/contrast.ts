import { contrastRatio } from '../pagemodel/shared/build.js';
import { type GjsNode, type GjsProject, childrenOf, wrapperOf } from '../pagemodel/shared/clean.js';

/**
 * WCAG AA audit of a page document, without a browser. It follows the base stylesheet's rules (pagemodel/shared/css.ts): copy inherits its colour from the
 * section theme (light, dark, accent, soft), cards and buttons have theme-dependent colours, and the author's explicit `color`/`background` rules (the id rules
 * the builder DSL writes) override them. Backgrounds with several colour stops (gradients) are checked against every stop, which is the worst case.
 * It is an approximation (images and computed blends are unknown and skipped) but it catches the mistakes templates make: dark text on a dark gradient,
 * a pastel button label, a muted paragraph on an accent band.
 */
export interface ContrastIssue {
  where: string;
  fg: string;
  bg: string;
  ratio: number;
  need: number;
}

interface Theme {
  ink: string;
  muted: string;
  bg: string[];
  link: string;
  card: string;
  cardInk: string;
}

const LIGHT: Theme = { ink: '#0f172a', muted: '#475569', bg: ['#ffffff'], link: '#1d4ed8', card: '#ffffff', cardInk: '#0f172a' };
const DARK: Theme = { ink: '#f8fafc', muted: '#cbd5e1', bg: ['#0f172a'], link: '#fde68a', card: '#1e293b', cardInk: '#f8fafc' };
const ACCENT: Theme = { ink: '#ffffff', muted: '#e0e7ff', bg: ['#1d4ed8'], link: '#ffffff', card: '#ffffff', cardInk: '#0f172a' };
const SOFT_BG = '#f1f5f9';

const HEX = /#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b|rgba?\(\s*\d{1,3}[\s,]+\d{1,3}[\s,]+\d{1,3}[^)]*\)/g;
/** Opaque colours named in a CSS value. Translucent ones (alpha < 1) are skipped: their result depends on what is behind them. */
function colorsIn(value: string | undefined): string[] {
  if (!value) return [];
  return (value.match(HEX) ?? []).filter((c) => !(/^#[0-9a-f]{8}$/i.test(c) && !/ff$/i.test(c)) && !/rgba\(.*,\s*0?\.\d+\s*\)/i.test(c));
}

const TEXT_TYPES = new Set(['fn-heading', 'fn-text', 'fn-list', 'fn-button', 'text', 'link', 'fn-checkout', 'fn-form']);

export function auditContrast(project: GjsProject): ContrastIssue[] {
  const rules = new Map<string, Record<string, string>>();
  for (const r of project.styles) {
    if (r.state || r.mediaText || !r.selectors?.length) continue;
    const sel = r.selectors[0];
    if (typeof sel === 'string' && sel.startsWith('#')) rules.set(sel.slice(1), { ...(rules.get(sel.slice(1)) ?? {}), ...r.style });
  }
  const root = rules.get('fnroot') ?? {};
  const accent = root['--fn-accent'] ?? '#2563eb';
  const issues: ContrastIssue[] = [];
  const check = (where: string, fg: string | undefined, bgs: string[], need: number) => {
    if (!fg || !bgs.length) return;
    for (const bg of bgs) {
      const ratio = contrastRatio(fg, bg);
      if (ratio !== null && ratio + 1e-9 < need) issues.push({ where, fg, bg, ratio: Math.round(ratio * 100) / 100, need });
    }
  };

  const visit = (n: GjsNode, theme: Theme, bg: string[], path: string): void => {
    const attrs = (n.attributes as Record<string, string> | undefined) ?? {};
    const classes = (n.classes as string[] | undefined) ?? [];
    const style = (attrs.id && rules.get(attrs.id)) || {};
    const has = (c: string) => classes.includes(c);
    const type = String(n.type ?? '');
    const label = `${path}/${String(n.name ?? type)}${attrs.id ? `#${attrs.id}` : ''}`;
    let t = theme;
    let here = bg;

    if (has('fn-section')) {
      t = has('fn-dark') ? DARK : has('fn-accent-bg') ? ACCENT : LIGHT;
      here = has('fn-soft') ? [SOFT_BG] : t.bg;
    }
    if (has('fn-card')) {
      here = [t.card];
      t = { ...t, ink: t.cardInk, muted: t === DARK ? t.muted : '#475569', bg: [t.card] };
    }
    if (has('fn-footer')) {
      t = { ...DARK, bg: ['#0f172a'], muted: '#cbd5e1', ink: '#cbd5e1' };
      here = ['#0f172a'];
    }
    const bgValue = `${style.background ?? ''} ${style['background-color'] ?? ''} ${style['background-image'] ?? ''}`;
    const explicitBg = colorsIn(bgValue);
    if (/url\(/.test(bgValue)) here = []; // an image: unknown, not audited
    else if (explicitBg.length) here = explicitBg;
    const ink = style.color ?? (has('fn-muted') ? t.muted : t.ink);

    const isHeading = type === 'fn-heading';
    const level = isHeading ? Number(/^h(\d)$/.exec(String(n.tagName))?.[1] ?? 2) : 6;
    const large = isHeading && level <= 3;
    if (type === 'fn-button') {
      const variant = classes.find((c) => /^fn-btn-(primary|secondary|outline|ghost)$/.test(c))?.slice(7) ?? 'primary';
      const dark = t === DARK;
      const btnBg = style.background ? colorsIn(style.background) : variant === 'primary' ? [accent] : variant === 'secondary' ? [dark ? '#f8fafc' : '#0f172a'] : here;
      const btnInk = style.color ?? (variant === 'primary' ? '#ffffff' : variant === 'secondary' ? (dark ? '#0f172a' : '#ffffff') : t.ink);
      check(`${label} (button)`, btnInk, btnBg, 4.5);
    } else if (has('fn-badge')) {
      check(`${label} (badge)`, '#ffffff', [accent], 4.5);
    } else if (has('fn-eyebrow')) {
      check(`${label} (eyebrow)`, t.link, here, 4.5);
    } else if (TEXT_TYPES.has(type) && type !== 'fn-button' && type !== 'fn-checkout' && type !== 'fn-form') {
      check(label, ink, here, large ? 3 : 4.5);
    } else if (style.color) {
      check(label, style.color, here, 4.5);
    }
    for (const child of childrenOf(n)) visit(child, t, here, label);
  };
  visit(wrapperOf(project), { ...LIGHT, bg: [root['--fn-bg'] ?? '#ffffff'] }, [root['--fn-bg'] ?? '#ffffff'], '');
  return issues;
}
