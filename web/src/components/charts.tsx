import { useMemo } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useUi } from '../lib/ui-state';

// SVG presentation attributes (fill, stroke) cannot use CSS variables, so theme tokens are
// resolved to concrete colors here and re-resolved when the theme changes.
const TOKENS = ['--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5', '--chart-6', '--success', '--danger', '--text-3', '--border', '--surface', '--surface-2', '--text', '--text-2'] as const;

function useColors() {
  const { theme } = useUi();
  return useMemo(() => {
    const cs = getComputedStyle(document.documentElement);
    const c: Record<string, string> = {};
    for (const t of TOKENS) c[t] = cs.getPropertyValue(t).trim() || '#888';
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme]);
}

/** Resolve "var(--x)" to its current value; plain colors pass through. */
function resolve(c: Record<string, string>, color: string) {
  const m = color.match(/^var\((--[\w-]+)\)$/);
  return m ? c[m[1]] ?? getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim() : color;
}

export const SERIES = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)', 'var(--chart-6)'];

function common(c: Record<string, string>) {
  return {
    axis: { fontSize: 12, fill: c['--text-3'] },
    grid: c['--border'],
    tooltip: { background: c['--surface'], border: `1px solid ${c['--border']}`, borderRadius: 8, color: c['--text'], fontSize: 12 },
    cursor: { fill: c['--surface-2'] },
    legend: { fontSize: 12, color: c['--text-2'] },
  };
}

export function HBar({ data, x, y, height = 240, color = SERIES[0] }: { data: any[]; x: string; y: string; height?: number; color?: string }) {
  const c = useColors();
  const s = common(c);
  if (!data.length) return <div className="empty small">No data yet</div>;
  return (
    <ResponsiveContainer width="100%" height={Math.max(height, data.length * 30)}>
      <BarChart data={data} layout="vertical" margin={{ left: 8, right: 16, top: 4, bottom: 4 }}>
        <CartesianGrid horizontal={false} stroke={s.grid} />
        <XAxis type="number" tick={s.axis} allowDecimals={false} axisLine={false} tickLine={false} />
        <YAxis type="category" dataKey={x} tick={s.axis} width={120} axisLine={false} tickLine={false} />
        <Tooltip contentStyle={s.tooltip} cursor={s.cursor} />
        <Bar isAnimationActive={false} dataKey={y} fill={resolve(c, color)} radius={[0, 4, 4, 0]} barSize={16} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function Donut({ data, name, value, height = 220, colors = SERIES }: { data: any[]; name: string; value: string; height?: number; colors?: string[] }) {
  const c = useColors();
  const s = common(c);
  if (!data.length || data.every((d) => !d[value])) return <div className="empty small">No data yet</div>;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <PieChart>
        <Pie isAnimationActive={false} data={data} dataKey={value} nameKey={name} innerRadius="55%" outerRadius="85%" paddingAngle={2} stroke={c['--surface']}>
          {data.map((_, i) => <Cell key={i} fill={resolve(c, colors[i % colors.length])} />)}
        </Pie>
        <Tooltip contentStyle={s.tooltip} />
        <Legend wrapperStyle={s.legend} iconType="circle" iconSize={8} />
      </PieChart>
    </ResponsiveContainer>
  );
}

export function Stacked({ data, x, keys, height = 260 }: { data: any[]; x: string; keys: string[]; height?: number }) {
  const c = useColors();
  const s = common(c);
  if (!data.length) return <div className="empty small">No publications in this period</div>;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ left: -12, right: 8, top: 8 }}>
        <CartesianGrid vertical={false} stroke={s.grid} />
        <XAxis dataKey={x} tick={s.axis} axisLine={false} tickLine={false} />
        <YAxis tick={s.axis} allowDecimals={false} axisLine={false} tickLine={false} />
        <Tooltip contentStyle={s.tooltip} cursor={s.cursor} />
        <Legend wrapperStyle={s.legend} iconType="circle" iconSize={8} />
        {keys.map((k, i) => <Bar isAnimationActive={false} key={k} dataKey={k} stackId="a" fill={resolve(c, SERIES[i % SERIES.length])} radius={i === keys.length - 1 ? [4, 4, 0, 0] : 0} />)}
      </BarChart>
    </ResponsiveContainer>
  );
}
