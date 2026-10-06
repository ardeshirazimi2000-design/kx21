import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, get, getSession, onSessionChange, post, setSession } from './api';

export interface Membership {
  id: string;
  commission_id: string;
  commission_name: string;
  chamber_id: string;
  chamber_name: string;
  position: string;
  has_vote: boolean;
}

export interface Me {
  id: string;
  full_name: string;
  email: string | null;
  mobile: string | null;
  organization: string | null;
  chamber_id: string | null;
  is_super_admin: boolean;
  mfa_enabled: boolean;
  adminChambers: string[];
  memberships: Membership[];
}

interface AuthState {
  me: Me | null;
  loading: boolean;
  login: (identifier: string, password: string) => Promise<{ mfaToken?: string }>;
  verifyMfa: (mfaToken: string, code: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshMe: () => Promise<void>;
  isAdmin: boolean;
  /** Chamber in focus for admin pages. */
  chamberId: string | null;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshMe = useCallback(async () => {
    if (!getSession()) {
      setMe(null);
      setLoading(false);
      return;
    }
    try {
      setMe(await get<Me>('/auth/me'));
    } catch {
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshMe();
    return onSessionChange((s) => {
      if (!s) setMe(null);
    });
  }, [refreshMe]);

  const login = async (identifier: string, password: string) => {
    const r = await post('/auth/login', { identifier, password, device: 'web' });
    if (r.mfaRequired) return { mfaToken: r.mfaToken as string };
    setSession(r);
    await refreshMe();
    return {};
  };

  const verifyMfa = async (mfaToken: string, code: string) => {
    setSession(await post('/auth/mfa/verify', { mfaToken, code, device: 'web' }));
    await refreshMe();
  };

  const logout = async () => {
    const s = getSession();
    await api('/auth/logout', { method: 'POST', json: { refreshToken: s?.refreshToken } }).catch(() => {});
    setSession(null);
    setMe(null);
  };

  const isAdmin = !!me && (me.is_super_admin || me.adminChambers.length > 0);
  const chamberId = me ? (me.adminChambers[0] ?? me.chamber_id ?? me.memberships[0]?.chamber_id ?? null) : null;

  return (
    <Ctx.Provider value={{ me, loading, login, verifyMfa, logout, refreshMe, isAdmin, chamberId }}>{children}</Ctx.Provider>
  );
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error('AuthProvider missing');
  return c;
}
