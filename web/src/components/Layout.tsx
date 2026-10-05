import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Bell, ChevronsLeft, ChevronsRight, Home, LogOut, Menu, Moon, Newspaper, Search, Settings, Sparkles, Sun, Video } from 'lucide-react';
import { api } from '../lib/api';
import { useBrand, useMeta } from '../lib/hooks';
import { useSession } from '../lib/session';
import { useUi } from '../lib/ui-state';
import { ROLE_LABELS } from '../../../shared/domain';
import { fmtRelative, initials } from '../lib/format';
import { Button } from './ui';

const NAV = [
  { to: '/', label: 'Home', icon: Home, end: true },
  { to: '/posts', label: 'Posts', icon: Newspaper, count: 'pending' },
  { to: '/graphics', label: 'Graphics', icon: Sparkles, needs: 'canva' },
  { to: '/videos', label: 'Videos', icon: Video },
  { to: '/settings', label: 'Settings', icon: Settings },
] as const;
export function Layout({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem('cos-nav') === 'collapsed';
    } catch {
      return false;
    }
  });
  const [mobileOpen, setMobileOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => setMobileOpen(false), [loc.pathname]);
  const toggle = () => {
    setCollapsed((c) => {
      try {
        localStorage.setItem('cos-nav', c ? 'open' : 'collapsed');
      } catch {}
      return !c;
    });
  };
  const { data: brand } = useBrand();
  const { data: meta } = useMeta();
  // Graphics only makes sense once Canva is set up; until then it is one less thing on screen.
  const nav = NAV.filter((n) => !('needs' in n) || n.needs !== 'canva' || meta?.canva_configured !== false);
  const { data: ov } = useQuery({ queryKey: ['overview'], queryFn: () => api.get<any>('/overview'), refetchInterval: 60_000 });
  const counts: Record<string, number> = { pending: ov?.kpis.awaiting_approval ?? 0 };

  return (
    <div className={`shell ${collapsed ? 'collapsed' : ''} ${mobileOpen ? 'mobile-open' : ''}`}>
      <div className="scrim" onClick={() => setMobileOpen(false)} />
      <aside className="sidebar" aria-label="Main navigation">
        <div className="brand">
          <div className="brand-mark">{brand?.mark ?? 'CO'}</div>
          <div className="brand-text">
            <strong>{brand?.videoBrand ?? 'Content OS'}</strong>
            <span>Command center</span>
          </div>
        </div>
        <nav className="nav">
          {nav.map((n) => (
              <NavLink key={n.to} to={n.to} end={'end' in n} title={collapsed ? n.label : undefined}>
                <n.icon size={18} />
                <span className="label">{n.label}</span>
                {'count' in n && counts[n.count] > 0 && <span className="count">{counts[n.count]}</span>}
              </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot hide-mobile">
          <Button variant="ghost" size="sm" onClick={toggle} icon={collapsed ? <ChevronsRight size={16} /> : <ChevronsLeft size={16} />} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} style={{ width: '100%' }}>
            {!collapsed && 'Collapse'}
          </Button>
        </div>
      </aside>
      <div className="main">
        <Topbar onMenu={() => setMobileOpen(true)} />
        <main className="content" id="main">{children}</main>
      </div>
    </div>
  );
}

function Topbar({ onMenu }: { onMenu: () => void }) {
  const { user, signOut } = useSession();
  const { theme, setTheme, openContent } = useUi();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [openMenu, setOpenMenu] = useState<'notif' | 'user' | 'search' | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !(e.target as HTMLElement).closest('input,textarea,select'))) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', f);
    return () => window.removeEventListener('keydown', f);
  }, []);
  useEffect(() => {
    const close = (e: MouseEvent) => !(e.target as HTMLElement).closest('.menu-anchor') && setOpenMenu(null);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const { data: notes } = useQuery({ queryKey: ['notifications'], queryFn: () => api.get<any[]>('/notifications'), refetchInterval: 60_000 });
  const { data: results } = useQuery({
    queryKey: ['search', q],
    queryFn: () => api.get<any>(`/content?q=${encodeURIComponent(q)}&page_size=8&archived=include`),
    enabled: q.trim().length >= 2,
  });

  return (
    <header className="topbar">
      <Button variant="ghost" iconOnly className="show-mobile" aria-label="Open navigation" onClick={onMenu} icon={<Menu size={18} />} />
      <div className="search menu-anchor" style={{ position: 'relative' }}>
        <Search size={16} />
        <input
          ref={searchRef}
          type="search"
          placeholder="Search titles, captions, notes, refs…"
          aria-label="Search the content library"
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpenMenu('search'); }}
          onFocus={() => setOpenMenu('search')}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && q.trim()) {
              nav(`/posts?show=all&q=${encodeURIComponent(q.trim())}`);
              setOpenMenu(null);
            }
          }}
        />
        <kbd className="hide-mobile">/</kbd>
        {openMenu === 'search' && q.trim().length >= 2 && (
          <div className="dropdown" style={{ left: 0, right: 'auto', width: '100%' }}>
            {results?.items?.length ? (
              results.items.map((r: any) => (
                <button key={r.id} className="menu-item" onClick={() => { openContent(r.id); setOpenMenu(null); }}>
                  <span className="mono muted">{r.ref}</span>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</span>
                </button>
              ))
            ) : (
              <div className="menu-item muted">No matches</div>
            )}
            <div className="divider" />
            <button className="menu-item" onClick={() => { nav(`/posts?show=all&q=${encodeURIComponent(q.trim())}`); setOpenMenu(null); }}>
              <Search size={14} /> See all matching posts
            </button>
          </div>
        )}
      </div>
      <StatusPill />
      <span className="spacer" />
      <Clock />
      <span className="spacer" />
      <div className="menu-anchor" style={{ position: 'relative' }}>
        <Button variant="ghost" iconOnly aria-label={`Notifications (${notes?.length ?? 0})`} onClick={() => setOpenMenu(openMenu === 'notif' ? null : 'notif')} icon={
          <span style={{ position: 'relative', display: 'inline-flex' }}>
            <Bell size={18} />
            {!!notes?.length && <span style={{ position: 'absolute', top: -4, right: -6, background: 'var(--danger)', color: '#fff', borderRadius: 999, fontSize: 10, padding: '0 4px', fontWeight: 700 }}>{notes.length}</span>}
          </span>
        } />
        {openMenu === 'notif' && (
          <div className="dropdown" style={{ width: 360 }}>
            <div style={{ padding: '10px 12px', fontWeight: 600 }}>Notifications</div>
            <div className="divider" />
            {notes?.length ? (
              notes.map((n, i) => (
                <button key={i} className="menu-item" style={{ alignItems: 'flex-start' }} onClick={() => { if (n.content_id) openContent(n.content_id); else nav('/settings'); setOpenMenu(null); }}>
                  <span className={`health-dot ${n.kind === 'approval' ? 'warn' : 'bad'}`} style={{ marginTop: 6 }} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 500 }}>{n.title}</div>
                    <div className="small muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.body}</div>
                    <div className="small muted">{fmtRelative(n.at)}</div>
                  </span>
                </button>
              ))
            ) : (
              <div className="menu-item muted">You're all caught up.</div>
            )}
          </div>
        )}
      </div>
      <Button variant="ghost" iconOnly aria-label="Switch theme" title={`Theme: ${theme}. Click to switch.`} onClick={() => setTheme(theme === 'command' ? 'light' : theme === 'light' ? 'dark' : 'command')} icon={theme === 'light' ? <Moon size={18} /> : <Sun size={18} />} />
      <div className="menu-anchor" style={{ position: 'relative' }}>
        <button className="btn ghost" style={{ height: 40, gap: 8 }} onClick={() => setOpenMenu(openMenu === 'user' ? null : 'user')} aria-label="Account menu">
          <span className="avatar">{initials(user!.name)}</span>
          <span className="hide-mobile" style={{ textAlign: 'left', lineHeight: 1.2 }}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>{user!.name === ROLE_LABELS[user!.role] ? user!.email : user!.name}</div>
            <div className="small muted">{ROLE_LABELS[user!.role]}</div>
          </span>
        </button>
        {openMenu === 'user' && (
          <div className="dropdown">
            <div style={{ padding: '10px 12px' }}>
              <div style={{ fontWeight: 600 }}>{user!.name}</div>
              <div className="small muted">{user!.email}</div>
            </div>
            <div className="divider" />
            <button className="menu-item" onClick={() => { nav('/settings'); setOpenMenu(null); }}><Settings size={15} /> Settings</button>
            <button className="menu-item" onClick={() => signOut()}><LogOut size={15} /> Sign out</button>
          </div>
        )}
      </div>
    </header>
  );
}

/** Overall health, from the connections list: every configured channel connected means Optimal. */
function StatusPill() {
  const { data: conns } = useQuery({ queryKey: ['connections'], queryFn: () => api.get<any[]>('/connections'), refetchInterval: 120_000 });
  const bad = (conns ?? []).filter((c) => c.status === 'disconnected').length;
  const linked = (conns ?? []).filter((c) => c.status === 'connected').length;
  const ok = bad === 0;
  return (
    <span className={`status-pill ${ok ? '' : 'attention'}`} title={ok ? `${linked} connections live` : `${bad} connection(s) need attention`}>
      System status <b>● {ok ? 'Optimal' : 'Attention'}</b>
    </span>
  );
}

/** Live clock in the app time zone. */
function Clock() {
  const { data: meta } = useMeta();
  const [now, setNow] = useState(new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);
  const tz = meta?.timezone ?? 'America/Chicago';
  const d = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(now);
  const t = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }).format(now);
  return <div className="clock"><div className="d">{d}</div><div className="t">{t}</div></div>;
}
