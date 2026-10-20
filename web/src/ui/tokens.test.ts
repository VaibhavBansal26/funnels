import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contrastRatio } from '@pagemodel';

// The design tokens are the single source of the interface's colours. Every text/background pair the components use must reach WCAG AA (4.5:1 for text),
// in the light set and in the dark set; a token change that breaks it fails here instead of in somebody's eyes.
const css = readFileSync(join(__dirname, '../styles.css'), 'utf8');
const block = (start: string): Record<string, string> => {
  const i = css.indexOf(start);
  const body = css.slice(css.indexOf('{', i) + 1, css.indexOf('}', i));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g)].map((m) => [m[1]!, m[2]!]));
};
const light = block(':root {');
const dark = block(":root[data-theme='dark']");
const darkAuto = block(":root:not([data-theme='light'])");

const TEXT_ON: [string, string][] = [
  ['text', 'bg'], ['text', 'surface'], ['text', 'surface-2'], ['text', 'surface-3'],
  ['muted', 'bg'], ['muted', 'surface'], ['muted', 'surface-2'],
  ['primary-contrast', 'primary'], ['primary-contrast', 'primary-hover'],
  ['primary', 'surface'], ['primary', 'primary-soft'],
  ['danger', 'surface'], ['danger', 'danger-soft'],
  ['ok', 'surface'], ['ok', 'ok-soft'],
  ['warn', 'surface'], ['warn', 'warn-soft'],
  ['info', 'surface'], ['info', 'info-soft'],
];

describe.each([['light', light], ['dark', dark], ['dark (prefers-color-scheme)', darkAuto]] as const)('%s tokens', (_name, t) => {
  it('defines every token the components rely on', () => {
    for (const k of ['bg', 'surface', 'surface-2', 'surface-3', 'text', 'muted', 'border', 'border-strong', 'primary', 'primary-hover', 'primary-contrast', 'primary-soft', 'ring', 'danger', 'danger-soft', 'ok', 'ok-soft', 'warn', 'warn-soft', 'info', 'info-soft']) {
      expect(t[k], k).toMatch(/^#/);
    }
  });
  it.each(TEXT_ON)('%s on %s has AA contrast (4.5:1)', (fg, bg) => {
    const r = contrastRatio(t[fg]!, t[bg]!);
    expect(r, `${fg} ${t[fg]} on ${bg} ${t[bg]}`).not.toBeNull();
    expect(r!).toBeGreaterThanOrEqual(4.5);
  });
  it('the focus ring reaches 3:1 against the surface (WCAG 1.4.11) and control borders stay visible', () => {
    expect(contrastRatio(t['border-strong']!, t['surface']!)!).toBeGreaterThanOrEqual(1.8);
    expect(contrastRatio(t['ring']!, t['surface']!)!).toBeGreaterThanOrEqual(3);
  });
});

it('the dark sets in the media query and in the manual toggle are identical', () => {
  expect(darkAuto).toEqual(dark);
});
