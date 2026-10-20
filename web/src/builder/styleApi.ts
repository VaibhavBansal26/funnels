import type { Editor } from 'grapesjs';
import { safeCssValue, safeProperty } from '@pagemodel';

/**
 * Reading and writing styles through the GrapesJS Style Manager target: the selected component (a "#id" rule), or the active class selectors,
 * at the current device (media query) and state (hover, ...). Values are validated with the same filter the server applies, so the editor
 * cannot even stage a declaration the server would drop.
 */
export function readStyle(editor: Editor): Record<string, string> {
  const t = editor.StyleManager.getSelected();
  return ((t?.getStyle?.() as Record<string, string> | undefined) ?? {}) as Record<string, string>;
}

/** Writes (or, for an empty value, removes) one declaration on every selected target. Returns false when the value is not acceptable. */
export function writeStyle(editor: Editor, prop: string, value: string): boolean {
  if (!safeProperty(prop)) return false;
  const v = value.trim();
  if (v !== '' && safeCssValue(v) === null) return false;
  editor.StyleManager.addStyleTargets({ [prop]: v } as never, {});
  return true;
}

/** The value the element currently renders with (computed in the canvas), used as a placeholder for properties the author has not set. */
export function computedStyle(editor: Editor, prop: string): string {
  const el = editor.getSelected()?.getEl();
  const view = el?.ownerDocument.defaultView;
  return el && view ? view.getComputedStyle(el).getPropertyValue(prop) : '';
}

export const SHADOWS: { value: string; label: string }[] = [
  { value: '', label: 'None' },
  { value: '0 1px 2px rgb(15 23 42 / 0.08)', label: 'Subtle' },
  { value: '0 4px 12px -2px rgb(15 23 42 / 0.15)', label: 'Medium' },
  { value: '0 12px 32px -8px rgb(15 23 42 / 0.25)', label: 'Large' },
  { value: '0 24px 60px -12px rgb(15 23 42 / 0.35)', label: 'Extra large' },
  { value: 'inset 0 2px 6px rgb(15 23 42 / 0.15)', label: 'Inset' },
  { value: '0 0 0 4px rgb(99 102 241 / 0.35)', label: 'Glow ring' },
];

export const GRADIENTS: { value: string; label: string }[] = [
  { value: '', label: 'None' },
  { value: 'linear-gradient(135deg,#0f172a 0%,#1e3a8a 100%)', label: 'Midnight blue' },
  { value: 'linear-gradient(135deg,#1e1b4b 0%,#4c1d95 100%)', label: 'Deep violet' },
  { value: 'linear-gradient(135deg,#052e2b 0%,#0f5132 100%)', label: 'Forest' },
  { value: 'linear-gradient(135deg,#4338ca 0%,#7c3aed 100%)', label: 'Indigo to violet' },
  { value: 'linear-gradient(135deg,#f8fafc 0%,#e0e7ff 100%)', label: 'Soft sky' },
  { value: 'linear-gradient(135deg,#fff7ed 0%,#fed7aa 100%)', label: 'Warm sand' },
];

export const FONT_FAMILIES: { value: string; label: string }[] = [
  { value: '', label: 'Page font' },
  { value: 'Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif', label: 'Inter / system sans' },
  { value: 'Georgia,"Times New Roman",Times,serif', label: 'Serif (Georgia)' },
  { value: 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace', label: 'Monospace' },
  { value: '"Trebuchet MS","Lucida Grande",sans-serif', label: 'Humanist (Trebuchet)' },
  { value: 'Impact,Haettenschweiler,"Arial Narrow Bold",sans-serif', label: 'Impact (display)' },
];
