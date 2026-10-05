import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CheckSquare } from 'lucide-react';
import { api, qs } from '../lib/api';
import { useUi } from '../lib/ui-state';
import { useSession } from '../lib/session';
import { fmtDateTime, fmtRelative } from '../lib/format';
import { PLATFORM_LABELS, type ContentItem } from '../../../shared/domain';
import { ApprovalBadge, Card, Empty, ErrorState, LoadingRows, Priority, ReadinessBadge } from '../components/ui';

const TABS = [
  { key: 'pending', label: 'Awaiting approval', filter: { approval_status: 'pending' } },
  { key: 'revision', label: 'Needs revision', filter: { approval_status: 'revision_requested' } },
  { key: 'rejected', label: 'Rejected', filter: { approval_status: 'rejected' } },
  { key: 'draft', label: 'Drafts', filter: { approval_status: 'draft' } },
];

export default function Approvals() {
  const [sp, setSp] = useSearchParams();
  const tab = TABS.find((t) => t.key === sp.get('tab')) ?? TABS[0];
  const { openContent } = useUi();
  const { can } = useSession();
  const { data, error, isLoading, refetch } = useQuery({
    queryKey: ['approvals', tab.key],
    queryFn: () => api.get<{ items: ContentItem[]; total: number }>(`/content${qs({ ...tab.filter, page_size: 200, sort: 'scheduled_at', dir: 'asc' })}`),
  });
  return (
    <div>
      <div className="page-head">
        <div><h1>Review and Approvals</h1><div className="sub">{can('content.approve') ? 'Open a record to review the caption, media, schedule and readiness, then approve, reject or request a revision.' : 'Your role can follow approvals; only approvers can decide.'}</div></div>
      </div>
      <Card bodyClass="">
        <div className="tabs" role="tablist" style={{ padding: '0 16px' }}>
          {TABS.map((t) => <button key={t.key} role="tab" aria-selected={tab.key === t.key} className={tab.key === t.key ? 'on' : ''} onClick={() => setSp({ tab: t.key })}>{t.label}</button>)}
        </div>
        {error ? <ErrorState error={error} retry={refetch} /> : isLoading ? <LoadingRows /> : !data!.items.length ? <Empty icon={<CheckSquare size={28} />} title="Nothing here" /> : (
          <div className="list">
            {data!.items.map((c) => (
              <button key={c.id} className="list-item" onClick={() => openContent(c.id)}>
                <Priority p={c.priority} />
                <span className="grow">
                  <div className="t">{c.title}</div>
                  <div className="small muted">{c.ref} · {c.category} · {[...new Set(c.targets.map((t) => PLATFORM_LABELS[t.platform]))].join(', ') || 'no destination'} · for {fmtDateTime(c.scheduled_at, c.timezone)} · updated {fmtRelative(c.updated_at)}</div>
                  {c.issues.filter((i) => i.severity === 'error' && i.code !== 'not_approved').length > 0 && (
                    <div className="small" style={{ color: 'var(--danger)' }}>{c.issues.filter((i) => i.severity === 'error' && i.code !== 'not_approved').map((i) => i.message).join(' ')}</div>
                  )}
                </span>
                <span className="row hide-mobile"><ReadinessBadge r={c.readiness} /><ApprovalBadge s={c.approval_status} /></span>
              </button>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
