import { useBrand } from '../lib/hooks';
import { useState, type FormEvent } from 'react';
import { useSession } from '../lib/session';
import { errorText } from '../lib/api';
import { Button, Callout } from '../components/ui';

export function Login() {
  const { signIn } = useSession();
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await signIn(password);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const { data: brand } = useBrand();
  return (
    <div className="login-wrap">
      <div className="login-card stack">
        <div className="row" style={{ gap: 12 }}>
          <div className="brand-mark" style={{ width: 40, height: 40, fontSize: 15 }}>{brand?.mark ?? 'CO'}</div>
          <div>
            <h1 style={{ fontSize: 20 }}>{brand?.videoBrand ?? 'Content OS'} Command Center</h1>
            <div className="muted small">{brand ? `${brand.subtitle} content workflow` : 'Content workflow'}</div>
          </div>
        </div>
        <form className="card card-body stack" onSubmit={submit}>
          <div className="field">
            <label htmlFor="pw">Password</label>
            <input id="pw" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus />
          </div>
          {err && <Callout tone="danger">{err}</Callout>}
          <Button variant="primary" type="submit" loading={busy} style={{ width: '100%' }}>Sign in</Button>
        </form>
        <div className="small muted" style={{ textAlign: 'center' }}>Access is managed by your administrator.</div>
      </div>
    </div>
  );
}
