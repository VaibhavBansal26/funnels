import { useId } from 'react';

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

/** Placeholder thumbnail: a gradient (derived from the funnel id on the server) with the first heading of the first page. No screenshots involved. */
export function FunnelThumb({ thumb, small, className }: { thumb: { heading: string; from: string; to: string }; small?: boolean; className?: string }) {
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
