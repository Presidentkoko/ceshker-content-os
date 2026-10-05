import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import {
  Activity, AlertTriangle, CalendarDays, CheckSquare, Cloud, ExternalLink, Facebook, FileText, HelpCircle, ImageOff, Instagram, Layers,
  ListChecks, Palette, Plus, Send, Sparkles, Table2, Video, XCircle, Youtube,
} from 'lucide-react';
import { api } from '../lib/api';
import { useUi } from '../lib/ui-state';
import { useMeta } from '../lib/hooks';
import { useSession } from '../lib/session';
import { fmtDate, fmtRelative, fmtTime } from '../lib/format';
import { Card, Empty, ErrorState, LoadingRows } from '../components/ui';

/** Home: the command center. Everything that needs a decision, and what goes out next. */
export function Overview() {
  const { data, error, isLoading, refetch } = useQuery({ queryKey: ['overview'], queryFn: () => api.get<any>('/overview'), refetchInterval: 60_000 });
  const { data: conns } = useQuery({ queryKey: ['connections'], queryFn: () => api.get<any[]>('/connections'), refetchInterval: 120_000 });
  const { data: notes } = useQuery({ queryKey: ['notifications'], queryFn: () => api.get<any[]>('/notifications'), refetchInterval: 60_000 });
  const { data: posts } = useQuery({ queryKey: ['content', 'hud'], queryFn: () => api.get<any>('/content?show=all&page_size=500'), refetchInterval: 60_000 });
  const { data: meta } = useMeta();
  const { openContent } = useUi();
  const { user } = useSession();
  const nav = useNavigate();

  if (error) return <ErrorState error={error} retry={refetch} />;
  if (isLoading || !data) return <LoadingRows rows={8} />;
  const k = data.kpis;
  const tz = data.timezone;
  const brand = meta?.brand;
  const items: any[] = posts?.items ?? [];
  const live = items.filter((c) => c.publish_status !== 'published' && !c.archived_at);
  const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0);
  const approved = live.filter((c) => c.approval_status === 'approved').length;
  const withImage = live.filter((c) => c.asset_count > 0).length;
  const dated = live.filter((c) => c.scheduled_at).length;

  const rows = [
    { label: 'Need approval', sub: 'Waiting on an approver', value: k.awaiting_approval, icon: CheckSquare, to: '/posts?approval_status=pending', tone: k.awaiting_approval ? 'warn' : '' },
    { label: 'Need details', sub: 'Placeholders to fill in', value: k.needs_details ?? 0, icon: HelpCircle, to: '/posts?needs_details=true', tone: k.needs_details ? 'warn' : '' },
    { label: 'Need an image', sub: 'No graphic attached yet', value: k.missing_assets, icon: ImageOff, to: '/posts?missing_assets=true', tone: k.missing_assets ? 'warn' : '' },
    { label: 'Scheduled', sub: 'In the publishing queue', value: k.in_queue, icon: CalendarDays, to: '/posts?publish_status=queued', tone: 'ok' },
    { label: 'Posted', sub: 'Published so far', value: k.published, icon: Send, to: '/posts?publish_status=published', tone: '' },
    { label: 'Failed', sub: 'Needs a retry', value: k.failed, icon: XCircle, to: '/posts?publish_status=failed', tone: k.failed ? 'bad' : '' },
  ];

  const feed = [
    ...(notes ?? []).map((n) => ({ title: n.title, body: n.body, tag: n.kind === 'approval' ? 'info' : n.kind === 'failure' ? 'bad' : 'warn', label: n.kind === 'approval' ? 'review' : n.kind === 'failure' ? 'failed' : 'link', at: n.at, onClick: () => (n.content_id ? openContent(n.content_id) : nav('/settings')) })),
    ...live.filter((c) => c.issues?.some((i: any) => i.code === 'needs_details')).slice(0, 4).map((c) => ({ title: c.title, body: c.issues.find((i: any) => i.code === 'needs_details').message, tag: 'warn', label: 'details', at: c.scheduled_at, onClick: () => openContent(c.id) })),
    ...data.today.map((c: any) => ({ title: `Goes out today: ${c.title}`, body: `${fmtTime(c.scheduled_at, tz)} · ${c.approval_status === 'approved' ? 'approved' : 'not approved yet'}`, tag: c.approval_status === 'approved' ? 'ok' : 'warn', label: 'today', at: c.scheduled_at, onClick: () => openContent(c.id) })),
  ].slice(0, 8);

  const CONN_ICON: Record<string, any> = { facebook: Facebook, instagram: Instagram, youtube: Youtube, canva: Palette, google_drive: Cloud, google_sheets: Table2 };
  const agents = (conns ?? []).filter((c) => CONN_ICON[c.key]).map((c) => ({
    key: c.key, label: c.label.replace(' professional account', '').replace(' Page', ''),
    state: c.status === 'connected' ? (c.automation_enabled === false && ['facebook', 'instagram', 'youtube'].includes(c.key) ? 'off' : 'ok') : c.status === 'disconnected' ? 'bad' : 'off',
    text: c.status === 'connected' ? (c.automation_enabled === false && ['facebook', 'instagram', 'youtube'].includes(c.key) ? 'Connected · manual' : 'Active') : c.status === 'disconnected' ? 'Error' : 'Not linked',
  }));

  const now = Date.now();
  const inWords = (iso: string) => {
    const m = Math.round((new Date(iso).getTime() - now) / 60_000);
    if (m < -60) return 'Past';
    if (m < 0) return 'Now';
    if (m < 60) return `In ${m} min`;
    const h = Math.floor(m / 60);
    return h < 48 ? `In ${h}h ${m % 60}m` : `In ${Math.round(h / 24)} days`;
  };
  const next: any[] = data.next7.length ? data.next7 : live.filter((c) => c.scheduled_at && new Date(c.scheduled_at).getTime() > now).sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at)).slice(0, 8);

  const cmds = [
    { label: 'New post', icon: Plus, run: () => nav('/posts?new=1') },
    { label: 'Open calendar', icon: CalendarDays, run: () => nav('/posts?view=calendar') },
    { label: 'Review approvals', icon: ListChecks, run: () => nav('/posts?approval_status=pending') },
    ...(meta?.canva_configured !== false ? [{ label: 'Make images', icon: Sparkles, run: () => nav('/graphics') }] : []),
    { label: 'Video library', icon: Video, run: () => nav('/videos') },
  ];

  const okConns = agents.filter((a) => a.state === 'ok').length;

  return (
    <div className="hud">
      <Card title="Content overview" className="c3" bodyClass="">
        <div className="stat-rows">
          {rows.map((r) => (
            <button key={r.label} className={`stat-row ${r.tone}`} onClick={() => nav(r.to)}>
              <span className="ic"><r.icon size={15} /></span>
              <span><div className="l">{r.label}</div><div className="s">{r.sub}</div></span>
              <span className="v">{r.value}</span>
            </button>
          ))}
        </div>
      </Card>

      <Card className="c6 hero" bodyClass="">
        <div className="orbit o1" /><div className="orbit o2" /><div className="orbit o3" /><div className="core" />
        <div className="title">
          <div className="name">{brand?.videoBrand ?? 'CONTENT'}</div>
          <div className="sub">Content command center</div>
          <div className="ver">{brand?.subtitle ?? ''} · {live.length} posts in play · {okConns} of {agents.length || 6} channels live</div>
        </div>
      </Card>

      <Card title="Live feed" className="c3" bodyClass="" actions={<span className="tag ok">Live</span>}>
        {feed.length === 0 ? <Empty icon={<Activity size={26} />} title="All clear" /> : (
          <div className="feed">
            {feed.map((f, i) => (
              <button key={i} className="feed-item" onClick={f.onClick}>
                <span className="ic">{f.tag === 'bad' ? <XCircle size={14} /> : f.tag === 'warn' ? <AlertTriangle size={14} /> : <FileText size={14} />}</span>
                <span style={{ minWidth: 0, flex: 1 }}><div className="t">{f.title}</div><div className="b">{f.body}</div></span>
                <span className={`tag ${f.tag}`}>{f.label}</span>
              </button>
            ))}
          </div>
        )}
        <a className="footer-link" href="/posts?show=all" onClick={(e) => { e.preventDefault(); nav('/posts?show=all'); }}>View all posts ›</a>
      </Card>

      <Card title="Channels" className="c5" bodyClass="" actions={<a className="small" href="/settings" onClick={(e) => { e.preventDefault(); nav('/settings'); }}>Manage ›</a>}>
        {agents.length === 0 ? <div style={{ padding: 12 }}><LoadingRows rows={2} /></div> : (
          <div className="agents">
            {agents.map((a) => {
              const Icon = CONN_ICON[a.key];
              return (
                <button key={a.key} className="agent" onClick={() => nav('/settings')}>
                  <span className="ic"><Icon size={16} /></span>
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <div className="n">{a.label}</div>
                    <div className={`st ${a.state}`}><span className={`health-dot ${a.state === 'ok' ? 'ok' : a.state === 'bad' ? 'bad' : ''}`} style={a.state === 'off' ? { background: 'var(--text-3)' } : undefined} />{a.text}</div>
                    <div className="bars" style={{ color: a.state === 'ok' ? 'var(--success)' : 'var(--text-3)' }}>{Array.from({ length: 14 }, (_, i) => <i key={i} style={{ height: a.state === 'ok' ? `${30 + ((i * 37) % 70)}%` : '15%' }} />)}</div>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </Card>

      <Card title="Mission timeline" className="c4" bodyClass="" actions={<span className="small muted">Next 7 days</span>}>
        {next.length === 0 ? <Empty icon={<CalendarDays size={26} />} title="Nothing scheduled this week" /> : (
          <div className="timeline-hud">
            {next.slice(0, 8).map((c) => (
              <button key={c.id} className="tl-row" onClick={() => openContent(c.id)}>
                <span className="tm">{fmtDate(c.scheduled_at, tz).replace(/,.*$/, '')}<br />{fmtTime(c.scheduled_at, tz)}</span>
                <span className={`t ${c.approval_status} ${c.publish_status === 'published' ? 'published' : ''}`}>{c.title}</span>
                <span className="in">{c.publish_status === 'published' ? 'Done' : inWords(c.scheduled_at)}</span>
              </button>
            ))}
          </div>
        )}
        <a className="footer-link" href="/posts?view=calendar" onClick={(e) => { e.preventDefault(); nav('/posts?view=calendar'); }}>View full schedule ›</a>
      </Card>

      <Card title="Quick commands" className="c3" bodyClass="">
        <div className="cmds">
          {cmds.map((c) => <button key={c.label} className="cmd" onClick={c.run}><span className="ic"><c.icon size={13} /></span>{c.label}</button>)}
        </div>
      </Card>

      <Card title="Pipeline health" className="c4" bodyClass="">
        <div className="gauges">
          {[['Approved', pct(approved, live.length)], ['With image', pct(withImage, live.length)], ['Dated', pct(dated, live.length)]].map(([l, p]) => (
            <div key={l as string} className="gauge" style={{ ['--p' as any]: p }}><span><div className="n">{p}%</div><div className="l">{l}</div></span></div>
          ))}
        </div>
        <div className="small muted" style={{ padding: '0 14px 12px', textAlign: 'center' }}>{live.length} unpublished posts · {user!.name.split(' ')[0]}, times are {tz}</div>
      </Card>

      <Card title="Audience" className="c8" bodyClass="" actions={<span className="small muted">Live · refreshes every minute</span>}>
        <Performance />
      </Card>
    </div>
  );
}

const PLATFORMS = [
  { key: 'facebook', label: 'Facebook', follow: 'followers' },
  { key: 'instagram', label: 'Instagram', follow: 'followers' },
  { key: 'youtube', label: 'YouTube', follow: 'subscribers' },
] as const;
const n = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v >= 10_000 ? `${(v / 1000).toFixed(v >= 100_000 ? 0 : 1)}k` : v.toLocaleString());

/** Live social numbers per platform, plus the most recent posts. */
function Performance() {
  const { data, error, isFetching } = useQuery({ queryKey: ['performance'], queryFn: () => api.get<any>('/performance'), refetchInterval: 60_000, refetchIntervalInBackground: false });
  const [show, setShow] = useState<'all' | 'facebook' | 'instagram' | 'youtube'>('all');
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const age = data ? Math.max(0, Math.round((now - new Date(data.updated_at).getTime()) / 1000)) : null;

  if (error) return <div className="small muted" style={{ padding: 14 }}>Could not load audience numbers.</div>;
  if (!data) return <div style={{ padding: 14 }}><LoadingRows rows={2} /></div>;
  const accounts = PLATFORMS.flatMap((p) => (p.key === 'youtube' ? (data.youtube_channels ?? [data.youtube]) : [data[p.key]]).map((s: any) => ({ p, s })));
  const posts = accounts.flatMap(({ p, s }) => (s.posts ?? []).map((x: any) => ({ ...x, platform: p.key === 'youtube' && s.account ? `YouTube · ${s.account}` : p.label, key: p.key })))
    .filter((x) => show === 'all' || x.key === show)
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, 8);
  const series = posts.slice().reverse().map((x) => x.views ?? 0);
  const max = Math.max(1, ...series);
  const path = series.map((v, i) => `${(i / Math.max(1, series.length - 1)) * 100},${60 - (v / max) * 52}`).join(' ');

  return (
    <div>
      <div className="grid" style={{ padding: 12, gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
        {accounts.map(({ p, s }, i) => (
          <div key={p.key + i} className="metrics" style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--surface-2)', opacity: s.available ? 1 : 0.6 }}>
            <div style={{ gridColumn: '1 / -1' }} className="row"><Layers size={13} /><strong className="small">{p.label}</strong><span className="spacer" /><span className={`tag ${s.available ? 'ok' : 'warn'}`}>{s.available ? 'live' : 'not linked'}</span></div>
            {s.available ? [[p.follow, s.followers], ['views', s.totals.views], ['likes', s.totals.likes], ['comments', s.totals.comments]].map(([l, v]) => (
              <div key={l as string} className="metric"><div className="n">{n(v as number | null)}</div><div className="l">{l as string}</div></div>
            )) : <div className="small muted" style={{ gridColumn: '1 / -1' }}>{s.note}</div>}
          </div>
        ))}
      </div>
      <div className="row" style={{ padding: '0 12px 6px' }}>
        <strong className="small">Recent posts</strong>
        <span className="small muted">{isFetching && !data ? 'Loading…' : age === null ? '' : age < 5 ? 'just updated' : `updated ${age < 60 ? `${age}s` : `${Math.floor(age / 60)}m`} ago`}</span>
        <span className="spacer" />
        <div className="seg" role="tablist" aria-label="Platform">
          {(['all', 'facebook', 'instagram', 'youtube'] as const).map((kk) => <button key={kk} role="tab" aria-selected={show === kk} className={show === kk ? 'on' : ''} onClick={() => setShow(kk)}>{kk === 'all' ? 'All' : PLATFORMS.find((p) => p.key === kk)!.label}</button>)}
        </div>
      </div>
      {posts.length === 0 ? <Empty title="No published posts to show yet" /> : (
        <>
          <svg className="sparkline" viewBox="0 0 100 64" preserveAspectRatio="none" aria-hidden="true" style={{ padding: '0 12px' }}>
            <polyline points={path} fill="none" stroke="var(--primary)" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
            {series.map((v, i) => <circle key={i} cx={(i / Math.max(1, series.length - 1)) * 100} cy={60 - (v / max) * 52} r="1.6" fill="var(--primary)" />)}
          </svg>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Post</th><th className="hide-mobile">Where</th><th>Posted</th><th style={{ textAlign: 'right' }}>Views</th><th style={{ textAlign: 'right' }}>Likes</th><th style={{ textAlign: 'right' }}>Comments</th><th /></tr></thead>
              <tbody>
                {posts.map((x) => (
                  <tr key={x.key + x.id} className="static">
                    <td className="title-cell" title={x.text}>{x.text || '(no caption)'}</td>
                    <td className="hide-mobile small muted">{x.platform}</td>
                    <td className="small muted nowrap">{fmtRelative(x.at)}</td>
                    <td style={{ textAlign: 'right' }}>{n(x.views)}</td>
                    <td style={{ textAlign: 'right' }}>{n(x.likes)}</td>
                    <td style={{ textAlign: 'right' }}>{n(x.comments)}</td>
                    <td>{x.url && <a href={x.url} target="_blank" rel="noreferrer" aria-label="Open post"><ExternalLink size={13} /></a>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
