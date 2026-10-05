import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { CalendarDays, List, Plus, Search } from 'lucide-react';
import { api, qs } from '../lib/api';
import { useAction, useMeta } from '../lib/hooks';
import { useSession } from '../lib/session';
import { useUi } from '../lib/ui-state';
import { fmtDateTime } from '../lib/format';
import { PLATFORM_LABELS, type ContentItem } from '../../../shared/domain';
import Calendar from './Calendar';
import { ContentForm, toFormValue, toPayload } from '../components/ContentForm';
import { ApprovalBadge, Button, Card, Empty, ErrorState, LoadingRows, Modal, Pager, PublishBadge, useConfirm } from '../components/ui';

const FILTER_KEYS = ['q', 'approval_status', 'publish_status', 'missing_assets', 'needs_details', 'archived', 'show'] as const;

/** Quick filters: the few questions people actually ask of the list. */
const CHIPS: { key: string; label: string; set: Partial<Record<(typeof FILTER_KEYS)[number], string>> }[] = [
  { key: 'upcoming', label: 'Upcoming', set: {} },
  { key: 'approval', label: 'Needs approval', set: { approval_status: 'pending' } },
  { key: 'details', label: 'Needs details', set: { needs_details: 'true' } },
  { key: 'image', label: 'Needs an image', set: { missing_assets: 'true' } },
  { key: 'scheduled', label: 'Scheduled', set: { publish_status: 'queued' } },
  { key: 'posted', label: 'Posted', set: { publish_status: 'published' } },
  { key: 'failed', label: 'Failed', set: { publish_status: 'failed' } },
  { key: 'all', label: 'All', set: { show: 'all' } },
];

const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString(); };
const isPast = (c: ContentItem) => !!c.scheduled_at && new Date(c.scheduled_at).getTime() < Date.now();
// Its time has gone by and nothing went out (and nothing is still trying).
const missed = (c: ContentItem) => isPast(c) && !c.archived_at && ['unscheduled', 'failed'].includes(c.publish_status);

export default function ContentDatabase() {
  const [sp, setSp] = useSearchParams();
  const { can } = useSession();
  const { openContent } = useUi();
  const [creating, setCreating] = useState(() => sp.get('new') === '1');
  const [qInput, setQInput] = useState(sp.get('q') ?? '');
  const view = sp.get('view') === 'calendar' ? 'calendar' : 'list';
  const filters = Object.fromEntries(FILTER_KEYS.map((k) => [k, sp.get(k) ?? ''])) as Record<(typeof FILTER_KEYS)[number], string>;
  const page = Number(sp.get('page') ?? 1);
  const chip = CHIPS.find((c) => c.key !== 'upcoming' && Object.entries(c.set).every(([k, v]) => filters[k as keyof typeof filters] === v))?.key ?? 'upcoming';

  useEffect(() => setQInput(sp.get('q') ?? ''), [sp]);
  useEffect(() => {
    const t = setTimeout(() => {
      if ((sp.get('q') ?? '') !== qInput) update({ q: qInput });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qInput]);

  const update = (patch: Record<string, string | number | null>) => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) (v === '' || v === null ? next.delete(k) : next.set(k, String(v)));
    if (!('page' in patch)) next.delete('page');
    setSp(next, { replace: true });
  };
  const pickChip = (key: string) => {
    const set = CHIPS.find((c) => c.key === key)!.set;
    update({ approval_status: set.approval_status ?? '', publish_status: set.publish_status ?? '', missing_assets: set.missing_assets ?? '', needs_details: set.needs_details ?? '', show: set.show ?? '' });
  };
  // Upcoming and Scheduled read soonest-first from today; the other views newest-first.
  const soonest = chip === 'upcoming' || chip === 'scheduled';
  const { show: _show, ...apiFilters } = filters;
  const params = { ...apiFilters, page, page_size: 25, sort: 'scheduled_at', dir: soonest ? 'asc' : 'desc', from: chip === 'upcoming' ? startOfToday() : '' };
  const { data, error, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['content-list', params],
    queryFn: () => api.get<{ items: ContentItem[]; total: number; page: number; pageSize: number }>(`/content${qs(params)}`),
    placeholderData: keepPreviousData,
    enabled: view === 'list',
  });

  return (
    <div>
      <div className="page-head">
        <div><h1>Posts</h1><div className="sub">Everything planned for Facebook, Instagram and YouTube. The planning sheet syncs in automatically.</div></div>
        <span className="spacer" />
        <div className="seg" role="tablist" aria-label="View">
          <button role="tab" aria-selected={view === 'list'} className={view === 'list' ? 'on' : ''} onClick={() => update({ view: '' })}><List size={14} /> List</button>
          <button role="tab" aria-selected={view === 'calendar'} className={view === 'calendar' ? 'on' : ''} onClick={() => update({ view: 'calendar' })}><CalendarDays size={14} /> Calendar</button>
        </div>
        {can('content.edit') && <Button variant="primary" icon={<Plus size={15} />} onClick={() => setCreating(true)}>New post</Button>}
      </div>
      {view === 'calendar' ? <Calendar embedded /> : (
        <Card bodyClass="">
          <div className="filters">
            <div className="seg" role="tablist" aria-label="Show">
              {CHIPS.map((c) => <button key={c.key} role="tab" aria-selected={chip === c.key} className={chip === c.key ? 'on' : ''} onClick={() => pickChip(c.key)}>{c.label}</button>)}
            </div>
            <span className="spacer" />
            <div className="search" style={{ maxWidth: 280 }}>
              <Search size={16} />
              <input type="search" placeholder="Search posts…" aria-label="Search" value={qInput} onChange={(e) => setQInput(e.target.value)} />
            </div>
          </div>
          {error ? <ErrorState error={error} retry={refetch} /> : isLoading ? <LoadingRows rows={10} /> : data!.items.length === 0 ? (
            <Empty title={chip === 'upcoming' && !filters.q ? 'Nothing coming up' : 'Nothing here'}>{chip === 'upcoming' && !filters.q ? 'New posts from the planning sheet appear here automatically. See All for past posts.' : 'Try another filter.'}</Empty>
          ) : (
            <>
              <div className="table-wrap" style={{ opacity: isFetching ? 0.7 : 1, transition: 'opacity .15s' }}>
                <table className="table">
                  <thead>
                    <tr><th>Post</th><th>When</th><th className="hide-mobile">Where</th><th>Approval</th><th className="hide-mobile">Publishing</th></tr>
                  </thead>
                  <tbody>
                    {data!.items.map((c) => (
                      <tr key={c.id} tabIndex={0} className={isPast(c) ? 'row-past' : undefined} onClick={() => openContent(c.id)} onKeyDown={(e) => e.key === 'Enter' && openContent(c.id)}>
                        <td className="title-cell" title={c.title}>
                          {c.title}
                          {missed(c) ? <span className="badge danger" style={{ marginLeft: 6 }} title="The date passed and it was never published">Missed</span> : c.asset_count === 0 && <span className="badge warning" style={{ marginLeft: 6 }}>No image</span>}
                          {c.archived_at && <span className="badge danger" style={{ marginLeft: 6 }}>Archived</span>}
                        </td>
                        <td className="nowrap small">{fmtDateTime(c.scheduled_at, c.timezone)}</td>
                        <td className="hide-mobile small">{[...new Set(c.targets.map((t) => PLATFORM_LABELS[t.platform]))].join(', ') || <span className="muted">—</span>}</td>
                        <td><ApprovalBadge s={c.approval_status} /></td>
                        <td className="hide-mobile"><PublishBadge s={c.publish_status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pager page={data!.page} pageSize={data!.pageSize} total={data!.total} onPage={(p) => update({ page: p })} />
            </>
          )}
        </Card>
      )}
      {creating && <CreateContentModal onClose={() => setCreating(false)} />}
    </div>
  );
}

export function CreateContentModal({ onClose, preset }: { onClose: () => void; preset?: Partial<ContentItem> }) {
  const { data: meta } = useMeta();
  const [form, setForm] = useState(() => toFormValue(preset ?? null, meta?.timezone ?? 'America/Chicago'));
  const { run, busy } = useAction();
  const { openContent } = useUi();
  const create = async () => {
    const r = await run('create', () => api.post<ContentItem>('/content', toPayload(form)), (r) => `Created ${r.ref}`);
    if (r) {
      onClose();
      openContent(r.id);
    }
  };
  return (
    <Modal wide title="New content" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!form.title.trim()} loading={busy === 'create'} onClick={create}>Create draft</Button></>}>
      <ContentForm value={form} onChange={setForm} />
    </Modal>
  );
}
