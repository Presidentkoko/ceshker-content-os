import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { api } from '../lib/api';
import { useAction } from '../lib/hooks';
import { useSession } from '../lib/session';
import { useUi } from '../lib/ui-state';
import { fmtRelative } from '../lib/format';
import { ROLE_LABELS, ROLES, type Role } from '../../../shared/domain';
import { PERMISSIONS } from '../../../shared/permissions';
import { Badge, Button, Callout, Card, LoadingRows, Modal, useConfirm } from '../components/ui';

export default function SettingsPage({ embedded = false }: { embedded?: boolean }) {
  const { can, user } = useSession();
  const { theme, setTheme } = useUi();
  const { data } = useQuery({ queryKey: ['settings'], queryFn: () => api.get<any>('/settings') });
  return (
    <div className="stack" style={{ gap: 16 }}>
      {!embedded && <div className="page-head"><div><h1>Settings</h1><div className="sub">Preferences, publishing defaults, users and roles.</div></div></div>}
      <div className="grid grid-2">
        <Card title="Your preferences">
          <div className="stack">
            <div className="row"><span>Appearance</span><span className="spacer" /><div className="seg">{(['command', 'dark', 'light'] as const).map((t) => <button key={t} className={theme === t ? 'on' : ''} onClick={() => setTheme(t)}>{t === 'command' ? 'Command center' : t[0].toUpperCase() + t.slice(1)}</button>)}</div></div>
            <div className="row"><span>Signed in as</span><span className="spacer" /><span className="small">{user!.email} · <Badge>{ROLE_LABELS[user!.role]}</Badge></span></div>
          </div>
        </Card>
        <Card title="Environment">
          {!data ? <LoadingRows rows={4} /> : (
            <dl className="kv">
              <dt>Time zone</dt><dd>{data.environment.timezone}</dd>
              <dt>Database schema</dt><dd className="mono">{data.environment.db_schema}</dd>
              <dt>Planning sheet</dt><dd>{data.environment.sheet_configured ? 'Configured' : 'Not configured'}</dd>
              
              <dt>Queue dispatcher</dt><dd>{data.environment.dispatcher_enabled ? 'Running' : 'Off'}</dd>
              <dt>Railway</dt><dd>{data.environment.railway_environment ?? 'Not on Railway'}{data.environment.commit ? ` · ${data.environment.commit}` : ''}</dd>
            </dl>
          )}
        </Card>
      </div>
      {data && <Defaults values={data.values} editable={can('settings.manage')} />}
      {can('users.manage') && <Users />}
      <Card title="Role permissions">
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Permission</th>{ROLES.map((r) => <th key={r}>{ROLE_LABELS[r]}</th>)}</tr></thead>
            <tbody>
              {Object.entries(PERMISSIONS).map(([p, roles]) => (
                <tr key={p} className="static"><td className="mono">{p}</td>{ROLES.map((r) => <td key={r}>{(roles as readonly Role[]).includes(r) ? '✓' : <span className="muted">—</span>}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function Defaults({ values, editable }: { values: Record<string, any>; editable: boolean }) {
  const init = () => ({ disclaimer: values.disclaimer ?? '', default_cta: values.default_cta ?? '', default_post_time: values.default_post_time ?? '10:00', brand_voice: values.brand_voice ?? '' });
  const [f, setF] = useState(init);
  useEffect(() => setF(init()), [values]);
  const { run, busy } = useAction();
  const { confirm, node } = useConfirm();
  return (
    <Card title="Publishing defaults" actions={editable && <Button size="sm" variant="primary" loading={busy === 's'} onClick={async () => { if ((await confirm({ title: 'Save publishing defaults?', body: 'These defaults apply to new content and are recorded in the audit log.', confirmLabel: 'Save' })) !== null) run('s', () => api.put('/settings', f), 'Settings saved'); }}>Save</Button>}>
      {node}
      <fieldset disabled={!editable} className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
        <div className="field"><label htmlFor="s-d">Legal / educational disclaimer</label><textarea id="s-d" className="textarea" rows={2} value={f.disclaimer} onChange={(e) => setF({ ...f, disclaimer: e.target.value })} /><span className="help">Texas attorney-advertising rules may require review of campaigns that market legal services; classify before launch.</span></div>
        <div className="field"><label htmlFor="s-v">Brand voice and posting rules</label><textarea id="s-v" className="textarea" rows={8} value={f.brand_voice} onChange={(e) => setF({ ...f, brand_voice: e.target.value })} /><span className="help">Reference for anyone writing captions. Keep it to what a writer needs: tone, never-use words, favorite phrases and the posting order.</span></div>
        <div className="grid grid-2">
          <div className="field"><label htmlFor="s-c">Default call to action</label><input id="s-c" className="input" value={f.default_cta} onChange={(e) => setF({ ...f, default_cta: e.target.value })} /></div>
          <div className="field"><label htmlFor="s-t">Default post time</label><input id="s-t" type="time" className="input" value={f.default_post_time} onChange={(e) => setF({ ...f, default_post_time: e.target.value })} /></div>
        </div>
      </fieldset>
    </Card>
  );
}

function Users() {
  const { data } = useQuery({ queryKey: ['users'], queryFn: () => api.get<any[]>('/users') });
  const { user } = useSession();
  const { run, busy } = useAction();
  const { confirm, node } = useConfirm();
  const [adding, setAdding] = useState(false);
  return (
    <Card title="Users" actions={<Button size="sm" icon={<Plus size={14} />} onClick={() => setAdding(true)}>Add user</Button>} bodyClass="">
      {node}
      {!data ? <LoadingRows /> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th className="hide-mobile">Last sign-in</th><th /></tr></thead>
            <tbody>
              {data.map((u) => (
                <tr key={u.id} className="static">
                  <td>{u.name}</td>
                  <td className="small">{u.email}</td>
                  <td>
                    <select className="select sm" aria-label={`Role for ${u.email}`} value={u.role} disabled={u.id === user!.id} onChange={async (e) => {
                      const role = e.target.value;
                      if ((await confirm({ title: 'Change role?', body: `${u.name} will become ${ROLE_LABELS[role as Role]}.`, confirmLabel: 'Change role' })) !== null) run(`r-${u.id}`, () => api.patch(`/users/${u.id}`, { role }), 'Role updated');
                    }} style={{ width: 'auto' }}>
                      {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                    </select>
                  </td>
                  <td>{u.active ? <Badge tone="success">Active</Badge> : <Badge tone="danger">Disabled</Badge>}</td>
                  <td className="hide-mobile small">{u.last_login_at ? fmtRelative(u.last_login_at) : 'never'}</td>
                  <td>{u.id !== user!.id && <Button size="sm" variant={u.active ? 'danger' : 'default'} loading={busy === `a-${u.id}`} onClick={async () => {
                    if ((await confirm({ title: u.active ? 'Disable user?' : 'Re-enable user?', body: u.active ? 'They are signed out immediately and cannot sign in.' : 'They can sign in again.', confirmLabel: u.active ? 'Disable' : 'Enable', tone: u.active ? 'danger-solid' : 'primary' })) !== null) run(`a-${u.id}`, () => api.patch(`/users/${u.id}`, { active: !u.active }), 'User updated');
                  }}>{u.active ? 'Disable' : 'Enable'}</Button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {adding && <AddUser onClose={() => setAdding(false)} />}
    </Card>
  );
}

function AddUser({ onClose }: { onClose: () => void }) {
  const [f, setF] = useState({ name: '', email: '', role: 'viewer', password: '' });
  const { run, busy } = useAction();
  const ok = f.name.trim() && /\S+@\S+\.\S+/.test(f.email) && f.password.length >= 10;
  return (
    <Modal title="Add user" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!ok} loading={busy === 'u'} onClick={async () => { const r = await run('u', () => api.post('/users', f), 'User created'); if (r) onClose(); }}>Create user</Button></>}>
      <div className="stack">
        <div className="field"><label htmlFor="u-n">Name</label><input id="u-n" className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
        <div className="field"><label htmlFor="u-e">Email</label><input id="u-e" type="email" className="input" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
        <div className="field"><label htmlFor="u-r">Role</label><select id="u-r" className="select" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}</select></div>
        <div className="field"><label htmlFor="u-p">Temporary password</label><input id="u-p" type="password" autoComplete="new-password" className="input" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /><span className="help">At least 10 characters. Share it privately; the user can be given a new one here at any time.</span></div>
        <Callout tone="info">Administrators manage integrations and users; content managers create and schedule; approvers decide; viewers are read-only.</Callout>
      </div>
    </Modal>
  );
}
