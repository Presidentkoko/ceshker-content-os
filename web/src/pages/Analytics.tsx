import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { APPROVAL_LABELS, PLATFORM_LABELS, YOUTUBE_LABELS, type ApprovalStatus, type Platform, type YoutubeStatus } from '../../../shared/domain';
import { Callout, Card, ErrorState, LoadingRows, Progress } from '../components/ui';
import { Donut, HBar, Stacked } from '../components/charts';

export default function Analytics() {
  const { data: a, error, isLoading, refetch } = useQuery({ queryKey: ['analytics'], queryFn: () => api.get<any>('/analytics') });
  if (error) return <ErrorState error={error} retry={refetch} />;
  if (isLoading || !a) return <LoadingRows rows={10} />;
  const s = a.success;
  const attempts = s.succeeded + s.failed;
  const weeklyKeys = [...new Set(a.weekly.flatMap((w: any) => Object.keys(w).filter((k) => k !== 'week')))] as string[];
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="page-head">
        <div><h1>Analytics</h1><div className="sub">Operational metrics from the content database. Engagement appears once platform insights are connected.</div></div>
      </div>
      <div className="kpi-grid">
        <div className="kpi" style={{ cursor: 'default' }}><span className="label">Publications</span><span className="value">{s.succeeded}</span><span className="hint">{s.automated} automated · {s.manual} manual</span></div>
        <div className="kpi tone-danger" style={{ cursor: 'default' }}><span className="label">Failed (open)</span><span className="value">{s.failed}</span><span className="hint">{s.failed_attempts} failed attempts total</span></div>
        <div className="kpi tone-success" style={{ cursor: 'default' }}><span className="label">Success rate</span><span className="value">{attempts ? Math.round((s.succeeded / attempts) * 100) : 100}%</span></div>
      </div>
      <div className="grid grid-2">
        <Card title="Weekly publishing volume"><Stacked data={a.weekly} x="week" keys={weeklyKeys} /></Card>
        <Card title="Approval pipeline"><Donut data={a.pipeline.map((p: any) => ({ name: APPROVAL_LABELS[p.status as ApprovalStatus], n: p.n }))} name="name" value="n" /></Card>
        <Card title="Content by platform"><HBar data={a.by_platform.map((p: any) => ({ platform: PLATFORM_LABELS[p.platform as Platform], n: p.n }))} x="platform" y="n" /></Card>
        <Card title="Content by category"><HBar data={a.by_category} x="category" y="n" color="var(--chart-2)" /></Card>
        <Card title="YouTube release progress"><Donut data={a.youtube.map((y: any) => ({ name: YOUTUBE_LABELS[y.status as YoutubeStatus], n: y.n }))} name="name" value="n" colors={['var(--chart-6)', 'var(--chart-3)', 'var(--chart-1)', 'var(--success)']} /></Card>
        <Card title="Campaign completion">
          <div className="stack">
            {a.campaigns.map((c: any) => (
              <div key={c.name}>
                <div className="row small"><span>{c.name}</span><span className="spacer" /><span className="muted">{c.published} published · {c.approved} approved · {c.total} total</span></div>
                <Progress value={c.published} max={c.target_count || c.total} tone="success" />
              </div>
            ))}
          </div>
        </Card>
      </div>
      <Card title="Engagement">
        <Callout tone="info" title="Not available yet">{a.engagement.reason} Once connected: 3-second views, average watch time, percentage viewed, saves, shares, registrations and cost per registration per video.</Callout>
      </Card>
    </div>
  );
}
