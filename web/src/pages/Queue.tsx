import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, ListOrdered, Pause, Play, RotateCcw, X } from 'lucide-react';
import { api } from '../lib/api';
import { useAction } from '../lib/hooks';
import { useSession } from '../lib/session';
import { useUi } from '../lib/ui-state';
import { fmtDateTime } from '../lib/format';
import { PLATFORM_CONNECTION, PLATFORM_LABELS, type Platform } from '../../../shared/domain';
import { Badge, Button, Callout, Card, Empty, ErrorState, LoadingRows, useConfirm } from '../components/ui';

const TABS = [
  { key: 'live', label: 'Scheduled' },
  { key: 'failed', label: 'Failed' },
  { key: 'history', label: 'History' },
  { key: 'published', label: 'Published' },
];

export default function Queue() {
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('tab') ?? 'live';
  const { can } = useSession();
  const { openContent } = useUi();
  const { run, busy } = useAction();
  const { confirm, node } = useConfirm();
  const { data, error, isLoading, refetch } = useQuery({
    queryKey: ['queue', tab],
    queryFn: () => (tab === 'published' ? api.get<any[]>('/publications') : api.get<any[]>(`/queue?state=${tab}`)),
    refetchInterval: tab === 'live' ? 30_000 : false,
  });
  const { data: conns } = useQuery({ queryKey: ['connections'], queryFn: () => api.get<any[]>('/connections') });
  const automationFor = (p: Platform) => {
    const k = PLATFORM_CONNECTION[p];
    const c = conns?.find((x) => x.key === k);
    return !!c && c.status === 'connected' && c.automation_enabled;
  };
  const anyAutomation = conns?.some((c) => ['facebook', 'instagram', 'youtube'].includes(c.key) && c.automation_enabled);

  const act = async (q: any, action: 'pause' | 'resume' | 'cancel' | 'retry') => {
    const copy = {
      pause: { t: 'Pause this post?', b: 'It stays in the queue but will not publish until resumed.', c: 'Pause' },
      resume: { t: 'Resume this post?', b: `It will publish at ${fmtDateTime(q.run_at)} if its connection is live.`, c: 'Resume' },
      cancel: { t: 'Remove from queue?', b: 'The record keeps its approval and can be queued again later.', c: 'Remove' },
      retry: { t: 'Retry this publication?', b: /Outcome unknown/.test(q.last_error ?? '') ? 'The previous attempt may have posted. Check the platform first; if it is live, record it as published from the record instead.' : `Last error: ${q.last_error ?? 'unknown'}. The dashboard blocks any duplicate publication.`, c: 'Retry' },
    }[action];
    const ok = await confirm({ title: copy.t, body: copy.b, confirmLabel: copy.c, tone: action === 'cancel' ? 'danger-solid' : 'primary' });
    if (ok === null) return;
    await run(`${action}-${q.id}`, () => api.post(`/queue/${q.id}/${action}`), `${copy.c} done`);
  };

  return (
    <div>
      {node}
      <div className="page-head">
        <div><h1>Publishing Queue</h1><div className="sub">Approved content waiting for its slot. The dispatcher re-validates every item before hand-off to n8n.</div></div>
      </div>
      {!anyAutomation && (
        <div style={{ marginBottom: 16 }}>
          <Callout tone="info" title="Automated publishing is off">
            No platform automation is enabled yet. Queued posts wait safely; items that miss their slot by more than 2 hours fail instead of posting late. Enable automation on the Connections page once Meta or YouTube access is granted.
          </Callout>
        </div>
      )}
      <Card bodyClass="">
        <div className="tabs" role="tablist" style={{ padding: '0 16px' }}>
          {TABS.map((t) => <button key={t.key} role="tab" aria-selected={tab === t.key} className={tab === t.key ? 'on' : ''} onClick={() => setSp({ tab: t.key })}>{t.label}</button>)}
        </div>
        {error ? <ErrorState error={error} retry={refetch} /> : isLoading ? <LoadingRows /> : !data?.length ? <Empty icon={<ListOrdered size={28} />} title={tab === 'live' ? 'Nothing queued' : 'Nothing here'}>{tab === 'live' && 'Approve content and use “Add to queue” from the record.'}</Empty> : tab === 'published' ? (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Published</th><th>Record</th><th>Destination</th><th>Method</th><th>Platform ID / URL</th></tr></thead>
              <tbody>
                {data.map((p) => (
                  <tr key={p.id} onClick={() => openContent(p.content_id)}>
                    <td className="nowrap small">{fmtDateTime(p.published_at)}</td>
                    <td className="title-cell"><span className="mono muted">{p.ref}</span> {p.title}</td>
                    <td>{PLATFORM_LABELS[p.platform as Platform]} · {p.placement}</td>
                    <td><Badge tone={p.method === 'automated' ? 'primary' : ''}>{p.method}</Badge></td>
                    <td className="small">{p.public_url ? <a href={p.public_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>View <ExternalLink size={11} /></a> : p.platform_post_id ?? <span className="muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Run at</th><th>Record</th><th>Destination</th><th>State</th><th className="hide-mobile">Detail</th><th /></tr></thead>
              <tbody>
                {data.map((q) => (
                  <tr key={q.id} onClick={() => openContent(q.content_id)}>
                    <td className="nowrap small">{fmtDateTime(q.run_at)}</td>
                    <td className="title-cell"><span className="mono muted">{q.ref}</span> {q.title}</td>
                    <td className="nowrap">{PLATFORM_LABELS[q.platform as Platform]} · {q.placement}</td>
                    <td><Badge tone={q.state === 'failed' ? 'danger' : q.state === 'paused' ? 'warning' : q.state === 'published' ? 'success' : q.state === 'cancelled' ? '' : 'info'}>{q.state}</Badge></td>
                    <td className="hide-mobile small" style={{ maxWidth: 320 }}>
                      {q.last_error ? <span style={{ color: q.state === 'failed' ? 'var(--danger)' : undefined }}>{q.last_error}</span> : q.state === 'scheduled' && !automationFor(q.platform) ? <span className="muted">Waiting for {PLATFORM_LABELS[q.platform as Platform]} automation</span> : q.public_url ? <a href={q.public_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>View post</a> : <span className="muted">attempts: {q.attempts}</span>}
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <div className="row" style={{ justifyContent: 'flex-end' }}>
                        {can('queue.manage') && q.state === 'scheduled' && <Button size="sm" icon={<Pause size={13} />} loading={busy === `pause-${q.id}`} onClick={() => act(q, 'pause')}>Pause</Button>}
                        {can('queue.manage') && q.state === 'paused' && <Button size="sm" icon={<Play size={13} />} loading={busy === `resume-${q.id}`} onClick={() => act(q, 'resume')}>Resume</Button>}
                        {can('queue.retry') && q.state === 'failed' && <Button size="sm" icon={<RotateCcw size={13} />} loading={busy === `retry-${q.id}`} onClick={() => act(q, 'retry')}>Retry</Button>}
                        {can('queue.manage') && ['scheduled', 'paused', 'failed'].includes(q.state) && <Button size="sm" variant="ghost" iconOnly aria-label="Remove from queue" icon={<X size={14} />} loading={busy === `cancel-${q.id}`} onClick={() => act(q, 'cancel')} />}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
