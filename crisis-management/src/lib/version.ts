import { readFileSync } from 'node:fs';

/** Product version (shown to administrators only; never in public responses — PP policy "proper configuration"). */
export const APP_VERSION: string = (() => {
  try {
    return (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  } catch {
    return 'unknown';
  }
})();
