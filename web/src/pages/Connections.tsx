import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useUi } from '../lib/ui-state';
import { PlugZap, RefreshCw, ShieldCheck } from 'lucide-react';
import { api } from '../lib/api';
import { useAction, useBrand } from '../lib/hooks';
import { useSession } from '../lib/session';
import { fmtRelative } from '../lib/format';
import { Badge, Button, Callout, Card, ErrorState, LoadingRows, useConfirm } from '../components/ui';

const STATUS_TONE: Record<string, string> = { connected: 'success', disconnected: 'danger', degraded: 'warning', not_configured: '', unknown: 'warning' };

function YoutubeConnect({ c }: { c: any }) {
  const { data: brand } = useBrand();
  const { can } = useSession();
  const { run, busy } = useAction();
  const { confirm, node } = useConfirm();
  const o = c.oauth;
  if (!o.configured) {
    return (
      <Callout tone="warning" title="One-time Google setup (about 5 minutes)">
        <ol style={{ margin: '4px 0 0', paddingLeft: 18 }}>
          <li>In Google Cloud Console, create a project and enable <strong>YouTube Data API v3</strong> and <strong>Google Drive API</strong>.</li>
          <li>OAuth consent screen: External, add the channel owner's Google account as a test user.</li>
          <li>Credentials → Create OAuth client ID → <em>Web application</em>, authorized redirect URI:<div className="mono" style={{ overflowWrap: 'anywhere', margin: '4px 0' }}>{o.redirect_uri}</div></li>
          <li>In Railway (content-os → Variables) add <span className="mono">GOOGLE_OAUTH_CLIENT_ID</span> and <span className="mono">GOOGLE_OAUTH_CLIENT_SECRET</span>. The service restarts.</li>
          <li>Come back here and click <strong>Connect YouTube</strong>.</li>
        </ol>
      </Callout>
    );
  }
  if (!o.connected) {
    return (
      <div className="stack-sm">
        <Callout tone="info">Sign in with the Google account that owns the channel. A YouTube Studio invite is not enough: Google only lets the owner, or a Brand Account manager, grant app access.</Callout>
        {can('connections.automation') ? <div><a className="btn primary" href="/api/oauth/google/start">Connect YouTube</a></div> : <div className="small muted">An administrator must connect YouTube.</div>}
        {can('connections.automation') && <ConnectLink invite={o.invite} />}
      </div>
    );
  }
  return (
    <div className="stack-sm">
      {node}
      <div className="stack-sm">
        <strong className="small">Connected channels</strong>
        {(o.channels ?? []).map((ch: any) => (
          <div key={ch.channel_id} className="row" style={{ gap: 8 }}>
            <span className="health-dot ok" />
            <span className="grow"><strong>{ch.title}</strong> <span className="small muted">· since {fmtRelative(ch.connected_at)}</span></span>
            {ch.is_primary ? <Badge tone="primary">Main channel · uploads go here</Badge> : <Badge>Stats only</Badge>}
            {!ch.is_primary && can('connections.automation') && (
              <Button size="sm" loading={busy === `main-${ch.channel_id}`} onClick={async () => {
                if ((await confirm({ title: `Make ${ch.title} the main channel?`, body: 'New uploads, the video library and playlists move to this channel. Videos already on the current main channel stay there untouched and keep their schedule; the library just stops treating them as its copies.', confirmLabel: 'Make main channel', tone: 'primary' })) !== null) run(`main-${ch.channel_id}`, () => api.post(`/youtube/channels/${ch.channel_id}/main`), `${ch.title} is now the main channel`);
              }}>Make main channel</Button>
            )}
            {can('connections.automation') && (
              <Button size="sm" variant="ghost" loading={busy === `ytd-${ch.channel_id}`} onClick={async () => {
                if ((await confirm({ title: `Disconnect ${ch.title}?`, body: 'The dashboard stops reading this channel and its Google access is revoked. Nothing on YouTube is changed.', confirmLabel: 'Disconnect', tone: 'danger-solid' })) !== null) run(`ytd-${ch.channel_id}`, () => api.del(`/oauth/google?channel=${encodeURIComponent(ch.channel_id)}`), `${ch.title} disconnected`);
              }}>Disconnect</Button>
            )}
          </div>
        ))}
        <div className="small muted">Tokens are encrypted and never shown.</div>
      </div>
      <div className="row-wrap">
        {can('sheet.sync') && <Button size="sm" loading={busy === 'yts'} onClick={() => run('yts', () => api.post<any>('/youtube/sync'), (r) => `Channel synced: ${r.channel_videos} videos (${r.linked} linked, ${r.created} added)`)}>Sync {brand?.videoBrand ?? ''} videos</Button>}
      </div>
      {can('connections.automation') && <ConnectLink invite={o.invite} title="Add another channel" />}
    </div>
  );
}

/** A one-time link the channel owner opens to approve access, with no dashboard login. */
function ConnectLink({ invite, title = 'Not the channel owner?' }: { invite: any; title?: string }) {
  const { run, busy } = useAction();
  const { toast } = useUi();
  const [link, setLink] = useState<{ url: string; expires_at: string } | null>(null);
  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast('success', 'Link copied', 'Send it to the channel owner.');
    } catch {
      toast('error', 'Could not copy', 'Select the link and copy it by hand.');
    }
  };
  return (
    <div className="stack-sm" style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
      <strong className="small">{title}</strong>
      <div className="small muted">Create a one-time link and send it to Alan (or whoever owns the channel). They open it, sign in with the owner’s Google account and click Allow. No dashboard login needed. The link works once and expires after 24 hours.</div>
      {link ? (
        <div className="stack-sm">
          <div className="row" style={{ gap: 8 }}>
            <input className="input mono" readOnly value={link.url} aria-label="Connect link" onFocus={(e) => e.currentTarget.select()} style={{ flex: 1, minWidth: 0 }} />
            <Button size="sm" variant="primary" onClick={() => copy(link.url)}>Copy</Button>
          </div>
          <div className="small muted">Expires {fmtRelative(link.expires_at)}. This is the only time the link is shown.</div>
        </div>
      ) : invite ? (
        <div className="small">A link from {invite.created_by} is active and {invite.opened_at ? <>was opened {fmtRelative(invite.opened_at)}</> : 'has not been opened yet'}; it expires {fmtRelative(invite.expires_at)}.{invite.result ? <span className="muted"> Last attempt: {invite.result}</span> : null}</div>
      ) : null}
      <div className="row-wrap">
        <Button size="sm" loading={busy === 'inv'} onClick={async () => { const r = await run('inv', () => api.post<{ url: string; expires_at: string }>('/oauth/google/invite'), 'Connect link created'); if (r) setLink(r); }}>
          {invite || link ? 'Create a new link' : 'Create connect link'}
        </Button>
        {(invite || link) && <Button size="sm" variant="ghost" loading={busy === 'invx'} onClick={async () => { const r = await run('invx', () => api.del('/oauth/google/invite'), 'Link revoked'); if (r) setLink(null); }}>Revoke</Button>}
      </div>
    </div>
  );
}

function CanvaConnect({ c }: { c: any }) {
  const { data: brand } = useBrand();
  const { can } = useSession();
  const { run, busy } = useAction();
  const { confirm, node } = useConfirm();
  const o = c.canva;
  if (!o.configured) {
    return (
      <Callout tone="warning" title="One-time Canva setup (about 5 minutes)">
        <ol style={{ margin: '4px 0 0', paddingLeft: 18 }}>
          <li>Signed in to Canva as a member of the {brand?.name ?? ''} team, open <strong>canva.com/developers/integrations</strong> → <strong>Create an integration</strong>. Name it <em>{brand?.name ?? ''} Content OS</em>.</li>
          <li><strong>Scopes</strong>: tick <span className="mono">profile:read, design:meta:read, design:content:read, design:content:write, brandtemplate:meta:read, brandtemplate:content:read</span>.</li>
          <li><strong>Authentication</strong> → add this redirect URL:<div className="mono" style={{ overflowWrap: 'anywhere', margin: '4px 0' }}>{o.redirect_uri}</div></li>
          <li><strong>Configuration</strong> → copy the Client ID and <em>Generate secret</em>. In Railway (content-os → Variables) add <span className="mono">CANVA_CLIENT_ID</span> and <span className="mono">CANVA_CLIENT_SECRET</span>. The service restarts.</li>
          <li>Come back here and click <strong>Connect Canva</strong>.</li>
        </ol>
      </Callout>
    );
  }
  if (!o.connected) {
    return (
      <div className="stack-sm">
        <Callout tone="info">Sign in with a Canva account on the {brand?.name ?? ''} team. Brand templates and autofill need Canva Pro, Teams or Enterprise.</Callout>
        {can('connections.automation') ? <div><a className="btn primary" href="/api/oauth/canva/start">Connect Canva</a></div> : <div className="small muted">An administrator must connect Canva.</div>}
      </div>
    );
  }
  return (
    <div className="stack-sm">
      {node}
      <Callout tone="success" title={`Connected: ${o.account}`}>Since {fmtRelative(o.connected_at)}. Tokens are encrypted and never shown.</Callout>
      {can('connections.automation') && (
        <div className="row-wrap">
          <Button size="sm" variant="danger" loading={busy === 'cvd'} onClick={async () => {
            if ((await confirm({ title: 'Disconnect Canva?', body: 'The auto-generate rule switches off and the dashboard’s Canva access is revoked. Designs and images already made are kept.', confirmLabel: 'Disconnect', tone: 'danger-solid' })) !== null) run('cvd', () => api.del('/oauth/canva'), 'Canva disconnected');
          }}>Disconnect Canva</Button>
        </div>
      )}
      <CanvaMcpBlock mcp={o.mcp ?? { connected: false }} />
    </div>
  );
}

/**
 * Canva only returns MCP sign-ins to loopback addresses, so the admin signs in in a new tab and
 * pastes the unreachable 127.0.0.1 address back here.
 */
function CanvaMcpConnectSteps() {
  const { run, busy } = useAction();
  const [started, setStarted] = useState(false);
  const [pasted, setPasted] = useState('');
  const ok = /^http:\/\/127\.0\.0\.1(:\d+)?\/.*[?&]code=/.test(pasted.trim());
  return (
    <div className="stack-sm">
      <ol className="small" style={{ margin: 0, paddingLeft: 18 }}>
        <li>Click <strong>Sign in to Canva</strong>. A new tab opens; sign in with the Ceshker Canva account and click <strong>Allow</strong>.</li>
        <li>The tab then shows "This site can't be reached" at an address starting with <span className="mono">http://127.0.0.1</span>. That is expected.</li>
        <li>Copy that whole address from the address bar, paste it below and click <strong>Finish connecting</strong>.</li>
      </ol>
      <div><a className="btn primary" href="/api/oauth/canva-mcp/start" target="_blank" rel="noreferrer" onClick={() => setStarted(true)}>Sign in to Canva</a></div>
      {started && (
        <div className="row-wrap" style={{ alignItems: 'flex-start' }}>
          <input className="input" style={{ flex: 1, minWidth: 260 }} value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="http://127.0.0.1:53682/content-os/canva-mcp/callback?code=…" aria-label="Pasted address" />
          <Button variant="primary" disabled={!ok} loading={busy === 'mcpc'} onClick={() => run('mcpc', () => api.post<any>('/oauth/canva-mcp/complete', { url: pasted.trim() }), 'Canva MCP connected. New Canva images are now brand-checked.')}>Finish connecting</Button>
        </div>
      )}
      {started && pasted && !ok && <span className="error small">Paste the full address that starts with http://127.0.0.1 and contains code=.</span>}
    </div>
  );
}

/** Canva MCP: checks every Canva image for the approved logo and can fix fake logos. */
function CanvaMcpBlock({ mcp }: { mcp: { connected: boolean; connected_by?: string; connected_at?: string } }) {
  const { can } = useSession();
  const { run, busy } = useAction();
  const { confirm, node } = useConfirm();
  return (
    <div className="stack-sm" style={{ borderTop: '1px solid var(--border)', paddingTop: 10, marginTop: 4 }}>
      {node}
      <div className="row-wrap"><strong>Canva MCP: brand checks</strong>{mcp.connected ? <Badge tone="success">Connected</Badge> : <Badge tone="warning">Not connected</Badge>}</div>
      <div className="small muted">
        Looks inside every Canva image the dashboard makes. An image with a logo that is not the approved Ceshker logo cannot be approved, and "Fix logo" swaps in the approved logo.
      </div>
      {mcp.connected ? (
        <>
          <div className="small">Connected by {mcp.connected_by} {mcp.connected_at ? fmtRelative(mcp.connected_at) : ''}.</div>
          {can('connections.automation') && (
            <div className="row-wrap">
              <Button size="sm" loading={busy === 'mcpt'} onClick={() => run('mcpt', () => api.post<any>('/canva/mcp/test'), 'Canva MCP is working')}>Test</Button>
              <Button size="sm" variant="danger" loading={busy === 'mcpd'} onClick={async () => {
                if ((await confirm({ title: 'Disconnect Canva MCP?', body: 'New Canva images will no longer be brand-checked. Existing checks are kept.', confirmLabel: 'Disconnect', tone: 'danger-solid' })) !== null) run('mcpd', () => api.del('/oauth/canva-mcp'), 'Canva MCP disconnected');
              }}>Disconnect Canva MCP</Button>
            </div>
          )}
        </>
      ) : can('connections.automation') ? (
        <CanvaMcpConnectSteps />
      ) : (
        <div className="small muted">An administrator must connect Canva MCP.</div>
      )}
    </div>
  );
}

function MetaPages({ c }: { c: any }) {
  const { can } = useSession();
  const { run, busy } = useAction();
  const { confirm, node } = useConfirm();
  const m = c.meta;
  if (!m.token_configured) {
    return (
      <Callout tone="warning" title="Connect the Meta Business portfolio (about 10 minutes)">
        <ol style={{ margin: '4px 0 0', paddingLeft: 18 }}>
          <li>At <strong>developers.facebook.com</strong> → My Apps → <strong>Create app</strong> → type <em>Business</em> (other/“Something else”), and select the business portfolio that owns the Facebook Page.</li>
          <li>In <strong>Business settings → Users → System users</strong>, add a system user with the <strong>Admin</strong> role.</li>
          <li>On that system user: <strong>Assign assets</strong> → the Facebook Pages (and Instagram account) → <em>Full control</em>. Then <strong>Add assets → Apps</strong> → your new app.</li>
          <li><strong>Generate token</strong> for the app, expiration <em>Never</em>, with: <span className="mono">pages_show_list, pages_read_engagement, pages_manage_posts, instagram_basic, instagram_content_publish, business_management</span>.</li>
          <li>In Railway (content-os → Variables) add <span className="mono">META_SYSTEM_USER_TOKEN</span> with that token. The service restarts; come back and click <strong>Load Pages</strong>.</li>
        </ol>
      </Callout>
    );
  }
  const toggle = async (p: any, enabled: boolean) => {
    const ok = await confirm({
      title: enabled ? `Allow publishing to ${p.name}?` : `Stop publishing to ${p.name}?`,
      body: `${enabled ? 'Approved posts may be sent to this Page' + (p.ig_username ? ` and @${p.ig_username}` : '') + '.' : 'Queued posts for this Page will wait.'} Facebook and Instagram automation switch off until an administrator enables them again.`,
      confirmLabel: enabled ? 'Enable Page' : 'Disable Page',
      tone: enabled ? 'primary' : 'danger-solid',
    });
    if (ok !== null) await run(`p-${p.page_id}`, () => api.patch(`/meta/pages/${p.page_id}`, { enabled }), enabled ? `${p.name} enabled` : `${p.name} disabled`);
  };
  return (
    <div className="stack-sm">
      {node}
      <div className="row"><strong className="small">Pages</strong><span className="spacer" />
        {can('connections.automation') && <Button size="sm" icon={<RefreshCw size={13} />} loading={busy === 'mp'} onClick={() => run('mp', () => api.post<any[]>('/meta/pages/sync'), (r) => `Loaded ${r.length} Page${r.length === 1 ? '' : 's'} from Meta`)}>Load Pages</Button>}
      </div>
      {!m.pages.length ? <div className="small muted">No Pages loaded yet. Click Load Pages.</div> : (
        <div className="table-wrap" style={{ border: '1px solid var(--border)', borderRadius: 8 }}>
          <table className="table">
            <thead><tr><th>Page</th><th>Instagram</th><th>Publishing</th><th>Default</th></tr></thead>
            <tbody>
              {m.pages.map((p: any) => (
                <tr key={p.page_id} className="static">
                  <td>{p.name}{!p.can_post && <div className="small" style={{ color: 'var(--danger)' }}>System user cannot post here</div>}</td>
                  <td className="small">{p.ig_username ? `@${p.ig_username}` : <span className="muted">none linked</span>}</td>
                  <td>{can('connections.automation') ? <Button size="sm" variant={p.enabled ? 'default' : 'primary'} disabled={!p.can_post} loading={busy === `p-${p.page_id}`} onClick={() => toggle(p, !p.enabled)}>{p.enabled ? 'Disable' : 'Enable'}</Button> : p.enabled ? 'Enabled' : 'Off'}</td>
                  <td>{p.is_default ? <Badge tone="primary">Default</Badge> : can('connections.automation') && p.can_post ? <Button size="sm" variant="ghost" loading={busy === `d-${p.page_id}`} onClick={() => run(`d-${p.page_id}`, () => api.patch(`/meta/pages/${p.page_id}`, { is_default: true }), `${p.name} is now the default Page`)}>Make default</Button> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="small muted">Posts use the default Page unless a different Page is chosen on the post. Each Page's linked Instagram account is used for Instagram destinations.</div>
    </div>
  );
}

// Services people act on get a full card; the infrastructure behind them is summarised in one line.
const MAIN = ['facebook', 'instagram', 'youtube', 'canva'];

function SystemLine({ items }: { items: any[] }) {
  const configured = items.filter((c) => c.status !== 'not_configured');
  const bad = configured.filter((c) => c.status === 'disconnected');
  return (
    <div className="card"><div className="card-body row-wrap small">
      <span className={`health-dot ${bad.length ? 'bad' : 'ok'}`} />
      <strong>System</strong>
      <span className="muted">{bad.length ? `Problem: ${bad.map((c) => `${c.label} (${c.last_error ?? 'disconnected'})`).join(', ')}` : `All OK: ${configured.map((c) => c.label).join(', ')}`}</span>
    </div></div>
  );
}

export default function Connections({ embedded = false }: { embedded?: boolean }) {
  const { data, error, isLoading, refetch } = useQuery({ queryKey: ['connections'], queryFn: () => api.get<any[]>('/connections') });
  const { can } = useSession();
  const { run, busy } = useAction();
  const { confirm, node } = useConfirm();
  const { toast } = useUi();
  const [sp, setSp] = useSearchParams();
  useEffect(() => {
    if (sp.get('youtube') === 'connected') toast('success', `YouTube connected${sp.get('channel') ? `: ${sp.get('channel')}` : ''}`, 'Run a safe test, then enable automation to let the dashboard manage the channel.');
    if (sp.get('youtube_error')) toast('error', 'YouTube connection failed', sp.get('youtube_error')!);
    if (sp.get('canva') === 'connected') toast('success', `Canva connected${sp.get('account') ? `: ${sp.get('account')}` : ''}`, 'Choose a brand template for auto-generated graphics.');
    if (sp.get('canva_error')) toast('error', 'Canva connection failed', sp.get('canva_error')!);
    if (sp.get('canva_mcp') === 'connected') toast('success', 'Canva MCP connected', 'New Canva images are now brand-checked.');
    if (sp.get('canva_mcp_error')) toast('error', 'Canva MCP connection failed', sp.get('canva_mcp_error')!);
    if (sp.get('youtube') || sp.get('youtube_error') || sp.get('canva') || sp.get('canva_error') || sp.get('canva_mcp') || sp.get('canva_mcp_error')) setSp({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = async (c: any, enabled: boolean) => {
    const v = await confirm({
      title: enabled ? `Enable ${c.label} automation?` : `Disable ${c.label} automation?`,
      body: enabled ? `Approved, validated posts queued for ${c.label} will publish automatically at their scheduled time.` : `Queued ${c.label} posts will stop publishing and wait; nothing already published is changed.`,
      confirmLabel: enabled ? 'Enable automation' : 'Disable automation',
      tone: enabled ? 'primary' : 'danger-solid',
      typeToConfirm: enabled ? c.key : undefined,
    });
    if (v === null) return;
    await run(`auto-${c.key}`, () => api.post(`/connections/${c.key}/automation`, { enabled, confirm: c.key }), enabled ? 'Automation enabled' : 'Automation disabled');
  };

  return (
    <div>
      {node}
      {!embedded && <div className="page-head">
        <div><h1>Connections</h1><div className="sub">Integration health. Credentials live in Railway variables and n8n; this page never shows secret values.</div></div>
      </div>}
      {error ? <ErrorState error={error} retry={refetch} /> : isLoading ? <LoadingRows /> : (
        <div className="stack">
        <SystemLine items={data!.filter((c) => !MAIN.includes(c.key))} />
        <div className="grid grid-2">
          {data!.filter((c) => MAIN.includes(c.key)).map((c) => (
            <Card key={c.key} title={<div className="row"><PlugZap size={16} /><h2>{c.label}</h2></div>} actions={<Badge tone={STATUS_TONE[c.status]} dot>{c.status.replace('_', ' ')}</Badge>}>
              <div className="stack">
                <div className="small muted">{c.purpose}</div>
                <dl className="kv">
                  <dt>Identity</dt><dd>{c.identity ?? <span className="muted">—</span>}</dd>
                  <dt>Last OK</dt><dd>{c.last_success_at ? fmtRelative(c.last_success_at) : <span className="muted">never</span>}</dd>
                  <dt>Last error</dt><dd>{c.last_error ? <span style={{ color: 'var(--danger)' }}>{c.last_error} <span className="muted">({fmtRelative(c.last_error_at)})</span></span> : <span className="muted">none</span>}</dd>
                  {c.automatable && <><dt>Automation</dt><dd>{c.automation_enabled ? <Badge tone="success">Enabled</Badge> : <Badge>Disabled</Badge>}</dd></>}
                </dl>
                {c.key === 'youtube' && c.oauth && <YoutubeConnect c={c} />}
                {c.key === 'facebook' && c.meta && <MetaPages c={c} />}
                {c.key === 'canva' && c.canva && <CanvaConnect c={c} />}
                {c.blocker && c.key !== 'youtube' && c.key !== 'canva' && !(c.key === 'facebook' && !c.meta?.token_configured) && <Callout tone="warning" title="Not configured">{c.blocker}<div style={{ marginTop: 4 }}>{c.setup}</div></Callout>}
                <div className="row-wrap">
                  {can('connections.test') && (
                    <Button size="sm" icon={<ShieldCheck size={14} />} loading={busy === `t-${c.key}`} disabled={!!c.blocker} onClick={() => run(`t-${c.key}`, () => api.post<any>(`/connections/${c.key}/test`), (r) => (r.ok ? `${c.label}: connection OK${r.detail ? ' · ' + r.detail : ''}` : `${c.label}: test failed`))}>
                      Safe test
                    </Button>
                  )}
                  {can('connections.test') && c.status === 'disconnected' && !c.blocker && (
                    <Button size="sm" variant="ghost" icon={<RefreshCw size={14} />} loading={busy === `t-${c.key}`} onClick={() => run(`t-${c.key}`, () => api.post(`/connections/${c.key}/test`), `${c.label} re-checked`)}>Reconnect</Button>
                  )}
                  {c.automatable && can('connections.automation') && (
                    c.automation_enabled
                      ? <Button size="sm" variant="danger" loading={busy === `auto-${c.key}`} onClick={() => toggle(c, false)}>Disable automation</Button>
                      : <Button size="sm" loading={busy === `auto-${c.key}`} disabled={!!c.blocker || c.status !== 'connected'} title={c.blocker ?? (c.status !== 'connected' ? 'Run a successful safe test first' : undefined)} onClick={() => toggle(c, true)}>Enable automation</Button>
                  )}
                </div>
                {!can('connections.test') && <div className="small muted">Only administrators can test or change connections.</div>}
              </div>
            </Card>
          ))}
        </div>
        </div>
      )}
    </div>
  );
}
