import { useEffect, useState } from 'react';
import { get } from './api';

/** The organisation running the system (مشخصات سازمان): public, shown before sign-in too. */
export interface OrgProfile {
  name: string;
  shortName: string | null;
  /** The logo to show, or null for none. */
  logoUrl: string | null;
  hasLogo: boolean;
  builtinLogo: string | null;
}

let current: OrgProfile | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<(p: OrgProfile) => void>();

export function setOrgProfile(p: OrgProfile) {
  current = p;
  listeners.forEach((l) => l(p));
}

function load() {
  loading ??= get<OrgProfile>('/org-profile')
    .then(setOrgProfile)
    .catch(() => {
      loading = null;
    });
  return loading;
}

/** The profile, loaded once per page and shared by every component; null until it arrives. */
export function useOrgProfile(): OrgProfile | null {
  const [p, setP] = useState(current);
  useEffect(() => {
    listeners.add(setP);
    if (!current) void load();
    else setP(current);
    return () => {
      listeners.delete(setP);
    };
  }, []);
  return p;
}
