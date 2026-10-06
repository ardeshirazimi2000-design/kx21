import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

/**
 * Server address. One APK can serve any chamber's server: the user enters the address on the
 * login screen (stored on the device). Build-time default: EXPO_PUBLIC_API_URL or app.json → extra.apiUrl.
 */
const DEFAULT_API_URL: string =
  process.env.EXPO_PUBLIC_API_URL ?? (Constants.expoConfig?.extra?.apiUrl as string | undefined) ?? 'http://localhost:4000';

const KEY = 'kx.server';
let current = DEFAULT_API_URL;

export function getApiUrl(): string {
  return current;
}

/** Accepts "1.2.3.4:8000", "example.ir" or a full URL; returns the normalised base URL. */
export function normalizeServerUrl(input: string): string {
  let v = input.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(v)) v = `http://${v}`;
  return v.replace(/\/api$/, '');
}

export async function loadApiUrl(): Promise<string> {
  try {
    const saved = Platform.OS === 'web' ? null : await SecureStore.getItemAsync(KEY);
    if (saved) current = saved;
  } catch {
    /* keep default */
  }
  return current;
}

export async function setApiUrl(url: string): Promise<void> {
  current = normalizeServerUrl(url);
  try {
    if (Platform.OS !== 'web') await SecureStore.setItemAsync(KEY, current);
  } catch {
    /* in-memory only */
  }
}
