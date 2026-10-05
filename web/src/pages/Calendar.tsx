import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { api, qs } from '../lib/api';
import { useMeta } from '../lib/hooks';
import { useSession } from '../lib/session';
import { useUi } from '../lib/ui-state';
import { fmtDate, fmtTime } from '../lib/format';
import { dayKey, zonedToUtc } from '../../../shared/time';
import { PLATFORM_LABELS, type ContentItem } from '../../../shared/domain';
import { ApprovalBadge, Button, Card, Empty, ErrorState, LoadingRows, Priority, PublishBadge } from '../components/ui';
import { CreateContentModal } from './ContentDatabase';

type View = 'month' | 'week' | 'list';
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function addDays(d: string, n: number) {
  const x = new Date(`${d}T12:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}
const dow = (d: string) => new Date(`${d}T12:00:00Z`).getUTCDay();

export default function Calendar({ embedded = false }: { embedded?: boolean }) {
  const { data: meta } = useMeta();
  const tz = meta?.timezone ?? 'America/Chicago';
  const today = dayKey(new Date(), tz);
  const [view, setView] = useState<View>(() => (window.innerWidth < 720 ? 'list' : 'month'));
  const [anchor, setAnchor] = useState(today);
  const [platform, setPlatform] = useState('');
  const [category, setCategory] = useState('');
  const [creating, setCreating] = useState(false);
  const { openContent } = useUi();
  const { can } = useSession();

  const range = useMemo(() => {
    if (view === 'month') {
      const first = anchor.slice(0, 8) + '01';
      const start = addDays(first, -dow(first));
      return { start, days: 42, label: new Date(`${first}T12:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }) };
    }
    if (view === 'week') {
      const start = addDays(anchor, -dow(anchor));
      return { start, days: 7, label: `${fmtDate(zonedToUtc(start, '12:00', tz).toISOString(), tz)} – ${fmtDate(zonedToUtc(addDays(start, 6), '12:00', tz).toISOString(), tz)}` };
    }
    return { start: anchor, days: 30, label: `Next 30 days from ${fmtDate(zonedToUtc(anchor, '12:00', tz).toISOString(), tz)}` };
  }, [view, anchor, tz]);

  const from = zonedToUtc(range.start, '00:00', tz).toISOString();
  const to = zonedToUtc(addDays(range.start, range.days), '00:00', tz).toISOString();
  const { data, error, isLoading, refetch } = useQuery({
    queryKey: ['calendar', from, to, platform, category],
    queryFn: () => api.get<{ items: ContentItem[] }>(`/content${qs({ from, to, platform, category, page_size: 500, sort: 'scheduled_at', dir: 'asc' })}`),
  });
  const byDay = useMemo(() => {
    const m = new Map<string, ContentItem[]>();
    for (const c of data?.items ?? []) {
      const k = dayKey(c.scheduled_at!, tz);
      m.set(k, [...(m.get(k) ?? []), c]);
    }
    return m;
  }, [data, tz]);

  const step = (n: number) => {
    if (view === 'month') {
      const d = new Date(`${anchor.slice(0, 8)}01T12:00:00Z`);
      d.setUTCMonth(d.getUTCMonth() + n);
      setAnchor(d.toISOString().slice(0, 10));
    } else setAnchor(addDays(anchor, n * (view === 'week' ? 7 : 30)));
  };
  const days = Array.from({ length: range.days }, (_, i) => addDays(range.start, i));
  const monthOf = anchor.slice(0, 7);

  return (
    <div>
      {!embedded && <div className="page-head">
        <div><h1>Content Calendar</h1><div className="sub">{range.label} · {tz}</div></div>
        <span className="spacer" />
        {can('content.edit') && <Button variant="primary" icon={<Plus size={15} />} onClick={() => setCreating(true)}>New content</Button>}
      </div>}
      <Card bodyClass="">
        <div className="filters">
          <div className="row">
            <Button size="sm" iconOnly aria-label="Previous" icon={<ChevronLeft size={16} />} onClick={() => step(-1)} />
            <Button size="sm" onClick={() => setAnchor(today)}>Today</Button>
            <Button size="sm" iconOnly aria-label="Next" icon={<ChevronRight size={16} />} onClick={() => step(1)} />
          </div>
          <strong style={{ marginLeft: 4 }}>{range.label}</strong>
          <span className="spacer" />
          <select className="select sm" aria-label="Platform" value={platform} onChange={(e) => setPlatform(e.target.value)} style={{ width: 'auto' }}>
            <option value="">All platforms</option>
            {meta?.platforms.map((p) => <option key={p} value={p}>{PLATFORM_LABELS[p as keyof typeof PLATFORM_LABELS]}</option>)}
          </select>
          <select className="select sm" aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value)} style={{ width: 'auto' }}>
            <option value="">All categories</option>
            {meta?.categories.map((c) => <option key={c}>{c}</option>)}
          </select>
          <div className="seg" role="tablist" aria-label="Calendar view">
            {(['month', 'week', 'list'] as View[]).map((v) => <button key={v} role="tab" aria-selected={view === v} className={view === v ? 'on' : ''} onClick={() => setView(v)}>{v[0].toUpperCase() + v.slice(1)}</button>)}
          </div>
        </div>
        <div className="legend" style={{ padding: '8px 16px' }}>
          <span><i style={{ background: 'var(--success)' }} />Approved</span>
          <span><i style={{ background: 'var(--warning)' }} />Awaiting approval</span>
          <span><i style={{ background: 'var(--danger)' }} />Needs revision / rejected</span>
          <span><i style={{ background: 'var(--chart-6)' }} />Draft</span>
          <span>Faded = published</span>
        </div>
        {error ? <ErrorState error={error} retry={refetch} /> : isLoading ? <LoadingRows rows={8} /> : view === 'list' ? (
          <ListView days={days} byDay={byDay} tz={tz} onOpen={openContent} />
        ) : (
          <>
            {view === 'month' && <div className="show-mobile small muted" style={{ padding: 16 }}>Month view is available on larger screens. Showing list view.</div>}
            {view === 'month' && <div className="show-mobile"><ListView days={days.filter((d) => d.startsWith(monthOf))} byDay={byDay} tz={tz} onOpen={openContent} /></div>}
            <div className={`table-wrap ${view === 'month' ? 'cal-month' : ''}`}>
              <div className={`cal ${view === 'week' ? 'cal-week' : ''}`} style={{ minWidth: 720 }}>
                {DOW.map((d) => <div key={d} className="cal-dow">{d}</div>)}
                {days.map((d) => {
                  const items = byDay.get(d) ?? [];
                  const max = view === 'week' ? 50 : 4;
                  return (
                    <div key={d} className={`cal-cell ${view === 'month' && !d.startsWith(monthOf) ? 'out' : ''} ${d === today ? 'today' : ''}`}>
                      <span className="cal-day">{Number(d.slice(8))}</span>
                      {items.slice(0, max).map((c) => (
                        <button key={c.id} className={`cal-evt ${c.approval_status} ${c.publish_status === 'published' ? 'published' : ''}`} onClick={() => openContent(c.id)} title={`${c.title} · ${fmtTime(c.scheduled_at, tz)}`}>
                          {c.priority === 1 && <span className="prio p1" style={{ width: 16, height: 16, fontSize: 9 }}>1</span>}
                          <span className="t">{view === 'week' && <span className="muted">{fmtTime(c.scheduled_at, tz)} </span>}{c.title}</span>
                        </button>
                      ))}
                      {items.length > max && <button className="cal-more" onClick={() => { setAnchor(d); setView('week'); }}>+{items.length - max} more</button>}
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </Card>
      {creating && <CreateContentModal onClose={() => setCreating(false)} />}
    </div>
  );
}

function ListView({ days, byDay, tz, onOpen }: { days: string[]; byDay: Map<string, ContentItem[]>; tz: string; onOpen: (id: string) => void }) {
  const withItems = days.filter((d) => byDay.get(d)?.length);
  if (!withItems.length) return <Empty title="Nothing scheduled in this range" />;
  return (
    <div className="list">
      {withItems.map((d) => (
        <div key={d}>
          <div className="small" style={{ padding: '8px 16px', fontWeight: 600, background: 'var(--surface-2)', borderBottom: '1px solid var(--border)' }}>{fmtDate(zonedToUtc(d, '12:00', tz).toISOString(), tz)}</div>
          {byDay.get(d)!.map((c) => (
            <button key={c.id} className="list-item" onClick={() => onOpen(c.id)}>
              <span className="small muted nowrap" style={{ width: 64 }}>{fmtTime(c.scheduled_at, tz)}</span>
              <Priority p={c.priority} />
              <span className="grow"><div className="t">{c.title}</div><div className="small muted">{c.category} · {[...new Set(c.targets.map((t) => PLATFORM_LABELS[t.platform]))].join(', ') || 'No destination'}</div></span>
              <span className="row hide-mobile"><ApprovalBadge s={c.approval_status} /><PublishBadge s={c.publish_status} /></span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
