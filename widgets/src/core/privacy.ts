// core/privacy.ts — AI privacy for the chat assistant (D-0xx; AI Insights A-070, App UI U-1xx).
//
// ONE setting for the whole iMEX application: `privacy` inside the AI switches `imexLlm` on "System Configuration"
// (Settings › Connections & AI › AI on / off) = { anonymise, send_values }, and ONE rule, the TypeScript copy of the
// App UI's window.imxPrivacy and AI Insights / Reports' service/app/privacy.py. The contract is the shared vectors
// widgets/test/privacy-vectors.json (a byte-for-byte copy of the App UI's tests/privacy-vectors.json).
//
//   settings(raw, legacy): raw = the stored imexLlm (object or JSON text; null/undefined = not stored; UNREADABLE = the
//     read failed). anonymise on unless exactly false, send_values on unless exactly false. imexLlm without a `privacy`
//     object: `legacy` read the same way, else both on. Unreadable or not an object: names replaced, no values.
//   make(entities, cfg): entities = [{ kind: machine|site|location|customer|person, name, label }]; each gets "<Kind> A",
//     "B", .. "Z", "AA", .. in the order given, per kind ("Item" otherwise); the same name twice = one alias; an alias
//     that is a real name is skipped. out(x): every name and label (2+ characters), longest first, ONE pass, whole words
//     (no letter, digit or _ around), any case -> alias; with send_values off the `valueKeys` go from objects.
//     back(x): every alias (exact case, whole words) -> the label, else the name; always. Keys never change; copies.
//
// The chat sends no measured values (the catalogue holds machine types, value keys, names and units), so send_values
// changes nothing here; anonymise replaces the labels of the machines and locations in the catalogue, the draft's
// titles, the conversation and the request, and the answer (reply, questions, options, titles) comes back with the real
// names (chat.ts chatTurn).

import * as api from './api';

export const UNREADABLE: unique symbol = Symbol('unreadable');
export interface PrivacySettings {
  anonymise: boolean;
  send_values: boolean;
}
export interface Entity {
  kind: string;
  name?: string | null;
  label?: string | null;
}
export interface Names {
  anonymise: boolean;
  send_values: boolean;
  aliases: { alias: string; name: string }[];
  out<T>(x: T, valueKeys?: string[]): T;
  back<T>(x: T): T;
}

const WORD: Record<string, string> = { machine: 'Machine', site: 'Site', location: 'Location', customer: 'Customer', person: 'Person' };
const SAFE: PrivacySettings = { anonymise: true, send_values: false };
const flag = (p: any, k: string) => !(p && typeof p === 'object' && p[k] === false);

export function settings(raw: unknown, legacy?: unknown): PrivacySettings {
  if (raw === UNREADABLE) return { ...SAFE };
  let v: any = raw;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return { ...SAFE };
    }
  }
  if (v !== null && v !== undefined && (typeof v !== 'object' || Array.isArray(v))) return { ...SAFE };
  let p: any = v && v.privacy && typeof v.privacy === 'object' && !Array.isArray(v.privacy) ? v.privacy : null;
  if (!p) p = legacy && typeof legacy === 'object' ? legacy : null;
  return { anonymise: flag(p, 'anonymise'), send_values: flag(p, 'send_values') };
}

function letters(n: number): string {
  let s = '';
  n += 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
const clean = (v: unknown) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());
const esc = (s: string) => s.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
const order = (arr: string[]) => arr.map((t, i) => [t, i] as const).sort((x, y) => y[0].length - x[0].length || x[1] - y[1]).map((x) => x[0]);

export function make(entities: Entity[] | null | undefined, cfg: PrivacySettings = settings(null)): Names {
  const list = (entities ?? []).filter((e) => e && (clean(e.name) || clean(e.label)));
  const real = new Set<string>();
  for (const e of list) for (const t of [clean(e.name), clean(e.label)]) if (t) real.add(t.toLowerCase());
  const next: Record<string, number> = {};
  const byText = new Map<string, string>();
  const shown = new Map<string, string>();
  const aliases: { alias: string; name: string }[] = [];
  for (const e of list) {
    const texts = [clean(e.name), clean(e.label)].filter(Boolean);
    let have = texts.map((t) => byText.get(t.toLowerCase())).find(Boolean) ?? null;
    if (!have) {
      const w = WORD[e.kind] ?? 'Item';
      let i = next[w] ?? 0;
      let a: string;
      do a = `${w} ${letters(i++)}`;
      while (real.has(a.toLowerCase()));
      next[w] = i;
      have = a;
      shown.set(a, clean(e.label) || clean(e.name));
      aliases.push({ alias: a, name: shown.get(a)! });
    }
    for (const t of texts) if (!byText.has(t.toLowerCase())) byText.set(t.toLowerCase(), have);
  }
  const outTexts = [...byText.keys()].filter((t) => t.length >= 2);
  let outRe: RegExp | null = null;
  let inRe: RegExp | null = null;
  try {
    // the character before a name is part of the match (no look-behind in older Safari), the one after is not
    if (outTexts.length) outRe = new RegExp(`(^|[^\\p{L}\\p{N}_])(${order(outTexts).map(esc).join('|')})(?![\\p{L}\\p{N}_])`, 'giu');
    if (aliases.length) inRe = new RegExp(`(^|[^\\p{L}\\p{N}_])(${order(aliases.map((a) => a.alias)).map(esc).join('|')})(?![\\p{L}\\p{N}_])`, 'gu');
  } catch {
    outRe = inRe = null;
  }
  const swap = (s: string, re: RegExp | null, look: (n: string) => string) => (re && s ? s.replace(re, (_m, pre: string, n: string) => pre + look(n)) : s);
  const walk = (o: any, fn: (s: string) => string, strip: Set<string> | null): any => {
    if (typeof o === 'string') return fn(o);
    if (Array.isArray(o)) return o.map((x) => walk(x, fn, strip));
    if (o && typeof o === 'object') {
      const r: any = {};
      for (const k of Object.keys(o)) if (!(strip && strip.has(k))) r[k] = walk(o[k], fn, strip);
      return r;
    }
    return o;
  };
  const anonymise = cfg.anonymise !== false;
  const send_values = cfg.send_values !== false;
  return {
    anonymise,
    send_values,
    aliases,
    out<T>(x: T, valueKeys?: string[]): T {
      const strip = !send_values && valueKeys?.length ? new Set(valueKeys) : null;
      return walk(x, anonymise ? (s) => swap(s, outRe, (n) => byText.get(n.toLowerCase()) ?? n) : (s) => s, strip);
    },
    back<T>(x: T): T {
      return walk(x, (s) => swap(s, inRe, (a) => shown.get(a) ?? a), null);
    },
  };
}

/**
 * The stored AI switches (imexLlm on the configuration asset) for the privacy setting: the iMEX side menu's copy when it
 * is on the page (window.__imxLlmVal, pushed over the WebSocket), else `read()` (one attribute read). Resolves to the
 * stored value, null when there is none, or UNREADABLE when the read fails.
 */
export async function storedSwitches(read: () => Promise<unknown>): Promise<unknown> {
  const w = typeof window !== 'undefined' ? (window as any) : null;
  if (w && w.__imxLlmVal !== undefined) return w.__imxLlmVal;
  try {
    const v = await read();
    return v === undefined ? null : v;
  } catch {
    return UNREADABLE;
  }
}

/** The stored AI switches, read for the privacy setting (see storedSwitches): the side menu's configuration asset when it
 * is on the page (one attribute read), else the asset named "System Configuration" (one Entity Data Query). */
export async function readSwitches(): Promise<unknown> {
  return storedSwitches(async () => {
    const app = typeof window !== 'undefined' ? (window as any).__imexApp?.asset : null;
    if (app?.id) {
      const id = typeof app.id === 'string' ? app.id : app.id.id;
      const a = await api.getAttrs({ id, entityType: 'ASSET' }, ['imexLlm']);
      return a.imexLlm ?? null;
    }
    const r = await api.post<any>('/api/entitiesQuery/find', {
      entityFilter: { type: 'entityName', entityType: 'ASSET', entityNameFilter: 'System Configuration' },
      pageLink: { page: 0, pageSize: 10 },
      entityFields: [{ type: 'ENTITY_FIELD', key: 'name' }],
      latestValues: [{ type: 'SERVER_ATTRIBUTE', key: 'imexLlm' }],
    });
    const hit = (r?.data ?? []).find((d: any) => d?.latest?.ENTITY_FIELD?.name?.value === 'System Configuration');
    const v = hit?.latest?.SERVER_ATTRIBUTE?.imexLlm;
    return v && v.ts > 0 && v.value !== '' ? v.value : null;
  });
}
