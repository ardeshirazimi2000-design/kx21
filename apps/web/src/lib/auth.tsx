import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, get, getSession, onSessionChange, post, setSession } from './api';

export interface Membership {
  id: string;
  commission_id: string;
  commission_name: string;
  chamber_id: string;
  chamber_name: string;
  position: string;
  role_title?: string | null;
  has_vote: boolean;
}

export interface Me {
  id: string;
  full_name: string;
  email: string | null;
  mobile: string | null;
  organization: string | null;
  chamber_id: string | null;
  /** The system's IT administrator (مدیر فناوری اطلاعات سامانه). */
  is_super_admin: boolean;
  mfa_enabled: boolean;
  /** Chambers whose processes the user runs (مدیر اتاق). */
  adminChambers: string[];
  /** Chambers whose logins and roles the user manages (مدیر فناوری اطلاعات اتاق). */
  itChambers: string[];
  /** Security auditor (ممیز امنیت) of every chamber, or of these. */
  auditAll: boolean;
  auditChambers: string[];
  /** Iran Chamber's secretariat (دبیرخانهٔ ملی). */
  isNational: boolean;
  memberships: Membership[];
  /** Optional server features (e.g. the built-in webinar). */
  features?: { webinar?: boolean };
}

interface AuthState {
  me: Me | null;
  loading: boolean;
  login: (identifier: string, password: string, captcha?: { captchaId: string; captchaAnswer: string }) => Promise<{ mfaToken?: string }>;
  verifyMfa: (mfaToken: string, code: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshMe: () => Promise<void>;
  /** Oversees a chamber's processes: its chamber admin, or the national secretariat. */
  isAdmin: boolean;
  /** Manages logins and roles: the system's IT administrator or a chamber's. */
  isItAdmin: boolean;
  /** Reads the audit log. */
  isAuditor: boolean;
  /** Chamber in focus for admin pages (selectable by super admins / multi-chamber admins). */
  chamberId: string | null;
  setChamberId: (id: string) => void;
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

  /** Keeps the tokens, and the previous sign-in for the dashboard to show once (AFTA: last login and failures since). */
  const startSession = async (r: any) => {
    setSession({ accessToken: r.accessToken, refreshToken: r.refreshToken });
    try {
      sessionStorage.setItem('kx.lastLogin', JSON.stringify({ lastLogin: r.lastLogin ?? null, endedSessions: r.endedSessions ?? 0 }));
    } catch {
      /* storage unavailable */
    }
    await refreshMe();
  };

  const login = async (identifier: string, password: string, captcha?: { captchaId: string; captchaAnswer: string }) => {
    const r = await post('/auth/login', { identifier, password, device: 'web', ...captcha });
    if (r.mfaRequired) return { mfaToken: r.mfaToken as string };
    await startSession(r);
    return {};
  };

  const verifyMfa = async (mfaToken: string, code: string) => {
    await startSession(await post('/auth/mfa/verify', { mfaToken, code, device: 'web' }));
  };

  const logout = async () => {
    const s = getSession();
    await api('/auth/logout', { method: 'POST', json: { refreshToken: s?.refreshToken } }).catch(() => {});
    setSession(null);
    setMe(null);
  };

  const isAdmin = !!me && (me.isNational || me.adminChambers.length > 0);
  const isItAdmin = !!me && (me.is_super_admin || me.itChambers.length > 0);
  const isAuditor = !!me && (me.auditAll || me.auditChambers.length > 0);
  const [selected, setSelected] = useState<string | null>(() => {
    try {
      return localStorage.getItem('kx.chamber');
    } catch {
      return null;
    }
  });
  const setChamberId = (id: string) => {
    setSelected(id);
    try {
      localStorage.setItem('kx.chamber', id);
    } catch {
      /* ignore */
    }
  };
  const allowedSelection = !!me && !!selected && chamberSelectable(me, selected);
  const chamberId = me
    ? allowedSelection
      ? selected
      : (me.adminChambers[0] ?? me.itChambers[0] ?? me.chamber_id ?? me.memberships[0]?.chamber_id ?? null)
    : null;

  return (
    <Ctx.Provider value={{ me, loading, login, verifyMfa, logout, refreshMe, isAdmin, isItAdmin, isAuditor, chamberId, setChamberId }}>{children}</Ctx.Provider>
  );
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error('AuthProvider missing');
  return c;
}

/** Chambers an administrator may pick in the top bar: all of them for the system's IT administrator and the national secretariat. */
export function chamberSelectable(me: Me, chamberId: string): boolean {
  return me.is_super_admin || me.isNational || me.adminChambers.includes(chamberId) || me.itChambers.includes(chamberId);
}

/** مدیر اتاق of this chamber. */
export const runsChamber = (me: Me | null, chamberId: string | null | undefined) => !!me && !!chamberId && me.adminChambers.includes(chamberId);
/** Manages this chamber's logins and roles. */
export const itOfChamber = (me: Me | null, chamberId: string | null | undefined) => !!me && !!chamberId && (me.is_super_admin || me.itChambers.includes(chamberId));
