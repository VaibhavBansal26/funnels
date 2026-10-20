import type { Editor } from 'grapesjs';
import { FONT_STACKS } from '@pagemodel';

/** Page-wide look: accent colour, background and font are CSS variables on the page root (#fnroot), the same ones the base stylesheet reads. */
export interface PageLook {
  accent: string;
  background: string;
  font: string; // key of FONT_STACKS, or '' for the default
}

const ROOT = '#fnroot';
const rule = (editor: Editor) => editor.Css.getRule(ROOT) ?? editor.Css.setRule(ROOT, {});

export function readPageLook(editor: Editor): PageLook {
  const s = (editor.Css.getRule(ROOT)?.getStyle() ?? {}) as Record<string, string>;
  const font = Object.entries(FONT_STACKS).find(([, v]) => v === s['--fn-font'])?.[0] ?? '';
  return { accent: s['--fn-accent'] ?? '', background: s['--fn-bg'] ?? '', font };
}

export function applyPageLook(editor: Editor, look: Partial<PageLook>): void {
  editor.getWrapper()?.addAttributes({ id: 'fnroot' });
  const r = rule(editor);
  const style = { ...(r.getStyle() as Record<string, string>) };
  const put = (k: string, v: string | undefined) => (v ? (style[k] = v) : delete style[k]);
  if (look.accent !== undefined) put('--fn-accent', look.accent);
  if (look.background !== undefined) put('--fn-bg', look.background);
  if (look.font !== undefined) put('--fn-font', look.font ? FONT_STACKS[look.font] : '');
  r.setStyle(style);
  editor.trigger('update');
}
