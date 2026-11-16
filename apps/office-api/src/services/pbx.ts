/**
 * The only place the office automation talks to the telephone exchange (PBX) through.
 * The browser never reaches AMI/ARI: every telephony action goes API → this adapter → PBX.
 *
 * Drivers: 'none' (no PBX: directory, extensions registry and messenger still work, extensions are confirmed on the
 * PBX by hand) and 'asterisk-ami' (services/pbxAsterisk.ts, chosen with PBX_DRIVER=asterisk-ami).
 */
export interface PbxAdapter {
  readonly kind: 'none' | 'asterisk-ami';
  readonly configured: boolean;
  /** Logged in to the PBX right now. */
  connected(): boolean;
  /** Creates or updates the endpoint of an extension; idempotent (the whole configuration is regenerated). */
  provisionExtension(ext: { id: string; number: string; label: string | null }): Promise<void>;
  /** Removes the endpoint (history kept on both sides). */
  disableExtension(ext: { id: string; number: string }): Promise<void>;
  /** Rewrites the PBX configuration from Rasa's data (extension suspended, user deactivated, settings changed). */
  sync(): Promise<void>;
  /**
   * Rings `fromExtension`; when answered, dials `to` with the dial plan of that extension (click-to-call).
   * `callId` becomes the PBX's id of the call (Asterisk ChannelId → Linkedid), so the row Rasa opened beforehand is
   * the one the PBX events update.
   */
  originate(o: { fromExtension: string; to: string; callerName: string; userId: string; callId: string }): Promise<void>;
}

export class PbxNotConfigured extends Error {
  constructor() {
    super('pbx not configured');
  }
}

const none: PbxAdapter = {
  kind: 'none',
  configured: false,
  connected: () => false,
  async provisionExtension() {
    throw new PbxNotConfigured();
  },
  async disableExtension() {
    /* nothing to do without a PBX */
  },
  async sync() {
    /* nothing to do without a PBX */
  },
  async originate() {
    throw new PbxNotConfigured();
  },
};

let adapter: PbxAdapter = none;

export const pbx = () => adapter;

/** server.ts installs the configured driver; tests install a fake. */
export function setPbxAdapter(a: PbxAdapter | null) {
  adapter = a ?? none;
}

/** Refreshes the PBX configuration in the background (never fails the caller's request). */
export function syncPbxSoon() {
  if (!adapter.configured) return;
  void adapter.sync().catch(() => undefined);
}
