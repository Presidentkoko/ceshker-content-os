import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { api, qs } from '../lib/api';
import { useUi } from '../lib/ui-state';
import { fmtDateTime } from '../lib/format';
import { Badge, Card, Empty, ErrorState, LoadingRows, Modal, Pager } from '../components/ui';

export default function ActivityPage({ embedded = false }: { embedded?: boolean }) {
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('tab') ?? 'errors';
  return (
    <div>
      {!embedded && <div className="page-head">
        <div><h1>Activity and Errors</h1><div className="sub">Workflow runs, failures and the audit trail of every important change.</div></div>
      </div>}
      <Card bodyClass="">
        <div className="tabs" role="tablist" style={{ padding: '0 16px' }}>
          {[['errors', 'Errors'], ['runs', 'Workflow runs'], ['audit', 'Audit log']].map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setSp({ tab: k })}>{l}</button>)}
        </div>
        {tab === 'audit' ? <Audit /> : <Runs failedOnly={tab === 'errors'} />}
      </Card>
    </div>
  );
}

function Runs({ failedOnly }: { failedOnly: boolean }) {
  const { openContent } = useUi();
  const [sel, setSel] = useState<string | null>(null);
  const { data, error, isLoading, refetch } = useQuery({ queryKey: ['runs', failedOnly], queryFn: () => api.get<any[]>(`/runs${failedOnly ? '?status=failed' : ''}`) });
  if (error) return <ErrorState error={error} retry={refetch} />;
  if (isLoading) return <LoadingRows />;
  if (!data?.length) return <Empty title={failedOnly ? 'No errors recorded' : 'No workflow runs yet'} />;
  return (
    <>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Started</th><th>Kind</th><th>Status</th><th>Record</th><th className="hide-mobile">Execution ID</th><th>Detail</th></tr></thead>
          <tbody>
            {data.map((r) => (
              <tr key={r.id} onClick={() => setSel(r.id)}>
                <td className="nowrap small">{fmtDateTime(r.started_at)}</td>
                <td>{r.kind.replace('_', ' ')}</td>
                <td><Badge tone={r.status === 'succeeded' ? 'success' : r.status === 'failed' ? 'danger' : 'info'}>{r.status}</Badge></td>
                <td>{r.ref ? <a href="#" onClick={(e) => { e.preventDefault(); e.stopPropagation(); openContent(r.content_id); }}>{r.ref}</a> : <span className="muted">—</span>}</td>
                <td className="mono hide-mobile">{r.execution_id ?? r.id.slice(0, 8)}</td>
                <td className="small" style={{ maxWidth: 380, color: r.error ? 'var(--danger)' : undefined }}>{r.error ?? r.summary}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sel && <RunModal id={sel} onClose={() => setSel(null)} />}
    </>
  );
}

function RunModal({ id, onClose }: { id: string; onClose: () => void }) {
  const { data } = useQuery({ queryKey: ['run', id], queryFn: () => api.get<any>(`/runs/${id}`) });
  return (
    <Modal wide title="Workflow run" onClose={onClose}>
      {!data ? <LoadingRows /> : (
        <div className="stack">
          <dl className="kv">
            <dt>Kind</dt><dd>{data.kind}</dd>
            <dt>Status</dt><dd>{data.status}</dd>
            <dt>Run ID</dt><dd className="mono">{data.id}</dd>
            <dt>n8n execution</dt><dd className="mono">{data.execution_id ?? '—'}</dd>
            <dt>Started / finished</dt><dd>{fmtDateTime(data.started_at)} → {fmtDateTime(data.finished_at)}</dd>
            {data.error && (<><dt>Error</dt><dd style={{ color: 'var(--danger)' }}>{data.error}</dd></>)}
          </dl>
          {data.request && <><span className="field-label">Request</span><pre className="pre">{JSON.stringify(data.request, null, 2)}</pre></>}
          {data.response && <><span className="field-label">Response</span><pre className="pre">{JSON.stringify(data.response, null, 2)}</pre></>}
        </div>
      )}
    </Modal>
  );
}

function Audit() {
  const [q, setQ] = useState('');
  const [result, setResult] = useState('');
  const [page, setPage] = useState(1);
  const { openContent } = useUi();
  const { data, error, isLoading, refetch } = useQuery({
    queryKey: ['audit', q, result, page],
    queryFn: () => api.get<any>(`/activity${qs({ q, result, page })}`),
    placeholderData: keepPreviousData,
  });
  const show = (v: any) => (v == null ? '' : JSON.stringify(v).slice(0, 160));
  return (
    <>
      <div className="filters">
        <div className="search" style={{ maxWidth: 320 }}><Search size={16} /><input type="search" aria-label="Search audit log" placeholder="Action, user, ref, execution…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} /></div>
        <select className="select sm" aria-label="Result" value={result} onChange={(e) => { setResult(e.target.value); setPage(1); }} style={{ width: 'auto' }}>
          <option value="">All results</option><option value="success">Success</option><option value="failure">Failure</option><option value="denied">Denied</option>
        </select>
      </div>
      {error ? <ErrorState error={error} retry={refetch} /> : isLoading ? <LoadingRows /> : !data.items.length ? <Empty title="No audit entries" /> : (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>When</th><th>User</th><th>Action</th><th>Content</th><th className="hide-mobile">Previous</th><th className="hide-mobile">New</th><th className="hide-mobile">Execution</th><th>Result</th></tr></thead>
              <tbody>
                {data.items.map((a: any) => (
                  <tr key={a.id} className={a.entity_type === 'content' && a.entity_id ? '' : 'static'} onClick={() => a.entity_type === 'content' && a.entity_id && openContent(a.entity_id)}>
                    <td className="nowrap small">{fmtDateTime(a.created_at)}</td>
                    <td className="small">{a.actor_email}</td>
                    <td className="small">{a.action}{a.detail && <div className="muted">{a.detail}</div>}</td>
                    <td className="mono">{a.content_ref ?? '—'}</td>
                    <td className="hide-mobile small mono" style={{ maxWidth: 220, overflowWrap: 'anywhere' }}>{show(a.previous)}</td>
                    <td className="hide-mobile small mono" style={{ maxWidth: 220, overflowWrap: 'anywhere' }}>{show(a.next)}</td>
                    <td className="hide-mobile mono">{a.execution_id?.slice(0, 12) ?? '—'}</td>
                    <td><Badge tone={a.result === 'success' ? 'success' : 'danger'}>{a.result}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
        </>
      )}
    </>
  );
}
