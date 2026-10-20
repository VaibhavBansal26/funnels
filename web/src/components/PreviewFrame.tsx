import { useEffect, useRef, useState } from 'react';
import { cn } from '../ui';

export type Device = 'desktop' | 'tablet' | 'mobile';
export const DEVICE_WIDTH: Record<Device, string> = { desktop: '100%', tablet: '768px', mobile: '390px' };

/**
 * Shows server-rendered page HTML in an iframe with `sandbox=""`: no scripts, no same-origin access, no forms, no popups. The HTML comes from
 * the stored page (`/api/funnels/:id/steps/:sid/html`, templates and backups), never from the browser, and is inert even if it were hostile.
 */
/**
 * Previews are pictures of the page, not the page: scripts are left out (the sandbox would refuse them and log each one) and so are embedded players
 * (YouTube, Vimeo, mp4), which would otherwise make a third-party request for every card on screen. The video box keeps its size and its dark background.
 */
export const inertHtml = (html: string): string =>
  html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>/gi, '')
    .replace(/<video\b[^>]*>[\s\S]*?<\/video\s*>/gi, '');

export function HtmlFrame({ html, title, device = 'desktop', height = 480 }: { html: string; title: string; device?: Device; height?: number }) {
  return <iframe title={title} sandbox="" srcDoc={inertHtml(html)} style={{ width: DEVICE_WIDTH[device], maxWidth: '100%', height }} className="mx-auto block rounded-lg border border-border bg-white" />;
}

/** True once the element has been near the viewport (thumbnails of long lists load lazily). */
export function useNearViewport<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [near, setNear] = useState(typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const el = ref.current;
    if (!el || near) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && (setNear(true), io.disconnect()), { rootMargin: '300px' });
    io.observe(el);
    return () => io.disconnect();
  }, [near]);
  return [ref, near];
}

/** A page rendered at 1280px and scaled to fit its container: the real look of the page as a thumbnail. Click-through is disabled. */
export function ScaledPage({ html, title, className, width = 1280, height = 800 }: { html: string; title: string; className?: string; width?: number; height?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.25);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const update = () => setScale(el.clientWidth / width);
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [width]);
  return (
    <div ref={box} className={cn('relative overflow-hidden bg-white', className)} style={{ aspectRatio: `${width} / ${height}` }}>
      <iframe title={title} sandbox="" srcDoc={inertHtml(html)} tabIndex={-1} loading="lazy" className="pointer-events-none absolute top-0 left-0 origin-top-left border-0" style={{ width, height, transform: `scale(${scale})` }} />
    </div>
  );
}

export function hashGradient(seed: string): { from: string; to: string } {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return { from: `hsl(${hue} 70% 55%)`, to: `hsl(${(hue + 50) % 360} 75% 40%)` };
}
