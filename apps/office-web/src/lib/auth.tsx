import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, get, getSession, onSessionChange, post, setSession } from './api';

export interface MyPosition {
  positionId: string;
  title: string;
  unitId: string;
  unitName: string;
  isManager: boolean;
  isPrimary: boolean;
}

export interface Me {
  id: string;
  username: string;
  full_name: string;
  email: string | null;
  mobile: string | null;
  national_id: string | null;
  clearance: number;
  mfa_enabled: boolean;
  has_signature: boolean;
  mfaRequired: boolean;
  roles: string[];
  permissions: string[];
  positions: MyPosition[];
}

interface AuthState {
  me: Me | null;
  loading: boolean;
  login: (identifier: string, password: string) => Promise<{ mfaToken?: string }>;
  verifyMfa: (mfaToken: string, code: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshMe: () => Promise<void>;
  can: (perm: string) => boolean;
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

  const can = (perm: string) => !!me?.permissions.includes(perm);

  return <Ctx.Provider value={{ me, loading, login, verifyMfa, logout, refreshMe, can }}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error('AuthProvider missing');
  return c;
}
