import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Archive, ArchiveRestore, CheckCircle2, ExternalLink, Plus, X, XCircle } from 'lucide-react';
import { api } from '../lib/api';
import { useAction, useBrand, useMeta } from '../lib/hooks';
import { useSession } from '../lib/session';
import { useUi } from '../lib/ui-state';
import { fmtDateTime, toLocalInput } from '../lib/format';
import { PLAYLISTS, YOUTUBE_LABELS, YOUTUBE_STATUSES, type YoutubeStatus } from '../../../shared/domain';
import { zonedToUtc } from '../../../shared/time';
import { ApprovalBadge, Badge, Button, Callout, ErrorState, LoadingRows, useConfirm } from './ui';

function YoutubePanel({ v, dirty }: { v: any; dirty: boolean }) {
  const { data: brand } = useBrand();
  const { data: conns } = useQuery({ queryKey: ['connections'], queryFn: () => api.get<any[]>('/connections') });
  const { data: runs } = useQuery({
    queryKey: ['runs', 'video', v.id],
    queryFn: () => api.get<any[]>('/runs'),
    refetchInterval: v.youtube_upload_status === 'uploading' ? 5000 : false,
  });
  const { can } = useSession();
  const { run, busy } = useAction();
  const { confirm, node } = useConfirm();
  const [vis, setVis] = useState<string>(v.youtube_status === 'public' ? 'public' : v.youtube_publish_at ? 'scheduled' : 'private');
  const yt = conns?.find((c) => c.key === 'youtube');
  const connected = !!yt?.oauth?.connected;
  const enabled = connected && yt?.automation_enabled;
  const lastUpload = runs?.find((r) => r.kind === 'youtube_upload' && r.summary?.includes(v.ref));
  const reason = !connected ? 'Connect YouTube on the Connections page first.' : !enabled ? 'An administrator must enable YouTube automation on the Connections page.' : dirty ? 'Save your changes first.' : null;
  const releaseFuture = v.release_at && new Date(v.release_at).getTime() > Date.now() + 15 * 60_000;

  const upload = async () => {
    const ok = await confirm({
      title: 'Upload this video to YouTube?',
      body: (
        <div className="stack-sm">
          <div>Streams <strong>{v.title}</strong> from Drive to the {brand?.videoBrand ?? ''} channel as <strong>{vis === 'scheduled' ? `private, publishing automatically on ${fmtDateTime(v.release_at)}` : vis}</strong>, with the public title, description, thumbnail and playlist from this record.</div>
          <div className="small muted">Uses about 1,600 of the channel's 10,000 daily API units. Large files can take several minutes; you can close this drawer. Until the Google project passes YouTube's API audit, uploads may be locked to private.</div>
        </div>
      ),
      confirmLabel: 'Upload',
    });
    if (ok === null) return;
    await run('up', () => api.post(`/videos/${v.id}/youtube/upload`, { visibility: vis }), 'Upload started');
  };
  const push = async () => {
    const ok = await confirm({
      title: vis === 'public' ? 'Make this video public on YouTube?' : 'Update this video on YouTube?',
      body: `Sets the title, description and visibility (${vis === 'scheduled' ? `scheduled for ${fmtDateTime(v.release_at)}` : vis}) on YouTube and adds it to its playlist. Nothing is deleted.`,
      confirmLabel: vis === 'public' ? 'Publish' : 'Update YouTube',
      typeToConfirm: vis === 'public' ? 'publish' : undefined,
    });
    if (ok === null) return;
    await run('push', () => api.post<any>(`/videos/${v.id}/youtube/push`, { visibility: vis }), (r) => `YouTube updated: ${r.youtube_status}${r.playlist?.added ? ', added to playlist' : ''}`);
  };

  return (
    <div className="card">
      {node}
      <div className="card-head"><h2>YouTube</h2><span className="spacer" />{v.youtube_views != null && <span className="small muted">{Number(v.youtube_views).toLocaleString()} views</span>}</div>
      <div className="card-body stack">
        {v.youtube_video_id ? (
          <div className="row-wrap small">
            <Badge tone={v.youtube_status === 'public' ? 'success' : 'info'}>{YOUTUBE_LABELS[v.youtube_status as YoutubeStatus]}</Badge>
            {v.youtube_publish_at && v.youtube_status === 'scheduled' && <span>publishes {fmtDateTime(v.youtube_publish_at)}</span>}
            <a href={v.youtube_url} target="_blank" rel="noreferrer">Open on YouTube <ExternalLink size={11} /></a>
            {v.youtube_synced_at && <span className="muted">synced {fmtDateTime(v.youtube_synced_at)}</span>}
          </div>
        ) : v.youtube_upload_status === 'uploading' ? (
          <Callout tone="info" title="Uploading…">Streaming from Drive to YouTube. This refreshes automatically.</Callout>
        ) : v.youtube_upload_status === 'failed' ? (
          <Callout tone="danger" title="Last upload failed">{lastUpload?.error ?? 'See Activity and Errors for details.'}</Callout>
        ) : (
          <div className="small muted">Not on YouTube yet.</div>
        )}
        {can('video.edit') && !v.archived_at && (
          <>
            <div className="row-wrap">
              <label className="small" htmlFor="yt-vis">Visibility</label>
              <select id="yt-vis" className="select sm" style={{ width: 'auto' }} value={vis} onChange={(e) => setVis(e.target.value)}>
                <option value="private">Private</option>
                <option value="unlisted">Unlisted</option>
                <option value="scheduled" disabled={!releaseFuture}>Scheduled (release date){releaseFuture ? '' : ' — set a future release date'}</option>
                {v.youtube_video_id && <option value="public">Public now</option>}
              </select>
              {v.youtube_video_id ? (
                <Button size="sm" variant="primary" loading={busy === 'push'} disabled={!!reason} title={reason ?? undefined} onClick={push}>Update on YouTube</Button>
              ) : (
                <Button size="sm" variant="primary" loading={busy === 'up'} disabled={!!reason || !v.drive_file_id || !v.public_title || !v.description || v.youtube_upload_status === 'uploading'} title={reason ?? (!v.drive_file_id ? 'Add the Drive video first' : !v.public_title ? 'Add a public title' : !v.description ? 'Add a description' : undefined)} onClick={upload}>Upload to YouTube</Button>
              )}
            </div>
            {reason && <div className="small muted">{reason}</div>}
          </>
        )}
      </div>
    </div>
  );
}

export function VideoDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { data: v, error, refetch } = useQuery({ queryKey: ['video', id], queryFn: () => api.get<any>(`/videos/${id}`) });
  const { data: meta } = useMeta();
  const tz = meta?.timezone ?? 'America/Chicago';
  const { can } = useSession();
  const { openContent } = useUi();
  const { run, busy } = useAction();
  const { confirm, node } = useConfirm();
  const [f, setF] = useState<any>(null);
  const editable = can('video.edit') && !v?.archived_at;

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('.modal') && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  useEffect(() => {
    if (!v) return;
    const r = toLocalInput(v.release_at, tz);
    setF({
      title: v.title ?? '', public_title: v.public_title ?? '', description: v.description ?? '', playlist: v.playlist ?? '',
      series_no: v.series_no ?? '', drive_url: v.drive_url ?? '', thumbnail_url: v.thumbnail_url ?? '', notes: v.notes ?? '',
      youtube_status: v.youtube_status, youtube_url: v.youtube_url ?? '', release_date: r.date, release_time: r.time || '10:00', campaign_id: v.campaign_id ?? '',
    });
  }, [v, tz]);

  const set = (k: string, val: any) => setF((x: any) => ({ ...x, [k]: val }));
  const save = () =>
    run('save', () =>
      api.patch(`/videos/${id}`, {
        title: f.title, public_title: f.public_title || null, description: f.description || null, playlist: f.playlist || null,
        series_no: f.series_no === '' ? null : Number(f.series_no), drive_url: f.drive_url || null, thumbnail_url: f.thumbnail_url || null,
        notes: f.notes || null, youtube_status: f.youtube_status, youtube_url: f.youtube_url || null, campaign_id: f.campaign_id || null,
        release_at: f.release_date ? zonedToUtc(f.release_date, f.release_time, tz).toISOString() : null,
      }), 'Video saved');
  const derive = async (kind: string, label: string) => {
    const r = await run(`d-${kind}`, () => api.post<any>(`/videos/${id}/derivatives`, { kind }), (r) => `Created ${r.ref}: ${label}`);
    if (r) openContent(r.id);
  };
  const archive = async () => {
    const ok = await confirm({ title: v.archived_at ? 'Restore video?' : 'Archive video?', body: v.archived_at ? 'The video returns to the library.' : 'Archived videos are hidden from the library and progress counts. Nothing is removed from YouTube or Drive.', confirmLabel: v.archived_at ? 'Restore' : 'Archive', tone: v.archived_at ? 'primary' : 'danger-solid' });
    if (ok !== null) await run('arch', () => api.post(`/videos/${id}/archive`, { archived: !v.archived_at }), v.archived_at ? 'Restored' : 'Archived');
  };

  return (
    <>
      <div className="overlay" onClick={onClose} />
      <div className="drawer" role="dialog" aria-modal="true" aria-label="Video">
        {node}
        <div className="drawer-head">
          <div style={{ flex: 1, minWidth: 0 }} className="stack-sm">
            {v && (
              <>
                <div className="row-wrap small muted"><span className="mono">{v.ref}</span>{v.series_no && <>· #{v.series_no}</>}{v.playlist && <>· {v.playlist}</>}</div>
                <h2 style={{ fontSize: 18 }}>{v.public_title || v.title}</h2>
                <div className="row-wrap">
                  <Badge tone={v.youtube_status === 'public' ? 'success' : v.youtube_status === 'not_uploaded' ? '' : 'info'}>{YOUTUBE_LABELS[v.youtube_status as YoutubeStatus]}</Badge>
                  {v.youtube_ready ? <Badge tone="success">YouTube-ready</Badge> : <Badge tone="warning">{v.missing.length} item(s) missing</Badge>}
                  {v.archived_at && <Badge tone="danger">Archived</Badge>}
                </div>
              </>
            )}
          </div>
          <Button variant="ghost" iconOnly aria-label="Close" onClick={onClose} icon={<X size={18} />} />
        </div>
        <div className="drawer-body">
          {error ? <ErrorState error={error} retry={refetch} /> : !v || !f ? <LoadingRows rows={10} /> : (
            <div className="tab-panel stack">
              <div className="card">
                <div className="card-head"><h2>YouTube readiness</h2></div>
                <div className="card-body grid grid-2" style={{ gap: 6 }}>
                  {['Final video file', 'Search-friendly public title', 'Description', 'Playlist', 'Thumbnail', 'Release date'].map((m) => (
                    <div key={m} className="row small">{v.missing.includes(m) ? <XCircle size={16} color="var(--danger)" /> : <CheckCircle2 size={16} color="var(--success)" />}{m}</div>
                  ))}
                </div>
              </div>
              <YoutubePanel v={v} dirty={!!f && (f.public_title !== (v.public_title ?? '') || f.description !== (v.description ?? '') || f.playlist !== (v.playlist ?? ''))} />
              <fieldset disabled={!editable} style={{ border: 0, padding: 0, margin: 0 }} className="stack">
                <div className="field"><label htmlFor="v-pt">Public YouTube title</label><input id="v-pt" className="input" value={f.public_title} onChange={(e) => set('public_title', e.target.value)} placeholder="e.g. Can You Wrap a Mortgage Without Lender Consent?" maxLength={120} /><span className="help">Question-first, subject up front, branding at the end. Don't number it ("Video 1"). {f.public_title.length}/100</span></div>
                <div className="grid grid-3">
                  <div className="field"><label htmlFor="v-t">Internal title</label><input id="v-t" className="input" value={f.title} onChange={(e) => set('title', e.target.value)} /></div>
                  <div className="field"><label htmlFor="v-s">Series #</label><input id="v-s" type="number" min={1} className="input" value={f.series_no} onChange={(e) => set('series_no', e.target.value)} /></div>
                  <div className="field"><label htmlFor="v-p">Playlist</label><select id="v-p" className="select" value={f.playlist} onChange={(e) => set('playlist', e.target.value)}><option value="">Choose…</option>{PLAYLISTS.map((p) => <option key={p}>{p}</option>)}</select></div>
                </div>
                <div className="field"><label htmlFor="v-d">Description</label><textarea id="v-d" className="textarea" rows={6} value={f.description} onChange={(e) => set('description', e.target.value)} placeholder="Unique description with one or two principal search terms, the call to action and the disclaimer." /></div>
                <div className="grid grid-2">
                  <div className="field"><label htmlFor="v-du">Final video (Drive link)</label><input id="v-du" className="input" value={f.drive_url} onChange={(e) => set('drive_url', e.target.value)} /></div>
                  <div className="field"><label htmlFor="v-th">Thumbnail link</label><input id="v-th" className="input" value={f.thumbnail_url} onChange={(e) => set('thumbnail_url', e.target.value)} /></div>
                </div>
                <div className="grid grid-3">
                  <div className="field"><label htmlFor="v-rd">Release date</label><input id="v-rd" type="date" className="input" value={f.release_date} onChange={(e) => set('release_date', e.target.value)} /></div>
                  <div className="field"><label htmlFor="v-rt">Time ({tz})</label><input id="v-rt" type="time" className="input" value={f.release_time} onChange={(e) => set('release_time', e.target.value)} /></div>
                  <div className="field"><label htmlFor="v-c">Campaign</label><select id="v-c" className="select" value={f.campaign_id} onChange={(e) => set('campaign_id', e.target.value)}><option value="">None</option>{meta?.campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
                </div>
                <div className="grid grid-2">
                  <div className="field"><label htmlFor="v-ys">YouTube status</label><select id="v-ys" className="select" value={f.youtube_status} onChange={(e) => set('youtube_status', e.target.value)}>{YOUTUBE_STATUSES.map((s) => <option key={s} value={s}>{YOUTUBE_LABELS[s]}</option>)}</select></div>
                  <div className="field"><label htmlFor="v-yu">YouTube URL</label><input id="v-yu" className="input" value={f.youtube_url} onChange={(e) => set('youtube_url', e.target.value)} placeholder="https://youtu.be/…" />{f.youtube_status !== 'not_uploaded' && !f.youtube_url && <span className="error">Required once uploaded.</span>}</div>
                </div>
                <div className="field"><label htmlFor="v-n">Notes</label><textarea id="v-n" className="textarea" rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} /></div>
              </fieldset>
              <div className="row-wrap">
                {v.drive_url && <a className="btn sm" href={v.drive_url} target="_blank" rel="noreferrer"><ExternalLink size={13} /> Open in Drive</a>}
                {v.youtube_url && <a className="btn sm" href={v.youtube_url} target="_blank" rel="noreferrer"><ExternalLink size={13} /> Open on YouTube</a>}
              </div>
              <div className="card">
                <div className="card-head"><h2>Social derivatives</h2><span className="small muted">Reel · micro-clip · text/carousel</span></div>
                <div className="card-body stack">
                  {meta?.derivatives.map((d) => {
                    const ct = d.kind === 'reel' ? 'reel' : d.kind === 'micro' ? 'short' : 'carousel';
                    const existing = v.derivatives.filter((x: any) => x.content_type === ct);
                    return (
                      <div key={d.kind} className="row-wrap">
                        <span style={{ minWidth: 200 }}>{d.label}</span>
                        {existing.length ? existing.map((x: any) => (
                          <button key={x.id} className="btn sm" onClick={() => openContent(x.id)}><span className="mono">{x.ref}</span><ApprovalBadge s={x.approval_status} /></button>
                        )) : can('content.edit') && !v.archived_at ? (
                          <Button size="sm" icon={<Plus size={13} />} loading={busy === `d-${d.kind}`} onClick={() => derive(d.kind, d.label)}>Create draft</Button>
                        ) : <span className="muted small">Not created</span>}
                      </div>
                    );
                  })}
                  {v.derivatives.filter((x: any) => !['reel', 'short', 'carousel'].includes(x.content_type)).map((x: any) => (
                    <button key={x.id} className="list-item card" onClick={() => openContent(x.id)}><span className="mono muted">{x.ref}</span><span className="grow t">{x.title}</span><span className="small muted">{fmtDateTime(x.scheduled_at, tz)}</span></button>
                  ))}
                </div>
              </div>
              {v.activity.length > 0 && (
                <div className="card"><div className="card-head"><h2>Activity</h2></div><div className="card-body timeline">
                  {v.activity.map((a: any) => <div key={a.id} className="tl-item"><span className="tl-dot" /><div><strong>{a.action}</strong> <span className="muted small">{a.actor_email} · {fmtDateTime(a.created_at, tz)}</span></div></div>)}
                </div></div>
              )}
            </div>
          )}
        </div>
        {v && f && (
          <div className="drawer-foot">
            {editable && <Button variant="primary" loading={busy === 'save'} disabled={!f.title.trim()} onClick={save}>Save</Button>}
            <span className="spacer" />
            {can('video.edit') && <Button variant="ghost" icon={v.archived_at ? <ArchiveRestore size={15} /> : <Archive size={15} />} loading={busy === 'arch'} onClick={archive}>{v.archived_at ? 'Restore' : 'Archive'}</Button>}
          </div>
        )}
      </div>
    </>
  );
}
