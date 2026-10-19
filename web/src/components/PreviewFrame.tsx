import { renderPage } from '@blocks';
import { useMemo } from 'react';

export type Device = 'desktop' | 'tablet' | 'mobile';
export const DEVICE_WIDTH: Record<Device, string> = { desktop: '100%', tablet: '768px', mobile: '390px' };

/** Static, script-free rendering of a page document (sandboxed iframe, no scripts, no same-origin). Used by template and backup previews. */
export function PreviewFrame({ doc, title, device = 'desktop', height = 480 }: { doc: unknown; title: string; device?: Device; height?: number }) {
  const html = useMemo(() => renderPage(doc, { funnelId: 'preview', stepId: 'preview', stepName: title, mode: 'builder' }), [doc, title]);
  return <iframe title={title} sandbox="" srcDoc={html} style={{ width: DEVICE_WIDTH[device], maxWidth: '100%', height, border: '1px solid var(--border)', borderRadius: 8, background: '#fff', margin: '0 auto', display: 'block' }} />;
}

export function hashGradient(seed: string): { from: string; to: string } {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return { from: `hsl(${hue} 70% 55%)`, to: `hsl(${(hue + 50) % 360} 75% 40%)` };
}
