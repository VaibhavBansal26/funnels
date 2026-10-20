import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, tokenStore, UNAUTHORIZED_EVENT } from '../api/client';
import type { AuthResponse, Session, TwoFactorChallenge } from '../api/types';

interface AuthState {
  session: Session | null;
  loading: boolean;
  /** Resolves with a challenge when two-factor authentication is on (finish with `verifyTwoFactor`), otherwise signs in and resolves null. */
  login(email: string, password: string): Promise<TwoFactorChallenge | null>;
  verifyTwoFactor(challengeToken: string, code: string): Promise<void>;
  register(input: { email: string; password: string; name: string; workspaceName?: string }): Promise<void>;
  /** Adopts a session returned by another flow (accepting an invitation). */
  adopt(r: AuthResponse): void;
  logout(): void;
  refresh(): Promise<void>;
  /** Switches this browser to a support session returned by the admin API (the administrator's own tokens are kept aside). */
  startSupport(token: string): Promise<void>;
  /** Ends the support session and returns to the administrator's own. */
  endSupport(): Promise<void>;
  /** Whether the signed-in user's role holds this permission (the server enforces it too; this only decides what to show). */
  can(permission: string): boolean;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState<boolean>(() => !!tokenStore.get());

  const logout = useCallback(() => {
    if (tokenStore.get()) void api.post('/api/auth/logout').catch(() => undefined); // ends the session on the server; the local state is cleared regardless
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
    tokenStore.set(r.token, r.refreshToken);
    setSession({ user: r.user, workspace: r.workspace });
    void refresh(); // the sign-in answer lacks what /me adds: administrator status, support access, suspension
  };

  const value = useMemo<AuthState>(
    () => ({
      session,
      loading,
      async login(email, password) {
        const r = await api.post<AuthResponse | TwoFactorChallenge>('/api/auth/login', { email, password }, { auth: false });
        if ('twoFactorRequired' in r) return r;
        accept(r);
        return null;
      },
      async verifyTwoFactor(challengeToken, code) {
        accept(await api.post<AuthResponse>('/api/auth/2fa/verify', { challengeToken, code }, { auth: false }));
      },
      adopt: accept,
      async register(input) {
        accept(await api.post<AuthResponse>('/api/auth/register', input, { auth: false }));
      },
      logout,
      refresh,
      async startSupport(token) {
        tokenStore.startSupport(token);
        qc.clear();
        await refresh();
      },
      async endSupport() {
        await api.post('/api/auth/logout').catch(() => undefined);
        const restored = tokenStore.endSupport();
        qc.clear();
        if (!restored) tokenStore.clear();
        await refresh();
      },
      can: (permission) => !!session && session.user.permissions.includes(permission),
    }),
    [session, loading, logout, refresh, qc],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside AuthProvider');
  return v;
}
