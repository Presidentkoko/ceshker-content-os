import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Check, ExternalLink, Image as ImageIcon, Sparkles, Wand2, ShieldCheck } from 'lucide-react';
import { api } from '../lib/api';
import { useAction } from '../lib/hooks';
import { useSession } from '../lib/session';
import { useUi } from '../lib/ui-state';
import { fmtDateTime, fmtRelative } from '../lib/format';
import { Badge, Button, Callout, Card, Empty, ErrorState, LoadingRows, useConfirm } from '../components/ui';
import { BrandBadge } from '../components/BrandCheck';

/**
 * Graphics: make post images in Canva. Posts waiting for an image, one-click and bulk generation,
 * the templates and which posts use them, the automatic switch, and recent images to approve.
 * Every image lands on its post as not approved; nothing publishes until an approver checks it.
 */
export default function Graphics() {
  const { can } = useSession();
  const { run, busy } = useAction();
  const { toast, openContent } = useUi();
  const { confirm, node } = useConfirm();
  const [watching, setWatching] = useState(false);
  const { data: d, error, isLoading, refetch } = useQuery({
    queryKey: ['canva-overview'],
    queryFn: () => api.get<any>('/canva/overview'),
    refetchInterval: (q) => (q.state.data?.job?.running ? 3000 : false),
  });
  const job = d?.job;

  useEffect(() => {
    if (watching && job && !job.running) {
      setWatching(false);
      const ok = job.results.filter((r: any) => r.ok).length;
      const failed = job.results.filter((r: any) => !r.ok);
      toast(failed.length ? 'error' : 'success', `Done: ${ok} image${ok === 1 ? '' : 's'} made${failed.length ? `, ${failed.length} failed` : ''}`,
        failed.length ? failed.slice(0, 3).map((f: any) => `${f.ref}: ${f.detail}`).join(' · ') : 'Check them under Recently made, then approve.');
    }
  }, [watching, job, toast]);

  if (error) return <ErrorState error={error} retry={refetch} />;
  if (isLoading || !d) return <LoadingRows rows={8} />;

  const canEdit = can('content.edit');
  const posts: any[] = d.posts;

  const generateAll = async () => {
    const v = await confirm({
      title: `Make ${posts.length} image${posts.length === 1 ? '' : 's'} in Canva?`,
      body: 'Each post gets its matching template, filled with its title, caption and date. The images are saved as not approved.',
      confirmLabel: 'Make images',
      tone: 'primary',
    });
    if (v === null) return;
    const r = await run('all', () => api.post<any>('/canva/generate-all'), (r) => `Making ${r.job.total} image${r.job.total === 1 ? '' : 's'}…`);
    if (r) { setWatching(true); refetch(); }
  };

  const setAutomatic = async (on: boolean) => {
    if (on) {
      const v = await confirm({
        title: 'Make images automatically?',
        body: 'Every 30 minutes, new Facebook and Instagram posts in the next 14 days that have no image get one from their matching template. Images are saved as not approved.',
        confirmLabel: 'Turn on',
        tone: 'primary',
      });
      if (v === null) return;
      const t = d.default_template;
      await run('auto', () => api.put('/canva/automation', { enabled: true, confirm: 'canva', template_id: t.id, template_kind: t.kind, template_title: t.title }), 'Automatic images are on');
    } else {
      await run('auto', () => api.put('/canva/automation', { enabled: false }), 'Automatic images are off');
    }
    refetch();
  };

  return (
    <div className="stack" style={{ gap: 20 }}>
      {node}
      <div className="page-head">
        <div><h1>Graphics</h1><div className="sub">Make post images in Canva from your templates. Every image is saved as not approved until someone checks it.</div></div>
        <span className="spacer" />
        {canEdit && d.connected && (job?.running
          ? <Button icon={<Sparkles size={15} />} loading disabled>Making {job.done} of {job.total}…</Button>
          : <Button variant="primary" icon={<Sparkles size={15} />} loading={busy === 'all'} disabled={!posts.length} title={posts.length ? undefined : 'Every upcoming post has an image'} onClick={generateAll}>Make all{posts.length ? ` (${posts.length})` : ''}</Button>)}
      </div>

      {!d.connected && (
        <Callout tone="warning" title="Canva isn't connected">Connect it in <Link to="/settings">Settings → Connections</Link>, then come back here.</Callout>
      )}

      {d.connected && (
        <div className="grid grid-2">
          <Card title="Templates" bodyClass="">
            {d.templates.length === 0 ? <Empty title="No templates yet">In Canva, put “Template” in a design’s title and add data fields to its text.</Empty> : (
              <div className="list">
                {d.templates.map((t: any) => (
                  <div key={t.id} className="list-item" style={{ cursor: 'default' }}>
                    {t.thumbnail ? <img src={t.thumbnail} alt="" width={48} height={48} style={{ borderRadius: 6, objectFit: 'cover' }} referrerPolicy="no-referrer" /> : <ImageIcon size={20} color="var(--text-3)" />}
                    <span className="grow">
                      <div className="t">{t.title}</div>
                      <div className="small muted">{t.is_default ? 'Used for every post without a better match' : `Used for posts that mention “${t.keyword}”`}</div>
                    </span>
                    {t.view_url && <a className="btn ghost sm" href={t.view_url} target="_blank" rel="noreferrer">Open in Canva <ExternalLink size={12} /></a>}
                  </div>
                ))}
              </div>
            )}
          </Card>
          <Card title="Automatic" actions={d.automatic ? <Badge tone="success" dot>On</Badge> : <Badge dot>Off</Badge>}>
            <div className="stack">
              <div className="small">When on, the dashboard checks every 30 minutes and makes an image for new Facebook and Instagram posts in the next 14 days that don’t have one.</div>
              {can('connections.automation')
                ? <div><Button variant={d.automatic ? 'danger' : 'primary'} icon={<Wand2 size={15} />} loading={busy === 'auto'} disabled={!d.automatic && !d.default_template} onClick={() => setAutomatic(!d.automatic)}>{d.automatic ? 'Turn off' : 'Turn on'}</Button></div>
                : <div className="small muted">An administrator can turn this on or off.</div>}
            </div>
          </Card>
        </div>
      )}

      {d.connected && (
        <Card title={`Posts waiting for an image (${posts.length})`} bodyClass="">
          {posts.length === 0 ? <Empty icon={<Check size={28} />} title="Every upcoming post has an image" /> : (
            <div className="list">
              {posts.map((p) => (
                <div key={p.id} className="list-item" style={{ cursor: 'default' }}>
                  <span className="grow" style={{ minWidth: 0 }}>
                    <button className="t" style={{ all: 'unset', cursor: 'pointer', fontWeight: 500 }} onClick={() => openContent(p.id)}>{p.title}</button>
                    <div className="small muted">{p.scheduled_at ? fmtDateTime(p.scheduled_at) : 'No date yet'}{p.template ? ` · ${p.template}` : ''}</div>
                  </span>
                  {canEdit && <Button size="sm" icon={<Sparkles size={13} />} disabled={!!job?.running} loading={busy === `g-${p.id}`} onClick={async () => { await run(`g-${p.id}`, () => api.post<any>(`/content/${p.id}/canva/auto`), 'Image made. Check it under Recently made.'); refetch(); }}>Make image</Button>}
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      <Card title="Recently made" actions={d.brand_checks && can('content.edit') ? <Button size="sm" icon={<ShieldCheck size={14} />} loading={busy === 'bcr'} title="Check the logo on recent Canva images that have not been checked yet" onClick={async () => { await run('bcr', () => api.post<any>('/canva/brand-check-recent'), (r: any) => { const bad = r.results.filter((x: any) => x.status === 'fail').length; return r.checked ? `Checked ${r.checked} image${r.checked === 1 ? '' : 's'}${bad ? `: ${bad} with the wrong logo` : ''}` : 'Every recent image is already checked'; }); refetch(); }}>Check logos</Button> : undefined}>
        {d.recent.length === 0 ? <Empty icon={<ImageIcon size={28} />} title="No Canva images yet" /> : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 14 }}>
            {d.recent.map((a: any) => (
              <figure key={a.id} className="card" style={{ margin: 0, overflow: 'hidden' }}>
                <button onClick={() => openContent(a.content_id)} style={{ all: 'unset', cursor: 'pointer', display: 'block' }} aria-label={`Open ${a.title}`}>
                  <img src={`/api/assets/${a.id}/file`} alt={a.title} loading="lazy" style={{ width: '100%', aspectRatio: '1 / 1', objectFit: 'cover', display: 'block', background: 'var(--surface-2)' }} />
                </button>
                <figcaption className="stack-sm" style={{ padding: 10, gap: 6 }}>
                  <div className="small" style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={a.title}>{a.title}</div>
                  <div className="row-wrap" style={{ gap: 6 }}>
                    {a.approved ? <Badge tone="success">Approved</Badge> : <Badge tone="warning">Not approved</Badge>}
                    <BrandBadge check={a.brand_check} />
                    <span className="small muted">{fmtRelative(a.created_at)}</span>
                  </div>
                  <div className="row-wrap" style={{ gap: 6 }}>
                    {!a.approved && a.brand_check?.status === 'fail' && <Button size="sm" variant="primary" loading={busy === `fx-${a.id}`} onClick={async () => { await run(`fx-${a.id}`, () => api.post<any>(`/assets/${a.id}/fix-logo`), 'Logo fixed. New image attached, not approved yet.'); refetch(); }}>Fix logo</Button>}
                    {!a.approved && a.brand_check?.status !== 'fail' && can('content.approve') && <Button size="sm" variant="success" icon={<Check size={13} />} loading={busy === `ap-${a.id}`} onClick={async () => { await run(`ap-${a.id}`, () => api.patch(`/assets/${a.id}`, { approved: true }), 'Image approved'); refetch(); }}>Approve</Button>}
                    <a className="btn ghost sm" href={a.url} target="_blank" rel="noreferrer" title="Edit this design in Canva">Canva <ExternalLink size={11} /></a>
                  </div>
                </figcaption>
              </figure>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
