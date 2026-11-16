import { EventEmitter } from 'node:events';
import net from 'node:net';
import { logger } from './logger.js';

export type AmiMessage = Record<string, string>;

/**
 * Minimal Asterisk Manager Interface client (TCP, key: value lines, blank line between messages).
 * - one connection, re-established with backoff; `connected` reflects a logged-in session
 * - send() resolves with the Response (and, for list actions, the events up to the "…Complete" event)
 * - 'event' is emitted for every unsolicited event; 'ready' after each successful login
 * Only the Rasa backend talks to AMI; it is never exposed to browsers.
 */
export class AmiClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private buf = '';
  private seq = 0;
  private pending = new Map<string, { resolve: (r: AmiMessage[]) => void; reject: (e: Error) => void; list: AmiMessage[]; isList: boolean; timer: NodeJS.Timeout }>();
  private stopped = false;
  private retry = 0;
  private ping: NodeJS.Timeout | null = null;
  connected = false;

  constructor(private readonly opts: { host: string; port: number; username: string; secret: string; timeoutMs?: number }) {
    super();
  }

  start() {
    this.stopped = false;
    this.connect();
    return this;
  }

  stop() {
    this.stopped = true;
    if (this.ping) clearInterval(this.ping);
    this.socket?.destroy();
    this.socket = null;
    this.connected = false;
  }

  private connect() {
    if (this.stopped) return;
    const s = net.connect({ host: this.opts.host, port: this.opts.port });
    this.socket = s;
    this.buf = '';
    s.setEncoding('utf8');
    s.setKeepAlive(true, 30_000);
    s.on('data', (d: string) => this.onData(d));
    s.on('error', (e) => logger.warn({ err: e.message }, 'AMI connection error'));
    s.on('close', () => {
      const was = this.connected;
      this.connected = false;
      if (this.ping) clearInterval(this.ping);
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error('AMI disconnected'));
        this.pending.delete(id);
      }
      if (was) this.emit('disconnected');
      if (this.stopped) return;
      const delay = Math.min(30_000, 1000 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay).unref();
    });
  }

  private onData(d: string) {
    this.buf += d;
    // The greeting line ("Asterisk Call Manager/x.y") has no blank line after it.
    if (!this.connected && this.buf.startsWith('Asterisk Call Manager')) {
      const nl = this.buf.indexOf('\r\n');
      if (nl < 0) return;
      this.buf = this.buf.slice(nl + 2);
      void this.login();
    }
    let i: number;
    while ((i = this.buf.indexOf('\r\n\r\n')) >= 0) {
      const raw = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 4);
      const msg: AmiMessage = {};
      for (const line of raw.split('\r\n')) {
        const c = line.indexOf(':');
        if (c > 0) msg[line.slice(0, c).trim()] = line.slice(c + 1).trim();
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: AmiMessage) {
    const id = msg.ActionID;
    const p = id ? this.pending.get(id) : undefined;
    if (p) {
      if (msg.Response) {
        if (msg.Response === 'Error') return this.finish(id!, new Error(msg.Message || 'AMI error'));
        p.list.push(msg);
        if (!p.isList || msg.EventList !== 'start') return this.finish(id!);
        return;
      }
      if (msg.Event) {
        p.list.push(msg);
        if (msg.EventList === 'Complete' || /Complete$/.test(msg.Event)) this.finish(id!);
        return;
      }
    }
    if (msg.Event) this.emit('event', msg);
  }

  private finish(id: string, err?: Error) {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    if (err) p.reject(err);
    else p.resolve(p.list);
  }

  private async login() {
    try {
      await this.raw({ Action: 'Login', Username: this.opts.username, Secret: this.opts.secret, Events: 'call,system' }, false);
      this.connected = true;
      this.retry = 0;
      logger.info({ host: this.opts.host }, 'AMI connected');
      this.ping = setInterval(() => void this.send({ Action: 'Ping' }).catch(() => this.socket?.destroy()), 30_000);
      this.ping.unref();
      this.emit('ready');
    } catch (e) {
      logger.error({ err: (e as Error).message }, 'AMI login failed');
      this.socket?.destroy();
    }
  }

  /** Sends an action; list actions (…List, PJSIPShow…) resolve after their "Complete" event. */
  send(fields: Record<string, string | number | undefined>, isList = false): Promise<AmiMessage[]> {
    if (!this.connected) return Promise.reject(new Error('AMI not connected'));
    return this.raw(fields, isList);
  }

  private raw(fields: Record<string, string | number | undefined>, isList: boolean): Promise<AmiMessage[]> {
    const id = `rasa-${++this.seq}`;
    const lines = Object.entries({ ...fields, ActionID: id })
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}: ${String(v).replace(/[\r\n]/g, ' ')}`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.finish(id, new Error('AMI timeout')), this.opts.timeoutMs ?? 10_000);
      this.pending.set(id, { resolve, reject, list: [], isList, timer });
      this.socket?.write(lines.join('\r\n') + '\r\n\r\n');
    });
  }
}
