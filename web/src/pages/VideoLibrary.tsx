import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CloudDownload, ListPlus, Plus, Search, Video, Youtube } from 'lucide-react';
import { api, qs } from '../lib/api';
import { useAction, useBrand } from '../lib/hooks';
import { useSession } from '../lib/session';
import { useUi } from '../lib/ui-state';
import { fmtDate } from '../lib/format';
import { PLAYLISTS, YOUTUBE_LABELS, YOUTUBE_STATUSES, type YoutubeStatus } from '../../../shared/domain';
import { Badge, Button, Card, Empty, ErrorState, LoadingRows, Modal, Progress } from '../components/ui';

export default function VideoLibrary() {
  const [q, setQ] = useState('');
  const [playlist, setPlaylist] = useState('');
  const [status, setStatus] = useState('');
  const { can } = useSession();
  const { openVideo } = useUi();
  const { run, busy } = useAction();
  const [adding, setAdding] = useState(false);
  const { data, error, isLoading, refetch } = useQuery({ queryKey: ['videos', q, playlist, status], queryFn: () => api.get<any[]>(`/videos${qs({ q, playlist, youtube_status: status })}`) });
  const { data: conns } = useQuery({ queryKey: ['connections'], queryFn: () => api.get<any[]>('/connections') });
  const yt = conns?.find((c) => c.key === 'youtube');
  const total = data?.length ?? 0;
  const pub = data?.filter((v) => v.youtube_status === 'public').length ?? 0;
  const ready = data?.filter((v) => v.youtube_ready).length ?? 0;
  const { data: brand } = useBrand();

  return (
    <div>
      <div className="page-head">
        <div><h1>{brand?.libraryTitle ?? 'Video Library'}</h1><div className="sub">{brand?.libraryBlurb ?? ''}</div></div>
        <span className="spacer" />
        {can('sheet.sync') && (
          <Button icon={<CloudDownload size={15} />} loading={busy === 'drive'} onClick={() => run('drive', () => api.post<any>('/videos/sync-drive'), (r) => `Drive import: ${r.created} new, ${r.linked} linked, ${r.unchanged} unchanged`)}>
            Import from Drive
          </Button>
        )}
        {can('sheet.sync') && yt?.oauth?.connected && (
          <Button icon={<Youtube size={15} />} loading={busy === 'yts'} onClick={() => run('yts', () => api.post<any>('/youtube/sync'), (r) => `YouTube sync: ${r.channel_videos} channel videos, ${r.linked} linked, ${r.created} added`)}>
            Sync YouTube
          </Button>
        )}
        {can('video.edit') && yt?.oauth?.connected && (
          <Button icon={<ListPlus size={15} />} loading={busy === 'pl'} disabled={!yt.automation_enabled} title={yt.automation_enabled ? 'Create the six standard playlists on the channel' : 'Enable YouTube automation on Connections first'} onClick={() => run('pl', () => api.post<any>('/youtube/playlists'), (r) => r.created.length ? `Created playlists: ${r.created.join(', ')}` : 'All six playlists already exist')}>
            Create playlists
          </Button>
        )}
        {can('video.edit') && <Button variant="primary" icon={<Plus size={15} />} onClick={() => setAdding(true)}>Add video</Button>}
      </div>
      <div className="grid grid-3" style={{ marginBottom: 16 }}>
        <Card><div className="stack-sm"><span className="small muted">In library</span><strong style={{ fontSize: 22 }}>{total} <span className="small muted">/ 50</span></strong><Progress value={total} max={50} /></div></Card>
        <Card><div className="stack-sm"><span className="small muted">YouTube-ready</span><strong style={{ fontSize: 22 }}>{ready}</strong><Progress value={ready} max={Math.max(total, 1)} /></div></Card>
        <Card><div className="stack-sm"><span className="small muted">Public on YouTube</span><strong style={{ fontSize: 22 }}>{pub}</strong><Progress value={pub} max={50} tone="success" /></div></Card>
      </div>
      <Card bodyClass="">
        <div className="filters">
          <div className="search" style={{ maxWidth: 320 }}><Search size={16} /><input type="search" placeholder="Search videos…" aria-label="Search videos" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <select className="select sm" aria-label="Playlist" value={playlist} onChange={(e) => setPlaylist(e.target.value)} style={{ width: 'auto' }}><option value="">All playlists</option>{PLAYLISTS.map((p) => <option key={p}>{p}</option>)}</select>
          <select className="select sm" aria-label="YouTube status" value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 'auto' }}><option value="">Any status</option>{YOUTUBE_STATUSES.map((s) => <option key={s} value={s}>{YOUTUBE_LABELS[s]}</option>)}</select>
        </div>
        {error ? <ErrorState error={error} retry={refetch} /> : isLoading ? <LoadingRows /> : !data?.length ? <Empty icon={<Video size={28} />} title="No videos yet">Import from Drive or add a video.</Empty> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>#</th><th>Title</th><th className="hide-mobile">Playlist</th><th>YouTube</th><th>Readiness</th><th className="hide-mobile">Release</th></tr></thead>
              <tbody>
                {data.map((v) => (
                  <tr key={v.id} tabIndex={0} onClick={() => openVideo(v.id)} onKeyDown={(e) => e.key === 'Enter' && openVideo(v.id)}>
                    <td className="mono muted">{v.series_no ?? '—'}</td>
                    <td className="title-cell"><div>{v.public_title || v.title}</div>{v.public_title && <div className="small muted">{v.title}</div>}</td>
                    <td className="hide-mobile small">{v.playlist ?? <span className="muted">—</span>}</td>
                    <td><Badge tone={v.youtube_status === 'public' ? 'success' : v.youtube_status === 'not_uploaded' ? '' : 'info'}>{YOUTUBE_LABELS[v.youtube_status as YoutubeStatus]}</Badge></td>
                    <td title={v.missing.join(', ')}>{v.youtube_ready ? <Badge tone="success">Ready</Badge> : <Badge tone="warning">{v.missing.length === 1 ? `Needs ${v.missing[0].toLowerCase()}` : `Needs ${v.missing.length} things`}</Badge>}</td>
                    <td className="hide-mobile small nowrap">{v.release_at ? fmtDate(v.release_at) : <span className="muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {adding && <AddVideoModal onClose={() => setAdding(false)} />}
    </div>
  );
}

function AddVideoModal({ onClose }: { onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [drive, setDrive] = useState('');
  const [series, setSeries] = useState('');
  const [playlist, setPlaylist] = useState('');
  const { run, busy } = useAction();
  const { openVideo } = useUi();
  return (
    <Modal title="Add video" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!title.trim()} loading={busy === 'a'} onClick={async () => {
      const r = await run('a', () => api.post<any>('/videos', { title, drive_url: drive || null, series_no: series ? Number(series) : null, playlist: playlist || null }), 'Video added');
      if (r) { onClose(); openVideo(r.id); }
    }}>Add video</Button></>}>
      <div className="stack">
        <div className="field"><label htmlFor="av-t">Working title</label><input id="av-t" className="input" value={title} onChange={(e) => setTitle(e.target.value)} /></div>
        <div className="grid grid-2">
          <div className="field"><label htmlFor="av-s">Series #</label><input id="av-s" type="number" className="input" value={series} onChange={(e) => setSeries(e.target.value)} /></div>
          <div className="field"><label htmlFor="av-p">Playlist</label><select id="av-p" className="select" value={playlist} onChange={(e) => setPlaylist(e.target.value)}><option value="">Choose later</option>{PLAYLISTS.map((p) => <option key={p}>{p}</option>)}</select></div>
        </div>
        <div className="field"><label htmlFor="av-d">Final video (Drive link)</label><input id="av-d" className="input" value={drive} onChange={(e) => setDrive(e.target.value)} placeholder="https://drive.google.com/file/d/…" /></div>
      </div>
    </Modal>
  );
}
