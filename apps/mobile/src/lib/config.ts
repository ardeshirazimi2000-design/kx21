import Constants from 'expo-constants';

/**
 * API base URL. Override at build time with EXPO_PUBLIC_API_URL
 * (e.g. https://commissions.chamber.ir) or in app.json → expo.extra.apiUrl.
 * On an Android emulator use http://10.0.2.2:4000 for a local API.
 */
export const API_URL: string =
  process.env.EXPO_PUBLIC_API_URL ?? (Constants.expoConfig?.extra?.apiUrl as string | undefined) ?? 'http://localhost:4000';
