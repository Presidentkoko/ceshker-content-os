import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import type { SessionUser } from '../../../shared/domain';
import { can, type Permission } from '../../../shared/permissions';

interface SessionCtx {
  user: SessionUser | null;
  loading: boolean;
  signIn: (password: string) => Promise<void>;
  signOut: () => Promise<void>;
  can: (p: Permission) => boolean;
}

const Ctx = createContext<SessionCtx | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const qc = useQueryClient();

  useEffect(() => {
    api
      .get<{ user: SessionUser | null }>('/auth/me')
      .then((r) => setUser(r.user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
    const onUnauthorized = () => {
      setUser(null);
      qc.clear();
    };
    window.addEventListener('cos:unauthorized', onUnauthorized);
    return () => window.removeEventListener('cos:unauthorized', onUnauthorized);
  }, [qc]);

  const signIn = useCallback(async (password: string) => {
    const r = await api.post<{ user: SessionUser }>('/auth/login', { password });
    qc.clear();
    setUser(r.user);
  }, [qc]);
  const signOut = useCallback(async () => {
    await api.post('/auth/logout');
    qc.clear();
    setUser(null);
  }, [qc]);

  return (
    <Ctx.Provider value={{ user, loading, signIn, signOut, can: (p) => can(user?.role, p) }}>{children}</Ctx.Provider>
  );
}

export function useSession() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useSession outside provider');
  return c;
}
