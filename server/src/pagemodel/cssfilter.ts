import postcss, { type AtRule, type ChildNode, type Container, type Rule } from 'postcss';
import { safeCssValue, safeMediaText, safeProperty } from './shared/cssvalues.js';

/**
 * CSS-aware filter for free-form stylesheet text (the per-step "custom CSS" and custom-code blocks): the text is parsed with postcss
 * and re-serialised from an allow-list, so nothing in it can load script (expression(), behavior, javascript:), fetch from an
 * unexpected host (@import and url() are restricted), or escape its <style> element. Anything that does not parse yields empty CSS.
 */
const GOOGLE_FONTS = /^https:\/\/fonts\.googleapis\.com\/(css2?|icon)\?[A-Za-z0-9_\-:;,.&=+%@()]*$/;
const SELECTOR_OK = /^[A-Za-z0-9_\-\s.#:>+~*,()[\]="'^$|%]+$/;

function cleanContainer(parent: Container, out: Container): void {
  parent.each((node: ChildNode) => {
    if (node.type === 'rule') {
      const rule = node as Rule;
      const selector = rule.selector.trim();
      if (!selector || selector.length > 400 || !SELECTOR_OK.test(selector) || /javascript|expression|url\s*\(/i.test(selector)) return;
      const clean = postcss.rule({ selector });
      rule.each((d: ChildNode) => {
        if (d.type !== 'decl') return;
        const prop = safeProperty(d.prop);
        const value = prop ? safeCssValue(d.important ? `${d.value} !important` : d.value) : null;
        if (prop && value !== null) clean.append(postcss.decl({ prop, value }));
      });
      if (clean.first) out.append(clean);
    } else if (node.type === 'atrule') {
      const at = node as AtRule;
      const name = at.name.toLowerCase();
      if (name === 'media') {
        const media = safeMediaText(at.params);
        if (!media) return;
        const clean = postcss.atRule({ name: 'media', params: media });
        cleanContainer(at, clean);
        if (clean.first) out.append(clean);
      } else if (name === 'import') {
        const m = /^(?:url\(\s*)?["']?([^"')\s]+)["']?\s*\)?\s*$/i.exec(at.params.trim());
        if (m && GOOGLE_FONTS.test(m[1]!)) out.append(postcss.atRule({ name: 'import', params: `url("${m[1]}")` }));
      }
      // every other at-rule (@font-face, @keyframes, @charset, @namespace, @page, ...) is dropped
    }
  });
}

/** Compact, canonical serialisation (the output must not depend on how the author formatted the input). */
function serialize(n: ChildNode): string {
  if (n.type === 'rule') {
    const r = n as Rule;
    return `${r.selector.replace(/\s+/g, ' ').trim()}{${(r.nodes ?? []).map((d) => (d.type === 'decl' ? `${d.prop}:${d.value}` : '')).filter(Boolean).join(';')}}`;
  }
  const a = n as AtRule;
  if (a.name === 'import') return `@import ${a.params};`;
  return `@media ${a.params}{${(a.nodes ?? []).map(serialize).join('')}}`;
}

export function sanitizeCss(input: string, maxLength = 20_000): string {
  const text = String(input ?? '').slice(0, maxLength);
  if (!text.trim()) return '';
  try {
    const root = postcss.parse(text);
    const out = postcss.root();
    cleanContainer(root, out);
    // @import statements must come first in a stylesheet.
    const imports = out.nodes.filter((n) => n.type === 'atrule' && (n as AtRule).name === 'import');
    const rest = out.nodes.filter((n) => !imports.includes(n));
    return [...imports, ...rest].map(serialize).join('').replace(/<\/?style/gi, '');
  } catch {
    return '';
  }
}
