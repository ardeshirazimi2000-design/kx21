import { config } from '../config.js';
import { one, query } from '../db/pool.js';
import { AmiClient, type AmiMessage } from '../lib/ami.js';
import { logger } from '../lib/logger.js';
import { writePbxConfig } from './pbxConfig.js';
import type { PbxAdapter } from './pbx.js';
import { emitToUsers } from './realtime.js';

/**
 * Asterisk driver: configuration through generated PJSIP/dial-plan files + AMI reload, calls followed through AMI events.
 * Events are stored per call (Linkedid) in communication_calls / communication_call_events, idempotently, and pushed
 * in real time only to the people on the call. Nothing goes into the audit chain per call (volume).
 */

/** "PJSIP/201-0000002a" → "201"; the trunk endpoint gives "rasa-trunk". */
export const endpointOf = (channel: string | undefined) => channel?.match(/^PJSIP\/(.+)-[0-9a-f]+$/)?.[1] ?? null;
const isNumber = (s: string | null | undefined) => !!s && /^[0-9*#+]{1,32}$/.test(s);

async function userOfExtension(num: string | null) {
  if (!num || !/^[0-9]{2,6}$/.test(num)) return null;
  const r = await one(`SELECT user_id FROM communication_extensions WHERE extension_number = $1 AND status <> 'disabled'`, [num]);
  return (r?.user_id as string | undefined) ?? null;
}

const callUsers = (c: any) => [c.caller_user_id, c.callee_user_id].filter(Boolean) as string[];

async function recordEvent(callId: string, type: string, key: string, payload: Record<string, unknown>) {
  const r = await query(
    `INSERT INTO communication_call_events (call_id, event_type, event_key, payload) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id`,
    [callId, type, key, JSON.stringify(payload)],
  );
  return r.length > 0;
}

/** Handles one AMI event; exported for tests. Safe to call twice with the same event. */
export async function handleAmiEvent(e: AmiMessage) {
  switch (e.Event) {
    case 'Newchannel': {
      // The first channel of a call carries Uniqueid = Linkedid: it opens the call.
      if (!e.Linkedid || e.Uniqueid !== e.Linkedid) return;
      const ep = endpointOf(e.Channel);
      const inbound = ep === 'rasa-trunk';
      const caller = inbound ? e.CallerIDNum : ep;
      const callee = e.Exten && e.Exten !== 's' ? e.Exten : null;
      const callerUser = inbound ? null : await userOfExtension(ep);
      const row = await one(
        `INSERT INTO communication_calls (unique_call_id, direction, caller_number, caller_name, callee_number, caller_user_id)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (unique_call_id) DO NOTHING RETURNING *`,
        [e.Linkedid, inbound ? 'inbound' : 'internal', isNumber(caller) ? caller : null, e.CallerIDName && e.CallerIDName !== '<unknown>' ? e.CallerIDName.slice(0, 80) : null, isNumber(callee) ? callee : null, callerUser],
      );
      if (row) await recordEvent(row.id, 'started', e.Uniqueid, {});
      return;
    }
    case 'DialBegin': {
      const call = await one('SELECT * FROM communication_calls WHERE unique_call_id = $1', [e.Linkedid]);
      if (!call) return;
      const dest = endpointOf(e.DestChannel);
      // Click-to-call first rings the caller's own phone: that is not the callee.
      if (dest && dest === call.caller_number) return;
      const destUser = await userOfExtension(dest);
      if (!(await recordEvent(call.id, 'ringing', e.DestUniqueid ?? e.DestChannel ?? '', { to: dest }))) return;
      // Towards the city line: the call is outbound and the number is in the dial string ("09121234567@rasa-trunk").
      if (dest === 'rasa-trunk') {
        const num = e.DialString?.split('@')[0];
        await query(`UPDATE communication_calls SET direction = 'outbound', callee_number = $2 WHERE id = $1 AND direction <> 'inbound'`, [call.id, isNumber(num) ? num : null]);
        return;
      }
      // The first extension that rings is the callee until someone answers.
      const updated = await one(
        `UPDATE communication_calls SET callee_user_id = COALESCE(callee_user_id, $2), callee_number = COALESCE(callee_number, $3) WHERE id = $1 RETURNING *`,
        [call.id, destUser, isNumber(dest) ? dest : null],
      );
      if (destUser) {
        emitToUsers([destUser], call.direction === 'inbound' ? 'IncomingCall' : 'CallRinging', {
          callId: call.id,
          from: updated.caller_number,
          fromName: updated.caller_name,
          direction: call.direction,
        });
      }
      return;
    }
    case 'DialEnd': {
      if (e.DialStatus !== 'ANSWER') return;
      const call = await one('SELECT * FROM communication_calls WHERE unique_call_id = $1', [e.Linkedid]);
      if (!call) return;
      const dest = endpointOf(e.DestChannel);
      const destUser = dest === 'rasa-trunk' ? null : await userOfExtension(dest);
      if (!(await recordEvent(call.id, 'answered', e.DestUniqueid ?? '', { by: dest }))) return;
      const r = await one(
        `UPDATE communication_calls SET answered_at = COALESCE(answered_at, now()),
           callee_user_id = COALESCE($2, callee_user_id), callee_number = CASE WHEN $3::text IS NOT NULL THEN $3 ELSE callee_number END
          WHERE id = $1 RETURNING *`,
        [call.id, destUser, destUser && isNumber(dest) ? dest : null],
      );
      emitToUsers(callUsers(r), 'CallAnswered', { callId: call.id });
      return;
    }
    case 'Hangup': {
      // The call ends with its first channel.
      if (!e.Linkedid || e.Uniqueid !== e.Linkedid) return;
      const call = await one('SELECT * FROM communication_calls WHERE unique_call_id = $1', [e.Linkedid]);
      if (!call || call.ended_at) return;
      const cause = Number(e.Cause);
      const disposition = call.answered_at ? 'answered' : cause === 17 ? 'busy' : [16, 19, 21, 18, 0].includes(cause) || Number.isNaN(cause) ? 'missed' : 'failed';
      const r = await one(
        `UPDATE communication_calls SET ended_at = now(), disposition = $2,
           duration_seconds = CASE WHEN answered_at IS NULL THEN 0 ELSE GREATEST(0, EXTRACT(EPOCH FROM now() - answered_at))::int END
          WHERE id = $1 AND ended_at IS NULL RETURNING *`,
        [call.id, disposition],
      );
      if (!r) return;
      await recordEvent(call.id, 'ended', e.Uniqueid, { cause: Number.isNaN(cause) ? null : cause });
      emitToUsers(callUsers(r), disposition === 'missed' ? 'CallMissed' : 'CallEnded', { callId: call.id, disposition });
      return;
    }
    case 'ContactStatus': {
      // A phone registered (Created / NonQualified) or answers qualify (Reachable): remember when, and show it.
      // Unreachable / Removed: the phone is gone (its owner sees it on the extensions page).
      const num = e.EndpointName;
      if (!num || !/^[0-9]{2,6}$/.test(num)) return;
      const up = ['Created', 'NonQualified', 'Reachable'].includes(e.ContactStatus);
      if (!up && !['Unreachable', 'Removed'].includes(e.ContactStatus)) return;
      const r = up
        ? await one(
            `UPDATE communication_extensions SET last_registered_at = now() WHERE extension_number = $1 AND status <> 'disabled' RETURNING user_id`,
            [num],
          )
        : await one(`SELECT user_id FROM communication_extensions WHERE extension_number = $1 AND status <> 'disabled'`, [num]);
      if (r) emitToUsers([r.user_id], 'ExtensionStatusChanged', { number: num, registered: up });
      return;
    }
  }
}

export function createAsteriskAdapter(): PbxAdapter {
  const c = config.pbx;
  const ami = new AmiClient({ host: c.amiHost, port: c.amiPort, username: c.amiUser, secret: c.amiSecret }).start();
  let chain: Promise<unknown> = Promise.resolve();
  /** Regenerate + reload, one at a time. */
  const sync = () => {
    const run = chain.then(async () => {
      await writePbxConfig(c.configDir);
      await ami.send({ Action: 'Reload', Module: 'res_pjsip.so' });
      await ami.send({ Action: 'Reload', Module: 'pbx_config.so' });
    });
    chain = run.catch(() => undefined);
    return run as Promise<void>;
  };
  // Events one after another, so a call's events are applied in order.
  let events: Promise<unknown> = Promise.resolve();
  ami.on('event', (e: AmiMessage) => {
    events = events.then(() => handleAmiEvent(e)).catch((err) => logger.warn({ err: (err as Error).message, event: e.Event }, 'call event not stored'));
  });
  ami.on('ready', () => void sync().catch((err) => logger.error({ err: (err as Error).message }, 'PBX configuration sync failed')));

  return {
    kind: 'asterisk-ami',
    configured: true,
    connected: () => ami.connected,
    async provisionExtension(ext) {
      await sync();
      // Verify that Asterisk now knows the endpoint.
      const r = await ami.send({ Action: 'PJSIPShowEndpoint', Endpoint: ext.number }, true);
      if (!r.some((m) => m.Event === 'EndpointDetail')) throw new Error(`endpoint ${ext.number} not loaded`);
    },
    async disableExtension() {
      await sync();
    },
    sync,
    async originate(o) {
      await ami.send({
        Action: 'Originate',
        Channel: `PJSIP/${o.fromExtension}`,
        Context: 'rasa-originate',
        Exten: o.to,
        Priority: 1,
        CallerID: `"${o.callerName.replace(/["\r\n]/g, '')}" <${o.to}>`,
        Timeout: 30000,
        Async: 'true',
        Variable: `RASA_FROM=${o.fromExtension}`,
        ChannelId: o.callId,
      });
    },
  };
}
