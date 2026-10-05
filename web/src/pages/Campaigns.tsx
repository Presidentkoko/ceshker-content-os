import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, Pencil, Plus } from 'lucide-react';
import { api } from '../lib/api';
import { useAction } from '../lib/hooks';
import { useSession } from '../lib/session';
import { Badge, Button, Callout, Card, Empty, ErrorState, LoadingRows, Modal, Progress } from '../components/ui';

export default function Campaigns() {
  const { data, error, isLoading, refetch } = useQuery({ queryKey: ['campaigns'], queryFn: () => api.get<any[]>('/campaigns') });
  const { can } = useSession();
  const nav = useNavigate();
  const [edit, setEdit] = useState<any | null>(null);
  return (
    <div>
      <div className="page-head">
        <div><h1>Campaigns and Lead Magnets</h1><div className="sub">Group content into programs and track the free resource each one promotes.</div></div>
        <span className="spacer" />
        {can('campaign.edit') && <Button variant="primary" icon={<Plus size={15} />} onClick={() => setEdit({})}>New campaign</Button>}
      </div>
      {error ? <ErrorState error={error} retry={refetch} /> : isLoading ? <LoadingRows /> : !data?.length ? <Empty title="No campaigns" /> : (
        <div className="grid grid-2">
          {data.map((c) => {
            const goal = c.target_count ?? 0;
            const done = c.videos > 0 ? c.videos_public : c.items_published;
            const of = goal || (c.videos > 0 ? c.videos : c.items);
            return (
              <Card key={c.id} title={<div className="row" style={{ minWidth: 0 }}><h2 style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</h2><Badge tone={c.status === 'active' ? 'success' : ''}>{c.status}</Badge></div>} actions={can('campaign.edit') && <Button size="sm" variant="ghost" iconOnly aria-label={`Edit ${c.name}`} icon={<Pencil size={14} />} onClick={() => setEdit(c)} />}>
                <div className="stack">
                  {c.description && <div className="small muted">{c.description}</div>}
                  <div>
                    <div className="row small"><span>{c.videos > 0 ? 'Videos public on YouTube' : 'Posts published'}</span><span className="spacer" /><strong>{done} / {of}</strong></div>
                    <Progress value={done} max={of} tone="success" />
                  </div>
                  <div className="row-wrap small">
                    <Badge>{c.items} posts</Badge>
                    {c.items_pending > 0 && <Badge tone="warning">{c.items_pending} awaiting approval</Badge>}
                    {c.videos > 0 && <Badge tone="info">{c.videos} videos</Badge>}
                  </div>
                  {c.lead_magnet_name && (
                    <Callout tone={c.lead_magnet_url ? 'success' : 'warning'} title={`Lead magnet: ${c.lead_magnet_name}`}>
                      {c.lead_magnet_url ? <a href={c.lead_magnet_url} target="_blank" rel="noreferrer">Landing page <ExternalLink size={11} /></a> : 'No landing page URL yet. Add it once the resource and sign-up page are live (e.g. the Skool join flow).'}
                      {c.cta_text && <div style={{ marginTop: 4 }}>CTA: “{c.cta_text}”</div>}
                    </Callout>
                  )}
                  <div><Button size="sm" onClick={() => nav(`/content?campaign_id=${c.id}`)}>View content</Button></div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
      {edit && <CampaignModal c={edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function CampaignModal({ c, onClose }: { c: any; onClose: () => void }) {
  const [f, setF] = useState({
    name: c.name ?? '', description: c.description ?? '', status: c.status ?? 'active', target_count: c.target_count ?? '',
    starts_on: c.starts_on ?? '', ends_on: c.ends_on ?? '', lead_magnet_name: c.lead_magnet_name ?? '', lead_magnet_url: c.lead_magnet_url ?? '', cta_text: c.cta_text ?? '',
  });
  const set = (k: string, v: string) => setF((x) => ({ ...x, [k]: v }));
  const { run, busy } = useAction();
  const save = async () => {
    const body = { ...f, target_count: f.target_count === '' ? null : Number(f.target_count) };
    const r = await run('s', () => (c.id ? api.patch(`/campaigns/${c.id}`, body) : api.post('/campaigns', body)), c.id ? 'Campaign saved' : 'Campaign created');
    if (r) onClose();
  };
  return (
    <Modal wide title={c.id ? 'Edit campaign' : 'New campaign'} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!f.name.trim()} loading={busy === 's'} onClick={save}>Save</Button></>}>
      <div className="stack">
        <div className="grid grid-2">
          <div className="field"><label htmlFor="c-n">Name</label><input id="c-n" className="input" value={f.name} onChange={(e) => set('name', e.target.value)} /></div>
          <div className="field"><label htmlFor="c-s">Status</label><select id="c-s" className="select" value={f.status} onChange={(e) => set('status', e.target.value)}>{['planned', 'active', 'paused', 'completed'].map((s) => <option key={s}>{s}</option>)}</select></div>
        </div>
        <div className="field"><label htmlFor="c-d">Description</label><textarea id="c-d" className="textarea" rows={3} value={f.description} onChange={(e) => set('description', e.target.value)} /></div>
        <div className="grid grid-3">
          <div className="field"><label htmlFor="c-t">Target count</label><input id="c-t" type="number" min={0} className="input" value={f.target_count} onChange={(e) => set('target_count', e.target.value)} /></div>
          <div className="field"><label htmlFor="c-a">Starts</label><input id="c-a" type="date" className="input" value={f.starts_on} onChange={(e) => set('starts_on', e.target.value)} /></div>
          <div className="field"><label htmlFor="c-b">Ends</label><input id="c-b" type="date" className="input" value={f.ends_on} onChange={(e) => set('ends_on', e.target.value)} /></div>
        </div>
        <div className="grid grid-2">
          <div className="field"><label htmlFor="c-lm">Lead magnet</label><input id="c-lm" className="input" value={f.lead_magnet_name} onChange={(e) => set('lead_magnet_name', e.target.value)} /></div>
          <div className="field"><label htmlFor="c-lu">Landing page URL</label><input id="c-lu" className="input" value={f.lead_magnet_url} onChange={(e) => set('lead_magnet_url', e.target.value)} placeholder="https://" /></div>
        </div>
        <div className="field"><label htmlFor="c-cta">Standard call to action</label><input id="c-cta" className="input" value={f.cta_text} onChange={(e) => set('cta_text', e.target.value)} /></div>
      </div>
    </Modal>
  );
}
