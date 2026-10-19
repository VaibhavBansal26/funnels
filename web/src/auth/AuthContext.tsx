import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, tokenStore, UNAUTHORIZED_EVENT } from '../api/client';
import type { AuthResponse, Role, Session } from '../api/types';

interface AuthState {
  session: Session | null;
  loading: boolean;
  login(email: string, password: string): Promise<void>;
  register(input: { email: string; password: string; name: string; workspaceName?: string }): Promise<void>;
  logout(): void;
  refresh(): Promise<void>;
  can(min: Role): boolean;
}

const Ctx = createContext<AuthState | null>(null);
const RANK: Record<Role, number> = { member: 1, admin: 2, owner: 3 };

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState<boolean>(() => !!tokenStore.get());

  const logout = useCallback(() => {
    tokenStore.clear();
    setSession(null);
    qc.clear();
  }, [qc]);

  const refresh = useCallback(async () => {
    if (!tokenStore.get()) {
      setSession(null);
      setLoading(false);
      return;
    }
    try {
      setSession(await api.get<Session>('/api/auth/me'));
    } catch {
      tokenStore.clear();
      setSession(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    window.addEventListener(UNAUTHORIZED_EVENT, logout);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, logout);
  }, [logout]);

  const accept = (r: AuthResponse) => {
    tokenStore.set(r.token);
    setSession({ user: r.user, workspace: r.workspace });
  };

  const value = useMemo<AuthState>(
    () => ({
      session,
      loading,
      async login(email, password) {
        accept(await api.post<AuthResponse>('/api/auth/login', { email, password }, { auth: false }));
      },
      async register(input) {
        accept(await api.post<AuthResponse>('/api/auth/register', input, { auth: false }));
      },
      logout,
      refresh,
      can: (min) => !!session && RANK[session.user.role] >= RANK[min],
    }),
    [session, loading, logout, refresh],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside AuthProvider');
  return v;
}
