import { useQuery } from '@tanstack/react-query';
import { useId } from 'react';
import { api } from '../api/client';
import { cn } from '../ui';
import { ScaledPage, useNearViewport } from './PreviewFrame';

/** Wraps a headline into at most `lines` lines of roughly `width` characters. */
export function wrapText(text: string, width = 22, lines = 3): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let line = '';
  for (const w of words) {
    if (line && (line + ' ' + w).length > width) {
      out.push(line);
      line = w;
    } else line = line ? `${line} ${w}` : w;
    if (out.length === lines) break;
  }
  if (out.length < lines && line) out.push(line);
  const result = out.slice(0, lines);
  if (words.join(' ').length > result.join(' ').length) result[result.length - 1] = `${result[result.length - 1]!.slice(0, width - 1).trimEnd()}…`;
  return result.length ? result : [''];
}

/** Generated thumbnail: a gradient (derived from the funnel id on the server) with the first heading of the first page. Shown while the real page loads and when it cannot be shown. */
export function GeneratedThumb({ thumb, small, className }: { thumb: { heading: string; from: string; to: string }; small?: boolean; className?: string }) {
  const id = useId();
  const lines = wrapText(thumb.heading, small ? 14 : 22, small ? 2 : 3);
  return (
    <svg className={className ?? (small ? 'thumb-sm' : 'thumb')} viewBox="0 0 320 200" role="img" aria-label={`Thumbnail: ${thumb.heading}`}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={thumb.from} />
          <stop offset="1" stopColor={thumb.to} />
        </linearGradient>
      </defs>
      <rect width="320" height="200" fill={`url(#${id})`} />
      <rect x="24" y="24" width="48" height="6" rx="3" fill="#fff" opacity="0.55" />
      {lines.map((l, i) => (
        <text key={i} x="24" y={84 + i * 30} fill="#fff" fontSize="24" fontWeight="700" fontFamily="system-ui, sans-serif">{l}</text>
      ))}
      <rect x="24" y="168" width="84" height="16" rx="8" fill="#fff" opacity="0.85" />
    </svg>
  );
}

/**
 * The funnel's first page as it really looks: the stored, published HTML scaled into the card (sandboxed iframe, no scripts, loaded when the card
 * scrolls near the viewport). Falls back to the generated thumbnail while loading, on errors and for funnels without a page.
 */
export function FunnelThumb({ thumb, funnelId, small, className }: { thumb: { heading: string; from: string; to: string; stepId?: string | null }; funnelId?: string; small?: boolean; className?: string }) {
  const [ref, near] = useNearViewport<HTMLDivElement>();
  const stepId = thumb.stepId;
  const q = useQuery({
    queryKey: ['page-html', stepId],
    enabled: near && !!funnelId && !!stepId,
    queryFn: () => api.get<{ html: string; checksum: string }>(`/api/funnels/${funnelId}/steps/${stepId}/html`),
    staleTime: 60_000,
  });
  const fallback = <GeneratedThumb thumb={thumb} small={small} className={cn(small ? 'h-10 w-16' : 'aspect-[16/10] w-full', 'block')} />;
  return (
    <div ref={ref} className={cn('overflow-hidden rounded-md border border-border', small ? 'h-10 w-16 flex-none' : 'w-full', className)}>
      {q.data ? <ScaledPage html={q.data.html} title={`Preview of ${thumb.heading}`} className="rounded-none" /> : fallback}
    </div>
  );
}
