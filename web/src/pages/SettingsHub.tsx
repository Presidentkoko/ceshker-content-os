import { lazy } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useSession } from '../lib/session';

const Connections = lazy(() => import('./Connections'));
const SettingsPage = lazy(() => import('./Settings'));
const ActivityPage = lazy(() => import('./Activity'));

/** Everything that is set up once lives here: connections, team and preferences, and the log. */
export default function SettingsHub() {
  const [sp, setSp] = useSearchParams();
  const { can } = useSession();
  const tabs = [
    ['connections', 'Connections'],
    ['team', 'Team & preferences'],
    ...(can('audit.view') ? [['log', 'Activity log']] : []),
  ] as const;
  const tab = tabs.some(([k]) => k === sp.get('tab')) ? sp.get('tab')! : 'connections';

  return (
    <div className="stack">
      <div className="page-head">
        <div><h1>Settings</h1><div className="sub">Connections, team and the activity log. Secrets live in Railway and are never shown here.</div></div>
      </div>
      <div className="tabs" role="tablist" style={{ marginTop: -8 }}>
        {tabs.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setSp(k === 'connections' ? {} : { tab: k }, { replace: true })}>{l}</button>
        ))}
      </div>
      {tab === 'connections' && <Connections embedded />}
      {tab === 'team' && <SettingsPage embedded />}
      {tab === 'log' && <ActivityPage embedded />}
    </div>
  );
}
