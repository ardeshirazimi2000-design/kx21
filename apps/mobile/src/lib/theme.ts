import { useColorScheme } from 'react-native';

const light = {
  bg: '#f4f6f8',
  surface: '#ffffff',
  surface2: '#f8fafb',
  border: '#e2e8ec',
  text: '#17232b',
  muted: '#5d6d78',
  primary: '#0f4c5c',
  primaryInk: '#ffffff',
  primarySoft: '#e3eff2',
  accent: '#b7791f',
  success: '#1f7a4d',
  successSoft: '#e2f4ea',
  warning: '#a15c07',
  warningSoft: '#fdf0dc',
  danger: '#b42318',
  dangerSoft: '#fde8e6',
  info: '#175cd3',
  infoSoft: '#e5eefc',
};

const dark: typeof light = {
  bg: '#0f1518',
  surface: '#172024',
  surface2: '#1c272c',
  border: '#2a383e',
  text: '#e4ecef',
  muted: '#93a6ae',
  primary: '#4fb3c8',
  primaryInk: '#06232a',
  primarySoft: '#16343c',
  accent: '#e0a54a',
  success: '#4cc38a',
  successSoft: '#133325',
  warning: '#f0a54a',
  warningSoft: '#3a2a12',
  danger: '#f97066',
  dangerSoft: '#3d1a17',
  info: '#78a9ff',
  infoSoft: '#172a4a',
};

export type Theme = typeof light;

export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? dark : light;
}
