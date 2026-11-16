/**
 * The only place the office automation will talk to a telephone exchange (PBX) through.
 * The browser never reaches AMI/ARI: every telephony action goes API → this adapter → PBX.
 *
 * Which PBX (the organisation's existing Issabel, or a new Asterisk next to Rasa) is still to be decided, so the only
 * driver today is 'none': the communications module (directory, extensions registry, messenger) works without a PBX,
 * and extensions are confirmed on the PBX by hand ('manual'). A real driver implements this interface.
 */
export interface PbxAdapter {
  readonly kind: 'none' | 'asterisk-ami' | 'issabel';
  readonly configured: boolean;
  /** Creates or updates the endpoint of an extension; must be idempotent (same number twice = no change). */
  provisionExtension(ext: { id: string; number: string; label: string | null }): Promise<void>;
  /** Disables the endpoint (history kept on both sides). */
  disableExtension(ext: { id: string; number: string }): Promise<void>;
}

export class PbxNotConfigured extends Error {
  constructor() {
    super('pbx not configured');
  }
}

const none: PbxAdapter = {
  kind: 'none',
  configured: false,
  async provisionExtension() {
    throw new PbxNotConfigured();
  },
  async disableExtension() {
    /* nothing to do without a PBX */
  },
};

let adapter: PbxAdapter = none;

export const pbx = () => adapter;

/** Tests (and a future driver) install their adapter here. */
export function setPbxAdapter(a: PbxAdapter | null) {
  adapter = a ?? none;
}
