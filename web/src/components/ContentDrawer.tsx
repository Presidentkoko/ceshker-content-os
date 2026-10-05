import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle, Archive, ArchiveRestore, CalendarClock, Check, CheckCircle2, Copy, ExternalLink, FlaskConical, Image as ImageIcon,
  ListPlus, Pause, Play, Plus, RotateCcw, Send, ShieldCheck, Sparkles, Trash2, Undo2, X, XCircle,
} from 'lucide-react';
import { api } from '../lib/api';
import { useAction, useMeta } from '../lib/hooks';
import { useSession } from '../lib/session';
import { useUi } from '../lib/ui-state';
import { fmtDateTime, fmtRelative, toLocalInput } from '../lib/format';
import { PLATFORM_CONNECTION, PLATFORM_LABELS, type ContentItem, type Platform } from '../../../shared/domain';
import { zonedToUtc } from '../../../shared/time';
import { ContentForm, toFormValue, toPayload, type ContentFormValue } from './ContentForm';
import { BrandBadge } from './BrandCheck';
import { ApprovalBadge, Badge, Button, Callout, Empty, ErrorState, LoadingRows, Modal, Priority, PublishBadge, ReadinessBadge, useConfirm } from './ui';

type Tab = 'post' | 'image' | 'publish';

interface Detail {
  item: ContentItem;
  assets: any[];
  approvals: any[];
  queue: any[];
  publications: any[];
  runs: any[];
  activity: any[];
  related: any[];
}

/** " → Page name" for Facebook/Instagram destinations once Pages are configured. */
function accountLabel(meta: ReturnType<typeof useMeta>['data'], t: { platform: string; account_id?: string | null }) {
  if ((t.platform !== 'facebook' && t.platform !== 'instagram') || !meta?.meta_pages?.length) return '';
  const page = t.account_id
    ? meta.meta_pages.find((p) => (t.platform === 'facebook' ? p.page_id === t.account_id : p.ig_user_id === t.account_id))
    : meta.meta_pages.find((p) => p.is_default);
  if (!page) return ' → unavailable Page';
  return t.platform === 'instagram' ? ` → @${page.ig_username ?? '?'}` : ` → ${page.name}`;
}

export function ContentDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, error, isLoading, refetch } = useQuery({ queryKey: ['content', id], queryFn: () => api.get<Detail>(`/content/${id}`) });
  const { data: conns } = useQuery({ queryKey: ['connections'], queryFn: () => api.get<any[]>('/connections') });
  const { data: meta } = useMeta();
  const tz = meta?.timezone ?? 'America/Chicago';
  const { can } = useSession();
  const { openContent, openVideo, toast } = useUi();
  const { run, busy } = useAction();
  const { confirm, node: confirmNode } = useConfirm();
  const [tab, setTab] = useState<Tab>('post');
  const [form, setForm] = useState<ContentFormValue | null>(null);
  const [modal, setModal] = useState<null | 'reschedule' | 'asset' | 'manual'>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const f = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('.modal') && onClose();
    window.addEventListener('keydown', f);
    panelRef.current?.focus();
    return () => window.removeEventListener('keydown', f);
  }, [onClose]);
  useEffect(() => {
    if (data && !form) setForm(toFormValue(data.item, tz));
  }, [data, form, tz]);
  useEffect(() => {
    setForm(null);
    setTab('post');
  }, [id]);

  const item = data?.item;
  const dirty = useMemo(() => !!(item && form && JSON.stringify(toFormValue(item, tz)) !== JSON.stringify(form)), [item, form, tz]);

  if (!data || !item) {
    return (
      <Shell onClose={onClose} panelRef={panelRef} title="Loading…">
        {error ? <ErrorState error={error} retry={refetch} /> : isLoading && <LoadingRows rows={10} />}
      </Shell>
    );
  }

  const errors = item.issues.filter((i) => i.severity === 'error');
  const warnings = item.issues.filter((i) => i.severity === 'warning');
  const locked = item.publish_status === 'published' || !!item.archived_at;
  const canEdit = can('content.edit') && !locked;
  const submitBlockers = errors.filter((e) => !['not_approved', 'schedule_missing'].includes(e.code));
  const liveQueue = data.queue.filter((q) => ['scheduled', 'paused', 'dispatching', 'failed'].includes(q.state));
  const publishedTargets = new Set(data.publications.map((p) => p.target_id));
  const queuedTargets = new Set(liveQueue.map((q) => q.target_id));
  const openTargets = item.targets.filter((t) => !publishedTargets.has(t.id) && !queuedTargets.has(t.id));
  const canQueue = can('queue.manage') && item.approval_status === 'approved' && errors.length === 0 && openTargets.length > 0 && !item.archived_at;
  const connState = (p: Platform) => {
    const key = PLATFORM_CONNECTION[p];
    if (!key) return { ok: false, reason: `${PLATFORM_LABELS[p]} has no automated publishing integration; record it manually once posted.` };
    const c = conns?.find((x) => x.key === key);
    if (!c || c.status !== 'connected') return { ok: false, reason: c?.blocker ?? `${PLATFORM_LABELS[p]} is not connected.` };
    if (!c.automation_enabled) return { ok: false, reason: `${PLATFORM_LABELS[p]} automation has not been enabled by an administrator.` };
    return { ok: true, reason: '' };
  };
  const v = { version: item.version };

  const save = async () => {
    if (!form) return;
    const r = await run('save', () => api.patch<{ item: ContentItem; approvalReset: boolean }>(`/content/${id}`, { ...toPayload(form), ...v }), (r) =>
      r.approvalReset ? 'Saved. Approval was reset because approved content changed.' : 'Draft saved',
    );
    if (r) setForm(toFormValue(r.item, tz));
  };
  const transition = async (kind: 'submit' | 'approve' | 'reject' | 'request-revision') => {
    const labels = {
      submit: { title: 'Submit for approval?', body: 'Approvers will be notified to review this record.', btn: 'Submit', ok: 'Submitted for approval' },
      approve: { title: 'Approve this content?', body: 'Approved content can be added to the publishing queue. Any later substantive edit will return it to draft.', btn: 'Approve', ok: 'Approved' },
      reject: { title: 'Reject this content?', body: 'Rejecting removes it from the queue. Explain why so the author can respond.', btn: 'Reject', ok: 'Rejected' },
      'request-revision': { title: 'Request a revision?', body: 'The author will see your comment. Queued entries are cancelled.', btn: 'Request revision', ok: 'Revision requested' },
    }[kind];
    const needComment = kind === 'reject' || kind === 'request-revision';
    const c = await confirm({ title: labels.title, body: labels.body, confirmLabel: labels.btn, tone: kind === 'reject' ? 'danger-solid' : 'primary', comment: { label: 'Comment', required: needComment } });
    if (c === null) return;
    await run(kind, () => api.post(`/content/${id}/${kind}`, { ...v, comment: c || null }), labels.ok);
  };
  const enqueue = async () => {
    const ok = await confirm({
      title: 'Schedule approved content?',
      body: (
        <div className="stack-sm">
          <div>Adds {openTargets.length} destination{openTargets.length === 1 ? '' : 's'} to the publishing queue for <strong>{fmtDateTime(item.scheduled_at, item.timezone)}</strong> ({item.timezone}).</div>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {openTargets.map((t) => {
              const s = connState(t.platform);
              return <li key={t.id}>{PLATFORM_LABELS[t.platform]} {t.placement}{accountLabel(meta, t)}{!s.ok && <span className="muted"> — will wait: {s.reason}</span>}</li>;
            })}
          </ul>
          <div className="small muted">Nothing publishes without a live, administrator-enabled connection. Items that miss their slot by more than 2 hours fail instead of posting late.</div>
        </div>
      ),
      confirmLabel: 'Add to queue',
    });
    if (ok === null) return;
    await run('queue', () => api.post(`/content/${id}/queue`, v), 'Added to the publishing queue');
  };
  const archive = async (archived: boolean) => {
    const ok = await confirm({
      title: archived ? 'Archive this record?' : 'Restore this record?',
      body: archived ? 'Archiving hides it from the calendar and cancels any unpublished queue entries. Published posts are never deleted from the platforms.' : 'The record returns to the active library as it was.',
      confirmLabel: archived ? 'Archive' : 'Restore',
      tone: archived ? 'danger-solid' : 'primary',
    });
    if (ok === null) return;
    await run('archive', () => api.post(`/content/${id}/archive`, { archived }), archived ? 'Archived' : 'Restored');
  };
  const duplicate = async () => {
    const r = await run('dup', () => api.post<ContentItem>(`/content/${id}/duplicate`), (r) => `Duplicated as ${r.ref}`);
    if (r) openContent(r.id);
  };

  const tabs: [Tab, string][] = [
    ['post', canEdit ? 'Post' : 'Details'],
    ['image', `Image${data.assets.length ? ` (${data.assets.length})` : ''}`],
    ['publish', 'Approve & publish'],
  ];

  // The footer offers only the one next step for this post, plus approver actions.
  const next =
    can('content.submit') && ['draft', 'rejected', 'revision_requested'].includes(item.approval_status) && !item.archived_at ? (
      <>
        <Button variant="primary" icon={<Send size={15} />} loading={busy === 'submit'} disabled={submitBlockers.length > 0 || dirty} title={submitBlockers.length ? `Fix first: ${submitBlockers.map((b) => b.message).join(' ')}` : dirty ? 'Save your changes first' : undefined} onClick={() => transition('submit')}>
          Submit for approval
        </Button>
        {/* Say why the button is off, not only on hover. */}
        {!dirty && submitBlockers.length > 0 && <span className="small muted" style={{ maxWidth: 300 }}>First: {submitBlockers[0].message}{submitBlockers.length > 1 ? ` (+${submitBlockers.length - 1} more on Approve & publish)` : ''}</span>}
      </>
    ) : can('content.approve') && item.approval_status === 'pending' ? (
      <>
        <Button variant="success" icon={<Check size={15} />} loading={busy === 'approve'} onClick={() => transition('approve')}>Approve</Button>
        <Button icon={<Undo2 size={15} />} loading={busy === 'request-revision'} onClick={() => transition('request-revision')}>Request changes</Button>
      </>
    ) : canQueue ? (
      <Button variant="primary" icon={<ListPlus size={15} />} loading={busy === 'queue'} onClick={enqueue}>Schedule</Button>
    ) : can('queue.manage') && !locked && liveQueue.length > 0 && item.publish_status !== 'publishing' ? (
      <Button icon={<CalendarClock size={15} />} onClick={() => setModal('reschedule')}>Change time</Button>
    ) : null;

  return (
    <Shell
      onClose={onClose}
      panelRef={panelRef}
      title={
        <div className="stack-sm" style={{ gap: 6 }}>
          <div className="row-wrap small muted">
            <span className="mono">{item.ref}</span>·<span>{item.category}</span>
            {item.archived_at && <Badge tone="danger">Archived</Badge>}
          </div>
          <h2 style={{ fontSize: 18 }}>{item.title}</h2>
          <div className="row-wrap">
            <ApprovalBadge s={item.approval_status} />
            <PublishBadge s={item.publish_status} />
            {item.scheduled_at && <span className="small muted">{fmtDateTime(item.scheduled_at, item.timezone)}</span>}
          </div>
        </div>
      }
      tabs={<div className="tabs" role="tablist">{tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>}
      footer={
        <>
          {tab === 'post' && canEdit && dirty ? (
            <>
              <Button variant="primary" loading={busy === 'save'} disabled={!form?.title.trim()} onClick={save}>Save</Button>
              <Button variant="ghost" onClick={() => setForm(toFormValue(item, tz))}>Discard</Button>
              {['approved', 'pending'].includes(item.approval_status) && <span className="small" style={{ color: 'var(--warning)' }}>Saving returns it to draft for re-approval.</span>}
            </>
          ) : next}
          <span className="spacer" />
          {can('content.edit') && <Button variant="ghost" iconOnly aria-label="Duplicate" title="Duplicate" icon={<Copy size={15} />} loading={busy === 'dup'} onClick={duplicate} />}
          {can('content.archive') && item.publish_status !== 'publishing' && (
            <Button variant="ghost" iconOnly aria-label={item.archived_at ? 'Restore' : 'Archive'} title={item.archived_at ? 'Restore' : 'Archive'} icon={item.archived_at ? <ArchiveRestore size={15} /> : <Archive size={15} />} loading={busy === 'archive'} onClick={() => archive(!item.archived_at)} />
          )}
        </>
      }
    >
      {confirmNode}
      {tab === 'post' && form && (
        <div className="tab-panel">
          {!canEdit && <div style={{ marginBottom: 12 }}><Callout tone="info">{locked ? (item.archived_at ? 'Archived records are read-only. Restore to edit.' : 'Published content is locked. Duplicate it to create a new version.') : 'Your role can view but not edit content.'}</Callout></div>}
          <ContentForm value={form} onChange={setForm} disabled={!canEdit} />
          {item.notes && <div style={{ marginTop: 12 }}><Callout tone="info" title="Notes">{item.notes}</Callout></div>}
        </div>
      )}
      {tab === 'image' && (
        <div className="tab-panel stack">
          <div className="row-wrap">
            {canEdit && <Button variant={data.assets.some((a) => a.approved) ? 'default' : 'primary'} icon={<Sparkles size={14} />} loading={busy === 'cv-auto'} title="Make a graphic from the Canva template with this post's title and date" onClick={() => run('cv-auto', () => api.post<any>('/content/' + id + '/canva/auto'), 'Graphic made in Canva. Check it, then approve it.')}>{data.assets.length ? 'Make another in Canva' : 'Auto-generate'}</Button>}
            {canEdit && <Button icon={<Plus size={14} />} onClick={() => setModal('asset')}>Upload or Canva link</Button>}
          </div>
          {data.assets.length === 0 && <Empty icon={<ImageIcon size={28} />} title="No image yet">Auto-generate one from Canva, or upload your own.</Empty>}
          {data.assets.map((a) => <AssetRow key={a.id} a={a} canEdit={canEdit} canApprove={can('content.approve') && !locked} />)}
          {data.assets.length > 0 && <PreviewPanel item={item} assets={data.assets} />}
        </div>
      )}
      {tab === 'publish' && (
        <div className="tab-panel stack">
          <ReadinessPanel item={item} errors={errors} warnings={warnings} approvalCount={data.approvals.length} />
          {item.targets.length > 0 && <PublishingPanel data={data} connState={connState} onManual={() => setModal('manual')} tz={tz} />}
          {data.approvals.length > 0 && (
            <div className="stack-sm">
              <span className="field-label">Approval history</span>
              <div className="timeline">
                {data.approvals.map((a) => (
                  <div key={a.id} className="tl-item">
                    <span className={`tl-dot ${a.action === 'approved' ? 'success' : a.action === 'rejected' || a.action === 'revision_requested' ? 'danger' : ''}`} />
                    <div>
                      <div><strong>{a.action.replace('_', ' ')}</strong> <span className="muted">by {a.actor_name ?? 'planning sheet import'} · {fmtDateTime(a.created_at, tz)}</span></div>
                      {a.comment && <div className="caption-box small" style={{ marginTop: 4 }}>{a.comment}</div>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {data.activity.length > 0 && (
            <details>
              <summary className="small muted" style={{ cursor: 'pointer' }}>Full change log ({data.activity.length})</summary>
              <div className="timeline" style={{ marginTop: 8 }}>
                {data.activity.map((a) => (
                  <div key={a.id} className="tl-item">
                    <span className={`tl-dot ${a.result === 'success' ? '' : 'danger'}`} />
                    <div style={{ minWidth: 0 }}>
                      <div><strong>{a.action}</strong> <span className="muted">· {a.actor_email} · {fmtDateTime(a.created_at, tz)}</span> {a.result !== 'success' && <Badge tone="danger">{a.result}</Badge>}</div>
                      {a.detail && <div className="small muted">{a.detail}</div>}
                      {(a.previous || a.next) && <ChangeDiff prev={a.previous} next={a.next} />}
                    </div>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}
      {modal === 'reschedule' && <RescheduleModal item={item} onClose={() => setModal(null)} />}
      {modal === 'asset' && <AssetModal contentId={id} canApprove={can('content.approve')} onClose={() => setModal(null)} />}
      {modal === 'manual' && <ManualPublishModal item={item} targets={item.targets.filter((t) => !publishedTargets.has(t.id))} onClose={() => setModal(null)} />}
    </Shell>
  );
}

function Shell({ children, onClose, title, tabs, footer, panelRef }: { children: React.ReactNode; onClose: () => void; title: React.ReactNode; tabs?: React.ReactNode; footer?: React.ReactNode; panelRef: React.RefObject<HTMLDivElement> }) {
  return (
    <>
      <div className="overlay" onClick={onClose} />
      <div className="drawer" role="dialog" aria-modal="true" aria-label="Content record" tabIndex={-1} ref={panelRef}>
        <div className="drawer-head">
          <div style={{ flex: 1, minWidth: 0 }}>{title}</div>
          <Button variant="ghost" iconOnly aria-label="Close" onClick={onClose} icon={<X size={18} />} />
        </div>
        {tabs}
        <div className="drawer-body">{children}</div>
        {footer && <div className="drawer-foot">{footer}</div>}
      </div>
    </>
  );
}

function ReadinessPanel({ item, errors, warnings, approvalCount }: { item: ContentItem; errors: any[]; warnings: any[]; approvalCount: number }) {
  const checks = [
    { label: 'Title', ok: !errors.some((e) => e.code === 'title_missing') },
    { label: 'Caption / description', ok: !errors.some((e) => ['caption_missing', 'yt_description_missing'].includes(e.code)) },
    { label: 'Destinations selected', ok: item.targets.length > 0 },
    { label: 'Approved media', ok: !errors.some((e) => ['asset_missing', 'asset_unapproved'].includes(e.code)) },
    { label: 'Date and time', ok: !!item.scheduled_at },
    { label: 'Approval', ok: item.approval_status === 'approved' },
    { label: 'Platform limits', ok: !errors.some((e) => /too_long|too_many/.test(e.code)) },
  ];
  return (
    <div className="card">
      <div className="card-head"><h2>Readiness checklist</h2><span className="spacer" /><ReadinessBadge r={item.readiness} /></div>
      <div className="card-body stack">
        <div className="grid grid-2" style={{ gap: 6 }}>
          {checks.map((c) => (
            <div key={c.label} className="row small">
              {c.ok ? <CheckCircle2 size={16} color="var(--success)" /> : <XCircle size={16} color="var(--danger)" />}
              <span style={{ color: c.ok ? 'var(--text-2)' : 'var(--text)' }}>{c.label}</span>
            </div>
          ))}
        </div>
        {errors.length > 0 && (
          <Callout tone="danger" title="Must be fixed before publishing">
            <ul style={{ margin: 0, paddingLeft: 18 }}>{errors.map((e, i) => <li key={i}>{e.message}</li>)}</ul>
          </Callout>
        )}
        {warnings.length > 0 && (
          <Callout tone="warning" title="Warnings">
            <ul style={{ margin: 0, paddingLeft: 18 }}>{warnings.map((e, i) => <li key={i}>{e.message}</li>)}</ul>
          </Callout>
        )}
        {approvalCount === 0 && item.approval_status === 'draft' && <div className="small muted">Not yet submitted for approval.</div>}
      </div>
    </div>
  );
}

function ChangeDiff({ prev, next }: { prev: any; next: any }) {
  const keys = [...new Set([...Object.keys(prev ?? {}), ...Object.keys(next ?? {})])].slice(0, 8);
  if (!keys.length) return null;
  const show = (v: any) => (v === null || v === undefined ? '∅' : typeof v === 'string' ? (v.length > 80 ? v.slice(0, 80) + '…' : v) : JSON.stringify(v).slice(0, 80));
  return (
    <div className="small" style={{ marginTop: 4 }}>
      {keys.map((k) => (
        <div key={k} style={{ overflowWrap: 'anywhere' }}>
          <span className="muted">{k}:</span> {prev && k in prev && <><del style={{ color: 'var(--danger)' }}>{show(prev[k])}</del> → </>}<span style={{ color: 'var(--success)' }}>{show(next?.[k])}</span>
        </div>
      ))}
    </div>
  );
}

function driveThumb(url: string) {
  const id = url.match(/\/d\/([\w-]{10,})/)?.[1];
  return id ? `https://drive.google.com/thumbnail?id=${id}&sz=w800` : null;
}

/** Preview URL: the dashboard's stored copy when there is one, otherwise the Drive thumbnail. */
function assetPreview(a: any) {
  return a.stored ? `/api/assets/${a.id}/file` : driveThumb(a.url);
}

function PreviewPanel({ item, assets }: { item: ContentItem; assets: any[] }) {
  const { data: meta } = useMeta();
  const platforms = [...new Set(item.targets.map((t) => t.platform))];
  const [p, setP] = useState<Platform | undefined>(platforms[0]);
  const media = assets.find((a) => a.approved && (a.kind === 'image' || a.kind === 'video')) ?? assets.find((a) => a.kind === 'image' || a.kind === 'video');
  const thumb = media ? assetPreview(media) : null;
  const placement = item.targets.find((t) => t.platform === p)?.placement;
  const vertical = placement === 'story' || placement === 'reel' || placement === 'short';
  const text = [item.caption, item.cta, item.hashtags].filter(Boolean).join('\n\n');
  if (!platforms.length) return <div className="tab-panel"><Empty title="Select a destination to preview platform output" /></div>;
  return (
    <div className="tab-panel stack">
      <div className="seg" role="tablist" aria-label="Platform">
        {platforms.map((x) => <button key={x} className={p === x ? 'on' : ''} onClick={() => setP(x)}>{PLATFORM_LABELS[x]}</button>)}
      </div>
      <div className="preview-frame">
        <div className="pf-head">
          <span className="avatar">{meta?.brand.mark ?? 'CG'}</span>
          <div style={{ lineHeight: 1.2 }}><strong>{p === 'youtube' ? meta?.brand.videoBrand ?? '' : meta?.brand.socialName ?? ''}</strong><div className="small muted">{placement} · {fmtDateTime(item.scheduled_at, item.timezone)}</div></div>
        </div>
        {p === 'youtube' && <div className="pf-text" style={{ fontWeight: 600 }}>{item.title}</div>}
        <div className={`pf-media ${vertical ? 'vertical' : p === 'youtube' ? 'wide' : ''}`}>
          {thumb ? <img src={thumb} alt="Asset preview" style={{ width: '100%', height: '100%', objectFit: 'cover' }} referrerPolicy="no-referrer" onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')} /> : <span className="small">{media ? 'Preview available in Drive' : 'No media attached'}</span>}
        </div>
        <div className="pf-text">{p === 'youtube' ? item.description || item.caption || <span className="muted">No description</span> : text || <span className="muted">No caption</span>}</div>
      </div>
      {p === 'instagram' && text.length > 2200 && <Callout tone="danger">Instagram will truncate: caption is {text.length} characters (limit 2,200).</Callout>}
      <div className="small muted">Preview approximates layout; the platform renders the final post. Drive thumbnails load only for files shared with your Google account.</div>
    </div>
  );
}

function AssetRow({ a, canEdit, canApprove }: { a: any; canEdit: boolean; canApprove: boolean }) {
  const { run, busy } = useAction();
  const thumb = assetPreview(a);
  const isCanva = a.kind === 'image' && (!!a.canva_design_id || /canva\.com\/design\//.test(a.url));
  return (
    <div className="card" style={{ display: 'flex', gap: 12, padding: 10, alignItems: 'center' }}>
      <div style={{ width: 56, height: 56, borderRadius: 8, background: 'var(--surface-3)', flex: 'none', overflow: 'hidden', display: 'grid', placeItems: 'center' }}>
        {thumb ? <img src={thumb} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} referrerPolicy="no-referrer" onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')} /> : <ImageIcon size={20} color="var(--text-3)" />}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="row-wrap"><strong>{a.label || a.kind}</strong><Badge>{a.kind}</Badge>{a.approved ? <Badge tone="success">Approved</Badge> : ['image', 'video'].includes(a.kind) && <Badge tone="warning">Not approved</Badge>}<BrandBadge check={a.brand_check} /></div>
        {a.brand_check && a.brand_check.status !== 'pass' && <div className="small" style={{ color: a.brand_check.status === 'fail' ? 'var(--danger)' : 'var(--text-2)' }}>{a.brand_check.detail}</div>}
        {a.stored ? (
          <a className="small" href={`/api/assets/${a.id}/file`} target="_blank" rel="noreferrer">Stored in dashboard · {a.size_bytes ? `${Math.round(a.size_bytes / 1024)} KB` : ''} {a.url.startsWith('upload://') ? '· uploaded' : '· imported from link'} <ExternalLink size={11} /></a>
        ) : (
          <a className="small" href={a.url} target="_blank" rel="noreferrer" style={{ overflowWrap: 'anywhere' }}>{a.url.length > 70 ? a.url.slice(0, 70) + '…' : a.url} <ExternalLink size={11} /></a>
        )}
      </div>
      {canEdit && isCanva && <Button size="sm" variant="ghost" icon={<ShieldCheck size={14} />} loading={busy === 'bc'} title="Check this design's logo in Canva" onClick={() => run('bc', () => api.post<any>(`/assets/${a.id}/brand-check`), (r: any) => `Brand check: ${r.status === 'pass' ? 'approved logo found' : r.status === 'fail' ? 'wrong logo' : r.status === 'review' ? 'no logo found' : 'could not run'}`)}>Check brand</Button>}
      {canEdit && isCanva && a.brand_check?.status === 'fail' && <Button size="sm" variant="primary" loading={busy === 'fx'} title="Replace the fake logo with the approved Ceshker logo in Canva, then re-export" onClick={() => run('fx', () => api.post<any>(`/assets/${a.id}/fix-logo`), (r: any) => (r.changed ? `Logo fixed in Canva (${r.changed}). New image attached, not approved yet.` : 'Nothing to fix.'))}>Fix logo</Button>}
      {canApprove && ['image', 'video', 'thumbnail'].includes(a.kind) && (
        <Button size="sm" loading={busy === 'ap'} onClick={() => run('ap', () => api.patch(`/assets/${a.id}`, { approved: !a.approved }), a.approved ? 'Asset approval removed' : 'Asset approved')}>
          {a.approved ? 'Unapprove' : 'Approve'}
        </Button>
      )}
      {canEdit && <Button size="sm" variant="ghost" iconOnly aria-label="Remove asset" icon={<Trash2 size={14} />} loading={busy === 'rm'} onClick={() => run('rm', () => api.del(`/assets/${a.id}`), 'Asset removed')} />}
    </div>
  );
}

function PublishingPanel({ data, connState, onManual, tz }: { data: Detail; connState: (p: Platform) => { ok: boolean; reason: string }; onManual: () => void; tz: string }) {
  const { can } = useSession();
  const { run, busy } = useAction();
  const { confirm, node } = useConfirm();
  const item = data.item;
  const retry = async (q: any) => {
    const ok = await confirm({
      title: 'Retry this failed publication?',
      body: (
        <div className="stack-sm">
          <div>Last error: <em>{q.last_error ?? 'unknown'}</em></div>
          {/Outcome unknown/.test(q.last_error ?? '') && <Callout tone="warning">The previous attempt may have posted. Check {PLATFORM_LABELS[q.platform as Platform]} first; if it is live, record it as published instead of retrying.</Callout>}
          <div className="small muted">The retry reuses the same idempotency key, and the dashboard refuses to publish a destination twice.</div>
        </div>
      ),
      confirmLabel: 'Retry',
    });
    if (ok === null) return;
    await run(`retry-${q.id}`, () => api.post(`/queue/${q.id}/retry`), 'Retry scheduled');
  };
  return (
    <div className="tab-panel stack">
      {node}
      <div className="card">
        <div className="card-head"><h2>Destinations</h2><span className="spacer" />{can('queue.manage') && item.approval_status === 'approved' && data.publications.length < item.targets.length && <Button size="sm" onClick={onManual}>Record manual post</Button>}</div>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Destination</th><th>Automation</th><th>Queue</th><th>Result</th></tr></thead>
            <tbody>
              {item.targets.map((t) => {
                const pub = data.publications.find((p) => p.target_id === t.id);
                const q = data.queue.find((x) => x.target_id === t.id && x.state !== 'cancelled');
                const c = connState(t.platform);
                return (
                  <tr key={t.id} className="static">
                    <td>{PLATFORM_LABELS[t.platform]} · {t.placement}</td>
                    <td>{c.ok ? <Badge tone="success">Enabled</Badge> : <span className="small muted" title={c.reason}>Unavailable <AlertTriangle size={12} /></span>}</td>
                    <td>
                      {q ? <div className="row-wrap"><Badge tone={q.state === 'failed' ? 'danger' : q.state === 'paused' ? 'warning' : 'info'}>{q.state}</Badge><span className="small muted">{fmtDateTime(q.run_at, tz)}</span></div> : <span className="muted small">—</span>}
                      {q?.state === 'failed' && <div className="small" style={{ color: 'var(--danger)' }}>{q.last_error}</div>}
                    </td>
                    <td>
                      {pub ? (
                        <div className="stack-sm" style={{ gap: 2 }}>
                          <Badge tone="success">Published {pub.method === 'manual' ? '(manual)' : ''}</Badge>
                          {pub.public_url && <a className="small" href={pub.public_url} target="_blank" rel="noreferrer">View post <ExternalLink size={11} /></a>}
                          {pub.platform_post_id && <span className="mono muted">{pub.platform_post_id}</span>}
                        </div>
                      ) : q?.state === 'failed' && can('queue.retry') ? (
                        <Button size="sm" icon={<RotateCcw size={13} />} loading={busy === `retry-${q.id}`} onClick={() => retry(q)}>Retry</Button>
                      ) : q && ['scheduled', 'paused'].includes(q.state) && can('queue.manage') ? (
                        <Button size="sm" icon={q.state === 'paused' ? <Play size={13} /> : <Pause size={13} />} loading={busy === `p-${q.id}`} onClick={() => run(`p-${q.id}`, () => api.post(`/queue/${q.id}/${q.state === 'paused' ? 'resume' : 'pause'}`), q.state === 'paused' ? 'Resumed' : 'Paused')}>
                          {q.state === 'paused' ? 'Resume' : 'Pause'}
                        </Button>
                      ) : <span className="muted small">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function RescheduleModal({ item, onClose }: { item: ContentItem; onClose: () => void }) {
  const init = toLocalInput(item.scheduled_at, item.timezone);
  const [date, setDate] = useState(init.date);
  const [time, setTime] = useState(init.time || '10:00');
  const { run, busy } = useAction();
  const iso = date ? zonedToUtc(date, time, item.timezone).toISOString() : null;
  const past = iso ? new Date(iso).getTime() < Date.now() : false;
  return (
    <Modal
      title="Reschedule"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!iso || past} loading={busy === 'r'} onClick={async () => {
            const r = await run('r', () => api.post(`/content/${item.id}/reschedule`, { scheduled_at: iso, version: item.version }), 'Rescheduled');
            if (r) onClose();
          }}>Confirm new time</Button>
        </>
      }
    >
      <div className="stack">
        <div className="grid grid-2">
          <div className="field"><label htmlFor="rs-d">Date</label><input id="rs-d" type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} /></div>
          <div className="field"><label htmlFor="rs-t">Time ({item.timezone})</label><input id="rs-t" type="time" className="input" value={time} onChange={(e) => setTime(e.target.value)} /></div>
        </div>
        {past && <Callout tone="warning">Choose a time in the future.</Callout>}
        <div className="small muted">Queued destinations move with the record. Approval is kept because the content itself does not change.</div>
      </div>
    </Modal>
  );
}

function AssetModal({ contentId, canApprove, onClose }: { contentId: string; canApprove: boolean; onClose: () => void }) {
  const [mode, setMode] = useState<'upload' | 'canva'>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const [design, setDesign] = useState('');
  const [approved, setApproved] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { run, busy } = useAction();
  const inputRef = useRef<HTMLInputElement>(null);
  const validDesign = /canva\.com\/design\/[A-Za-z0-9_-]{8,}/.test(design.trim());

  const pick = (f: File | undefined | null) => {
    setErr(null);
    if (!f) return;
    if (!/^image\/(jpeg|png|webp|gif)$/.test(f.type)) return setErr('Choose a JPG, PNG or WebP image.');
    if (f.size > 20 * 1024 * 1024) return setErr('Images must be 20 MB or smaller.');
    setFile(f);
    setPreview((old) => {
      if (old) URL.revokeObjectURL(old);
      return URL.createObjectURL(f);
    });
  };
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const submit = async () => {
    const r = mode === 'upload' && file
      ? await run('a', async () => {
          const res = await fetch(`/api/content/${contentId}/assets/upload`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': file.type, 'x-filename': encodeURIComponent(file.name), 'x-label': encodeURIComponent(file.name.replace(/\.\w+$/, '')), 'x-approved': String(approved) },
            body: file,
          });
          const j = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(j.error ?? `Upload failed (${res.status})`);
          return j;
        }, 'Image uploaded')
      : await run('a', () => api.post(`/content/${contentId}/canva`, { mode: 'design', design: design.trim() }), 'Image added from Canva. Check it, then approve it.');
    if (r) onClose();
  };
  const ready = mode === 'upload' ? !!file : validDesign;

  return (
    <Modal title="Add an image" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!ready} loading={busy === 'a'} onClick={submit}>{mode === 'upload' ? 'Upload' : 'Add from Canva'}</Button></>}>
      <div className="stack">
        <div className="seg" role="tablist" aria-label="How to add">
          <button role="tab" aria-selected={mode === 'upload'} className={mode === 'upload' ? 'on' : ''} onClick={() => setMode('upload')}>Upload a file</button>
          <button role="tab" aria-selected={mode === 'canva'} className={mode === 'canva' ? 'on' : ''} onClick={() => setMode('canva')}>Canva design link</button>
        </div>
        {mode === 'upload' ? (
          <div
            role="button"
            tabIndex={0}
            aria-label="Choose an image or drop it here"
            onClick={() => inputRef.current?.click()}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && inputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); pick(e.dataTransfer.files?.[0]); }}
            style={{ border: `2px dashed ${drag ? 'var(--primary)' : 'var(--border-strong)'}`, background: drag ? 'var(--primary-soft)' : 'var(--surface-2)', borderRadius: 10, padding: 16, textAlign: 'center', cursor: 'pointer' }}
          >
            <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden onChange={(e) => pick(e.target.files?.[0])} />
            {preview ? (
              <div className="stack-sm" style={{ alignItems: 'center' }}>
                <img src={preview} alt="Selected image" style={{ maxHeight: 220, maxWidth: '100%', borderRadius: 8 }} />
                <span className="small muted">{file?.name} · click to change</span>
              </div>
            ) : (
              <div className="stack-sm" style={{ alignItems: 'center', padding: '18px 0' }}>
                <ImageIcon size={28} color="var(--text-3)" />
                <strong>Drop an image here, or click to choose</strong>
                <span className="small muted">JPG, PNG or WebP · up to 20 MB</span>
              </div>
            )}
          </div>
        ) : (
          <div className="field">
            <label htmlFor="cv-d">Canva design link</label>
            <input id="cv-d" className="input" value={design} onChange={(e) => setDesign(e.target.value)} placeholder="https://www.canva.com/design/…" />
            <span className="help">Copy it from Canva’s Share button. Page 1 is added as the image.</span>
            {design && !validDesign && <span className="error">Paste a canva.com/design/… link.</span>}
          </div>
        )}
        {canApprove && mode === 'upload' && <label className="row"><input type="checkbox" checked={approved} onChange={(e) => setApproved(e.target.checked)} /> This image is approved</label>}
        {err && <Callout tone="danger">{err}</Callout>}
      </div>
    </Modal>
  );
}
function ManualPublishModal({ item, targets, onClose }: { item: ContentItem; targets: ContentItem['targets']; onClose: () => void }) {
  const [target, setTarget] = useState(targets[0]?.id ?? '');
  const [url, setUrl] = useState('');
  const { run, busy } = useAction();
  return (
    <Modal title="Record a manual post" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!target} loading={busy === 'm'} onClick={async () => { const r = await run('m', () => api.post(`/content/${item.id}/publications`, { target_id: target, public_url: url || null }), 'Publication recorded'); if (r) onClose(); }}>Record as published</Button></>}>
      <div className="stack">
        <div className="small muted">Use this when the team posted by hand. It records the public URL and blocks any automated post to the same destination.</div>
        <div className="field"><label htmlFor="mp-t">Destination</label><select id="mp-t" className="select" value={target} onChange={(e) => setTarget(e.target.value)}>{targets.map((t) => <option key={t.id} value={t.id}>{PLATFORM_LABELS[t.platform]} · {t.placement}</option>)}</select></div>
        <div className="field"><label htmlFor="mp-u">Public URL (optional)</label><input id="mp-u" className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.facebook.com/…" /></div>
      </div>
    </Modal>
  );
}
