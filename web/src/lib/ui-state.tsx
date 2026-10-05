import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

type Toast = { id: number; kind: 'success' | 'error' | 'info'; title: string; body?: string };
type Theme = 'light' | 'dark' | 'command';

interface UiCtx {
  toast: (kind: Toast['kind'], title: string, body?: string) => void;
  toasts: Toast[];
  dismiss: (id: number) => void;
  theme: Theme;
  setTheme: (t: Theme) => void;
  /** The record open in the global detail drawer, if any. */
  openContent: (id: string) => void;
  openVideo: (id: string) => void;
  drawer: { kind: 'content' | 'video'; id: string } | null;
  closeDrawer: () => void;
}

const Ctx = createContext<UiCtx | null>(null);
let seq = 1;

function readTheme(): Theme {
  const t = document.documentElement.dataset.theme;
  return t === 'dark' || t === 'command' ? t : 'light';
}

export function UiProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [theme, setThemeState] = useState<Theme>(readTheme);
  const [drawer, setDrawer] = useState<UiCtx['drawer']>(() => {
    const p = new URLSearchParams(location.search);
    if (p.get('content')) return { kind: 'content', id: p.get('content')! };
    if (p.get('video')) return { kind: 'video', id: p.get('video')! };
    return null;
  });

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const toast = useCallback(
    (kind: Toast['kind'], title: string, body?: string) => {
      const id = seq++;
      setToasts((t) => [...t.slice(-3), { id, kind, title, body }]);
      setTimeout(() => dismiss(id), kind === 'error' ? 9000 : 4500);
    },
    [dismiss],
  );
  const setTheme = (t: Theme) => {
    document.documentElement.dataset.theme = t;
    try {
      localStorage.setItem('cos-theme-v2', t);
    } catch {}
    setThemeState(t);
  };

  // Keep the open record in the URL so a drawer can be linked and survives reloads.
  useEffect(() => {
    const u = new URL(location.href);
    u.searchParams.delete('content');
    u.searchParams.delete('video');
    if (drawer) u.searchParams.set(drawer.kind, drawer.id);
    history.replaceState(history.state, '', u);
  }, [drawer]);

  return (
    <Ctx.Provider
      value={{
        toast, toasts, dismiss, theme, setTheme, drawer,
        openContent: (id) => setDrawer({ kind: 'content', id }),
        openVideo: (id) => setDrawer({ kind: 'video', id }),
        closeDrawer: () => setDrawer(null),
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useUi() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useUi outside provider');
  return c;
}
