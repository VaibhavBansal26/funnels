import { useId } from 'react';

export interface ChartLine {
  key: string;
  label: string;
  color: string;
}

export interface ChartPoint {
  date: string;
  [key: string]: number | string;
}

/** Rounds a maximum up to a "nice" axis bound (1, 2, 5 x 10^n) so ticks are readable. Zero data still gets a usable axis. */
export function niceMax(max: number): number {
  if (!Number.isFinite(max) || max <= 0) return 1;
  const exp = Math.floor(Math.log10(max));
  const base = 10 ** exp;
  const f = max / base;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nice * base;
}

const W = 680;
const H = 260;
const M = { top: 12, right: 16, bottom: 28, left: 44 };

/** Dependency-free line chart as an accessible inline SVG: titled, described, every point labelled, with a data table for screen readers. */
export function LineChart({ title, data, lines, valueFormat = (n: number) => String(n) }: { title: string; data: ChartPoint[]; lines: ChartLine[]; valueFormat?: (n: number) => string }) {
  const id = useId();
  const max = niceMax(Math.max(0, ...data.flatMap((d) => lines.map((l) => Number(d[l.key]) || 0))));
  const iw = W - M.left - M.right;
  const ih = H - M.top - M.bottom;
  const x = (i: number) => M.left + (data.length <= 1 ? iw / 2 : (i / (data.length - 1)) * iw);
  const y = (v: number) => M.top + ih - (v / max) * ih;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * max);
  const labelIdx = data.length <= 3 ? data.map((_, i) => i) : [0, Math.floor((data.length - 1) / 2), data.length - 1];
  const total = (k: string) => data.reduce((n, d) => n + (Number(d[k]) || 0), 0);
  return (
    <figure style={{ margin: 0 }}>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={`${id}-t ${id}-d`}>
        <title id={`${id}-t`}>{title}</title>
        <desc id={`${id}-d`}>
          {lines.map((l) => `${l.label}: total ${valueFormat(total(l.key))}`).join('. ')}. {data.length} days from {data[0]?.date ?? 'n/a'} to {data[data.length - 1]?.date ?? 'n/a'}.
        </desc>
        {ticks.map((t) => (
          <g key={t}>
            <line className="axis" x1={M.left} x2={W - M.right} y1={y(t)} y2={y(t)} />
            <text x={M.left - 8} y={y(t) + 4} textAnchor="end">{valueFormat(Number(t.toFixed(2)))}</text>
          </g>
        ))}
        {labelIdx.map((i) => (
          <text key={i} x={x(i)} y={H - 8} textAnchor={i === 0 ? 'start' : i === data.length - 1 ? 'end' : 'middle'}>{data[i]!.date.slice(5)}</text>
        ))}
        {lines.map((l) => (
          <g key={l.key}>
            <polyline className="line" stroke={l.color} points={data.map((d, i) => `${x(i)},${y(Number(d[l.key]) || 0)}`).join(' ')} />
            {data.map((d, i) => (
              <circle key={d.date} className="dot" cx={x(i)} cy={y(Number(d[l.key]) || 0)} r={data.length > 45 ? 0 : 3.5} fill={l.color}>
                <title>{`${d.date} · ${l.label}: ${valueFormat(Number(d[l.key]) || 0)}`}</title>
              </circle>
            ))}
          </g>
        ))}
      </svg>
      <figcaption className="legend">
        {lines.map((l) => (
          <span key={l.key}><i style={{ background: l.color }} />{l.label}</span>
        ))}
      </figcaption>
      <table className="sr-only">
        <caption>{title}</caption>
        <thead>
          <tr><th scope="col">Date</th>{lines.map((l) => <th key={l.key} scope="col">{l.label}</th>)}</tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.date}><th scope="row">{d.date}</th>{lines.map((l) => <td key={l.key}>{valueFormat(Number(d[l.key]) || 0)}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
