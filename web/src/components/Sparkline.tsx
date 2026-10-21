import { useId } from 'react';

/** A tiny trend line as an accessible image: the label says what it shows and its range, the data is in the table next to it. */
export function Sparkline({ values, label, width = 96, height = 28, className }: { values: number[]; label: string; width?: number; height?: number; className?: string }) {
  const id = useId();
  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  const span = max - min || 1;
  const x = (i: number) => (values.length <= 1 ? width / 2 : (i / (values.length - 1)) * (width - 4) + 2);
  const y = (v: number) => height - 3 - ((v - min) / span) * (height - 6);
  const points = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const total = values.reduce((a, b) => a + b, 0);
  return (
    <svg className={className} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={id}>
      <title id={id}>{`${label}: ${values.length} points, total ${Math.round(total * 100) / 100}, peak ${max}`}</title>
      {values.length === 0 || max === 0 ? <line x1="2" x2={width - 2} y1={height - 3} y2={height - 3} stroke="currentColor" strokeOpacity="0.35" strokeWidth="1.5" /> : <polyline fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinejoin="round" strokeLinecap="round" points={points} />}
    </svg>
  );
}
