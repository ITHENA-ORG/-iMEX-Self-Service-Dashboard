// Live telemetry over the ThingsBoard WebSocket (D-021): replaces the 10-second REST polling of latest values.
//
// What it does
//   One WebSocket per browser page (shared by every iMEX widget on the page through window.__imexDbbLive),
//   one LATEST_TELEMETRY subscription per device with the union of the keys the widgets asked for.
//   ThingsBoard sends the current values once, then pushes every change (~0.1 s after it is saved).
//   core/api.ts reads from this cache instead of calling REST:
//     - api.latest()  -> get()          (value cards, gauges, status, tables, text placeholders, listing cards)
//     - api.series()  -> since()        (realtime charts: REST once, then live points appended; see api.ts)
//   The renderer redraws on onChange() instead of on a 10 s timer (entries/renderer.ts, entries/listing.ts).
//
// Protocol (verified on ThingsBoard CE 4.3, demo.thingsboard.io, 27 Sep 2026)
//   v2 (TB 3.6+):  wss://<host>/api/ws (ws:// on an http: page, D-035), first message carries {authCmd: {cmdId: 0, token: <jwt>}} and the
//                  commands {cmds: [{type: 'TIMESERIES', entityType, entityId, scope: 'LATEST_TELEMETRY', cmdId, keys}]};
//                  unsubscribe {cmds: [{type: 'TIMESERIES', cmdId, unsubscribe: true}]}.
//   legacy:        wss://<host>/api/ws/plugins/telemetry?token=<jwt>, {tsSubCmds: [...same fields...]}.
//   Replies (both): {subscriptionId: cmdId, errorCode, errorMsg, data: {key: [[ts, "value"], ...]}}.
//                   A key with no value arrives as [[ts, null]] and is treated as absent.
//   v2 is tried first; if the socket closes before any reply, the next attempt uses legacy.
//
// Failure handling
//   While the socket is down, get() returns null and since() returns null, so api.ts falls back to REST
//   exactly as before (and the renderer's fallback timer polls every 10 s). Reconnects with back-off
//   (2, 5, 15, 30, then every 60 s); the JWT is read from localStorage at each connect, so a token refreshed
//   by the ThingsBoard UI is picked up. Subscriptions unused for 3 minutes are dropped (machine switched).
//
// Tests: widgets/test/live.test.ts drives this class with a fake WebSocket.

import { connectLive } from './tb-socket';

/** One live value. Numeric strings are converted to numbers (same rule as api.latest). */
export interface LivePoint {
  ts: number;
  value: number | string;
}

/** Per-device subscription state. */
interface Sub {
  cmdId: number;
  keys: Set<string>;
  /** First reply for the current cmdId received; values in `latest` are complete for `keys`. */
  ready: boolean;
  /** When the current subscription became ready (ms); points before this may be missing from `history`. */
  readyAt: number;
  lastUsed: number;
  failed: boolean;
}

/** Minimal WebSocket surface used here (lets tests inject a fake). */
export interface WsLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: any) => void) | null;
  onmessage: ((ev: { data: any }) => void) | null;
  onclose: ((ev: any) => void) | null;
  onerror: ((ev: any) => void) | null;
}

export interface LiveOptions {
  /** Page origin host, e.g. demo.thingsboard.io (default location.host). */
  host?: string;
  /** wss:// (true) or ws:// (false). Default: ws only on an http: page, e.g. a local ThingsBoard (D-035). */
  secure?: boolean;
  /** JWT source (default localStorage.jwt_token). */
  token?: () => string | null;
  /** WebSocket factory (default native WebSocket). */
  connect?: (url: string) => WsLike;
  now?: () => number;
  /** setTimeout replacement (tests). */
  later?: (fn: () => void, ms: number) => any;
}

const HISTORY_CAP = 3000;
/**
 * D-080: live points kept per key. A cached read is only extended for 5 minutes (api.series, api.windowAgg), so older
 * points are never used; a listing subscribes up to 20 keys of every machine, hundreds of MB after a working day.
 */
const HISTORY_MS = 20 * 60e3;
const UNUSED_MS = 3 * 60e3;
/** D-080: how often pushes also look for subscriptions nobody asked for lately. */
const SWEEP_MS = 60e3;
const BACKOFF = [2000, 5000, 15000, 30000, 60000];

function toNum(v: any): number | string {
  const n = Number(v);
  return Number.isFinite(n) && String(v).trim() !== '' ? n : v;
}

export class Live {
  private ws: WsLike | null = null;
  private state: 'idle' | 'connecting' | 'open' | 'down' = 'idle';
  private mode: 'v2' | 'legacy' = 'v2';
  private gotReply = false;
  private failures = 0;
  private nextCmd = 1;
  private subs = new Map<string, Sub>();
  private byCmd = new Map<number, string>();
  private latestV = new Map<string, Map<string, LivePoint>>();
  private hist = new Map<string, Map<string, LivePoint[]>>();
  private listeners = new Set<(deviceIds: string[]) => void>();
  private pending = new Set<string>();
  private flushQueued = false;
  private reconnectTimer: any = null;
  private lastSweep = 0;
  private o: Required<LiveOptions>;

  constructor(opts: LiveOptions = {}) {
    this.o = {
      host: opts.host ?? (typeof location !== 'undefined' ? location.host : ''),
      secure: opts.secure ?? !(typeof location !== 'undefined' && location.protocol === 'http:'),
      token: opts.token ?? (() => (typeof localStorage !== 'undefined' ? localStorage.getItem('jwt_token') : null)),
      connect: opts.connect ?? ((url) => new WebSocket(url) as unknown as WsLike),
      now: opts.now ?? (() => Date.now()),
      later: opts.later ?? ((fn, ms) => setTimeout(fn, ms)),
    };
  }

  /** True while the socket is open (values from get()/since() are current). */
  isLive(): boolean {
    return this.state === 'open';
  }

  /**
   * Makes sure `deviceId` is subscribed for `keys` (adds keys to its subscription if needed).
   * Opens the socket on first use. Cheap to call on every draw.
   */
  want(deviceId: string, keys: string[]): void {
    if (!keys.length) return;
    const now = this.o.now();
    let s = this.subs.get(deviceId);
    const missing = keys.filter((k) => !s || !s.keys.has(k));
    if (s) s.lastUsed = now;
    // a failed subscription (errorCode) stays on REST until the next reconnect resubscribes it
    if (!missing.length && s) return this.ensureSocket();
    const all = new Set([...(s?.keys ?? []), ...keys]);
    if (s && this.state === 'open') this.sendUnsub(s.cmdId);
    if (s) this.byCmd.delete(s.cmdId);
    s = { cmdId: this.nextCmd++, keys: all, ready: false, readyAt: 0, lastUsed: now, failed: false };
    this.subs.set(deviceId, s);
    this.byCmd.set(s.cmdId, deviceId);
    this.gc();
    if (this.state === 'open') this.sendSub(deviceId, s);
    else this.ensureSocket();
  }

  /**
   * Latest values of `keys` from the live cache, or null when they are not (yet) available live
   * (socket down, subscription not ready, or a key not subscribed) - the caller then uses REST.
   * A key without a value is absent from the result (same as api.latest).
   */
  get(deviceId: string, keys: string[]): Record<string, LivePoint | undefined> | null {
    const s = this.subs.get(deviceId);
    if (this.state !== 'open' || !s || !s.ready || s.failed || keys.some((k) => !s.keys.has(k))) return null;
    s.lastUsed = this.o.now();
    const vals = this.latestV.get(deviceId);
    const out: Record<string, LivePoint | undefined> = {};
    for (const k of keys) {
      const p = vals?.get(k);
      if (p) out[k] = p;
    }
    return out;
  }

  /**
   * Time from which live points of `keys` are complete (the subscription's readyAt), or null when not live.
   * api.series appends since() only to data fetched at or after this time, so no gap can appear.
   */
  liveSince(deviceId: string, keys: string[]): number | null {
    const s = this.subs.get(deviceId);
    if (this.state !== 'open' || !s || !s.ready || s.failed || keys.some((k) => !s.keys.has(k))) return null;
    return s.readyAt;
  }

  /** Points of `key` received live with ts > afterTs, oldest first ([] when none; null when not live). */
  since(deviceId: string, key: string, afterTs: number): LivePoint[] | null {
    if (this.liveSince(deviceId, [key]) == null) return null;
    return (this.hist.get(deviceId)?.get(key) ?? []).filter((p) => p.ts > afterTs);
  }

  /**
   * Resolves true as soon as get(deviceId, keys) would return live values, false when the socket is down
   * or `timeoutMs` passes first (D-022: lets a cold page wait briefly instead of making REST calls).
   * Checks every 50 ms; call want() first.
   */
  waitReady(deviceId: string, keys: string[], timeoutMs: number): Promise<boolean> {
    const until = this.o.now() + timeoutMs;
    return new Promise((resolve) => {
      const check = () => {
        const s = this.subs.get(deviceId);
        if (this.state === 'open' && s && s.ready && !s.failed && keys.every((k) => s.keys.has(k))) return resolve(true);
        if (this.state === 'down' || (s && s.failed) || this.o.now() >= until) return resolve(false);
        this.o.later(check, 50);
      };
      check();
    });
  }

  /** Called (batched per tick) with the devices whose values changed. Returns an unsubscribe function. */
  onChange(fn: (deviceIds: string[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** True while the subscriptions go through ThingsBoard's own WebSocket (core/tb-socket.ts, D-042). */
  throughTb(): boolean {
    return !!(this.ws && (this.ws as any).isTb);
  }

  /**
   * Re-opens at once (no back-off) and resubscribes everything, keeping the cached values: used when a ThingsBoard
   * context appears or goes away (D-042), so the hub moves to the dashboard's own connection without a gap.
   */
  reconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
    for (const s of this.subs.values()) s.ready = false;
    this.failures = 0;
    this.state = 'down';
    if (this.subs.size) this.open();
    else this.state = 'idle';
  }

  /** Closes the socket and forgets everything (tests, teardown). */
  close(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const ws = this.ws;
    this.ws = null;
    this.state = 'idle';
    if (ws) {
      ws.onclose = null;
      ws.close();
    }
  }

  // ---------- internals ----------

  private ensureSocket() {
    if (this.state === 'idle') this.open();
  }

  private open() {
    const token = this.o.token();
    if (!token || !this.o.host) {
      this.state = 'down';
      return this.scheduleReconnect();
    }
    this.state = 'connecting';
    this.gotReply = false;
    // D-035: wss was hard-coded, so on an http: ThingsBoard the v2 socket failed and the legacy fallback put the
    // token in the URL; the scheme now follows the page.
    const scheme = this.o.secure ? 'wss' : 'ws';
    const url = this.mode === 'v2' ? `${scheme}://${this.o.host}/api/ws` : `${scheme}://${this.o.host}/api/ws/plugins/telemetry?token=${encodeURIComponent(token)}`;
    let ws: WsLike;
    try {
      ws = this.o.connect(url);
    } catch {
      this.state = 'down';
      return this.scheduleReconnect();
    }
    this.ws = ws;
    ws.onopen = () => {
      this.state = 'open';
      // (Re)subscribe everything with fresh cmdIds; values stay cached until the new replies arrive.
      const cmds: any[] = [];
      for (const [dev, s] of this.subs) {
        this.byCmd.delete(s.cmdId);
        s.cmdId = this.nextCmd++;
        s.ready = false;
        s.failed = false;
        this.byCmd.set(s.cmdId, dev);
        cmds.push(this.subCmd(dev, s));
      }
      if (this.mode === 'v2') ws.send(JSON.stringify({ authCmd: { cmdId: 0, token }, cmds }));
      else if (cmds.length) ws.send(JSON.stringify({ tsSubCmds: cmds, historyCmds: [], attrSubCmds: [] }));
    };
    ws.onmessage = (ev) => this.onMessage(ev.data);
    ws.onerror = () => {};
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      // v2 endpoint closed without any reply: an older ThingsBoard; try the legacy endpoint next.
      if (!this.gotReply) this.mode = this.mode === 'v2' ? 'legacy' : 'v2';
      this.state = 'down';
      for (const s of this.subs.values()) s.ready = false;
      this.emit([...this.subs.keys()]);
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    const ms = BACKOFF[Math.min(this.failures, BACKOFF.length - 1)];
    this.failures++;
    this.reconnectTimer = this.o.later(() => {
      this.reconnectTimer = null;
      if (this.state !== 'down') return;
      this.dropIdle(); // D-080: don't reconnect for a page that has been left
      if (this.subs.size) this.open();
      else this.state = 'idle';
    }, ms);
  }

  private subCmd(deviceId: string, s: Sub) {
    const base = { entityType: 'DEVICE', entityId: deviceId, scope: 'LATEST_TELEMETRY', cmdId: s.cmdId, keys: [...s.keys].join(',') };
    return this.mode === 'v2' ? { type: 'TIMESERIES', ...base } : base;
  }

  private sendSub(deviceId: string, s: Sub) {
    const c = this.subCmd(deviceId, s);
    this.ws?.send(JSON.stringify(this.mode === 'v2' ? { cmds: [c] } : { tsSubCmds: [c], historyCmds: [], attrSubCmds: [] }));
  }

  private sendUnsub(cmdId: number) {
    const c = { cmdId, unsubscribe: true };
    try {
      this.ws?.send(JSON.stringify(this.mode === 'v2' ? { cmds: [{ type: 'TIMESERIES', ...c }] } : { tsSubCmds: [c], historyCmds: [], attrSubCmds: [] }));
    } catch {
      /* socket closing; resubscribe happens on reconnect */
    }
  }

  private onMessage(raw: any) {
    let m: any;
    try {
      m = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch {
      return;
    }
    this.gotReply = true;
    this.failures = 0;
    if (this.o.now() - this.lastSweep >= SWEEP_MS) {
      this.lastSweep = this.o.now();
      this.dropIdle();
      if (!this.subs.size) return this.close(); // nothing on this page uses the hub any more
    }
    const dev = this.byCmd.get(m?.subscriptionId);
    if (!dev) return;
    const s = this.subs.get(dev)!;
    if (m.errorCode) {
      s.failed = true; // this device falls back to REST
      return;
    }
    const now = this.o.now();
    if (!s.ready) {
      s.ready = true;
      s.readyAt = now;
    }
    let vals = this.latestV.get(dev);
    if (!vals) this.latestV.set(dev, (vals = new Map()));
    let hist = this.hist.get(dev);
    if (!hist) this.hist.set(dev, (hist = new Map()));
    for (const [k, pts] of Object.entries<any[]>(m.data ?? {})) {
      for (const [ts, v] of pts ?? []) {
        if (v === null || v === undefined || String(v) === '') {
          if (!vals.get(k)) vals.delete(k);
          continue;
        }
        const p = { ts: Number(ts), value: toNum(v) };
        const cur = vals.get(k);
        if (!cur || p.ts >= cur.ts) vals.set(k, p);
        let h = hist.get(k);
        if (!h) hist.set(k, (h = []));
        if (!h.length || p.ts > h[h.length - 1].ts) h.push(p);
        // D-028: trim in batches (not one element per push): amortised O(1) per point
        if (h.length > HISTORY_CAP * 1.25) h.splice(0, h.length - HISTORY_CAP);
        else if (h[0].ts < p.ts - HISTORY_MS - 60e3) {
          // D-080: at most once a minute per key (relative to the newest point: a device's clock may be off)
          const cut = p.ts - HISTORY_MS;
          let n = 0;
          while (n < h.length && h[n].ts < cut) n++;
          h.splice(0, n);
        }
      }
    }
    this.emit([dev]);
  }

  /** Batches change notifications into one call per microtask. */
  private emit(devs: string[]) {
    for (const d of devs) this.pending.add(d);
    if (this.flushQueued) return;
    this.flushQueued = true;
    Promise.resolve().then(() => {
      this.flushQueued = false;
      const list = [...this.pending];
      this.pending.clear();
      if (list.length) for (const fn of this.listeners) fn(list);
    });
  }

  /**
   * D-080: gc() without waiting for a new subscription: after the user left the page (the navbar widget stays and carries
   * the hub) nothing asks for a new one, and every machine of the old page kept pushing until a full reload. A hidden tab
   * keeps its subscriptions (its redraws are paused, not finished).
   */
  private dropIdle() {
    if (typeof document !== 'undefined' && document.hidden) return;
    this.gc();
  }

  /** Drops subscriptions not used for 3 minutes (e.g. the previous machine after a switch). */
  private gc() {
    const cut = this.o.now() - UNUSED_MS;
    for (const [dev, s] of this.subs) {
      if (s.lastUsed >= cut) continue;
      if (this.state === 'open') this.sendUnsub(s.cmdId);
      this.byCmd.delete(s.cmdId);
      this.subs.delete(dev);
      this.latestV.delete(dev);
      this.hist.delete(dev);
    }
  }
}

/**
 * The page-wide instance, shared by all iMEX widget types (each embeds its own copy of this library),
 * or null outside a browser / when WebSocket is unavailable / when disabled with setLiveEnabled(false).
 */
let enabled = true;
export function liveHub(): Live | null {
  if (!enabled || typeof window === 'undefined' || typeof (window as any).WebSocket === 'undefined') return null;
  const w = window as any;
  // D-042: through ThingsBoard's own WebSocket when an iMEX widget lends its context (tb-socket.ts), else our own
  return (w.__imexDbbLive1 ??= new Live({ connect: connectLive }));
}

/** Turns the live layer off (REST only), e.g. for tests or a widget setting. */
export function setLiveEnabled(on: boolean) {
  enabled = on;
}
