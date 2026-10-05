import { useQuery } from '@tanstack/react-query';
import { Plus, Repeat2 } from 'lucide-react';
import { api } from '../lib/api';
import { useAction, useMeta } from '../lib/hooks';
import { useSession } from '../lib/session';
import { useUi } from '../lib/ui-state';
import { ApprovalBadge, Button, Card, Empty, ErrorState, LoadingRows, Progress } from '../components/ui';

const TYPE_FOR: Record<string, string> = { reel: 'reel', micro: 'short', carousel: 'carousel' };

export default function Repurposing() {
  const { data: videos, error, isLoading, refetch } = useQuery({ queryKey: ['videos', '', '', ''], queryFn: () => api.get<any[]>('/videos') });
  const { data: meta } = useMeta();
  const { can } = useSession();
  const { openContent, openVideo } = useUi();
  const { run, busy } = useAction();
  const derivs = meta?.derivatives ?? [];
  const total = (videos?.length ?? 0) * derivs.length;
  const done = (videos ?? []).reduce((n, v) => n + derivs.filter((d) => v.derivatives.some((x: any) => x.content_type === TYPE_FOR[d.kind])).length, 0);

  return (
    <div>
      <div className="page-head">
        <div><h1>Social Repurposing</h1><div className="sub">Each library video produces a vertical Reel/Short, a 10–20s micro-clip and a text post or carousel.</div></div>
      </div>
      <Card className="" bodyClass="card-body">
        <div className="row small"><span>Derivatives created</span><span className="spacer" /><strong>{done} / {total}</strong></div>
        <Progress value={done} max={total} />
        <div className="small muted" style={{ marginTop: 8 }}>Guidelines: 9:16, large burned-in captions, face visible immediately, a strong opening line in the first two seconds, small consistent ULTRA identifier, and the educational disclaimer.</div>
      </Card>
      <div style={{ height: 16 }} />
      <Card bodyClass="">
        {error ? <ErrorState error={error} retry={refetch} /> : isLoading ? <LoadingRows /> : !videos?.length ? <Empty icon={<Repeat2 size={28} />} title="No library videos yet" /> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Video</th>{derivs.map((d) => <th key={d.kind}>{d.label}</th>)}</tr></thead>
              <tbody>
                {videos.map((v) => (
                  <tr key={v.id} className="static">
                    <td className="title-cell"><a href="#" onClick={(e) => { e.preventDefault(); openVideo(v.id); }}>{v.series_no ? `#${v.series_no} · ` : ''}{v.public_title || v.title}</a></td>
                    {derivs.map((d) => {
                      const items = v.derivatives.filter((x: any) => x.content_type === TYPE_FOR[d.kind]);
                      return (
                        <td key={d.kind}>
                          {items.length ? (
                            <div className="row-wrap">{items.map((x: any) => <button key={x.id} className="btn sm" onClick={() => openContent(x.id)}><span className="mono">{x.ref}</span><ApprovalBadge s={x.approval_status} /></button>)}</div>
                          ) : can('content.edit') ? (
                            <Button size="sm" variant="ghost" icon={<Plus size={13} />} loading={busy === `${v.id}-${d.kind}`} onClick={async () => {
                              const r = await run(`${v.id}-${d.kind}`, () => api.post<any>(`/videos/${v.id}/derivatives`, { kind: d.kind }), (r) => `Created draft ${r.ref}`);
                              if (r) openContent(r.id);
                            }}>Create</Button>
                          ) : <span className="muted small">—</span>}
                        </td>
                      );
                    })}
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
