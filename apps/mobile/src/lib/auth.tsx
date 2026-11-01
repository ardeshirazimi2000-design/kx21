import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, get, getSession, loadSession, onSessionChange, post, setSession } from './api';
import { loadApiUrl } from './config';
import { registerForPush } from './push';

export interface Me {
  id: string;
  full_name: string;
  email: string | null;
  mobile: string | null;
  organization: string | null;
  is_super_admin: boolean;
  chamber_id: string | null;
  adminChambers: string[];
  memberships: { id: string; commission_id: string; commission_name: string; position: string; has_vote: boolean; chamber_id: string }[];
}

interface AuthState {
  me: Me | null;
  ready: boolean;
  login: (identifier: string, password: string, captcha?: { captchaId: string; captchaAnswer: string }) => Promise<{ mfaToken?: string }>;
  verifyMfa: (mfaToken: string, code: string) => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);

  const loadMe = useCallback(async () => {
    try {
      setMe(getSession() ? await get<Me>('/auth/me') : null);
    } catch {
      setMe(null);
    }
  }, []);

  useEffect(() => {
    void loadApiUrl()
      .then(loadSession)
      .then(loadMe)
      .finally(() => setReady(true));
    return onSessionChange((s) => {
      if (!s) setMe(null);
    });
  }, [loadMe]);

  useEffect(() => {
    if (me) void registerForPush();
  }, [me?.id]);

  const login = async (identifier: string, password: string, captcha?: { captchaId: string; captchaAnswer: string }) => {
    const r = await post('/auth/login', { identifier, password, device: 'mobile', ...captcha });
    if (r.mfaRequired) return { mfaToken: r.mfaToken as string };
    await setSession({ accessToken: r.accessToken, refreshToken: r.refreshToken });
    await loadMe();
    return {};
  };
  const verifyMfa = async (mfaToken: string, code: string) => {
    const r = await post('/auth/mfa/verify', { mfaToken, code, device: 'mobile' });
    await setSession({ accessToken: r.accessToken, refreshToken: r.refreshToken });
    await loadMe();
  };
  const logout = async () => {
    await api('/auth/logout', { method: 'POST', json: { refreshToken: getSession()?.refreshToken } }).catch(() => {});
    await setSession(null);
    setMe(null);
  };
  return <Ctx.Provider value={{ me, ready, login, verifyMfa, logout }}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error('AuthProvider missing');
  return c;
}
