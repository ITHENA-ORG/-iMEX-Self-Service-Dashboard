// Crew roster core (core/crew.ts, D-096): runs every vector in crew-vectors.json (byte-identical copy of the App UI's
// tests/crew-vectors.json, the contract shared with the JavaScript core widgets/_shared/crew.js) with the real shift
// calendar (core/shiftcal.ts).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as C from '../src/core/crew';
import { calendar } from '../src/core/shiftcal';

const V: any = JSON.parse(readFileSync(new URL('./crew-vectors.json', import.meta.url), 'utf8'));
const plain = (x: unknown) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
const iso = (t: number) => new Date(t).toISOString().replace('.000Z', 'Z');
const normRows = (list: any[]) => list.map((r) => ({ ...r, start: iso(Date.parse(r.start)), end: iso(Date.parse(r.end)) }));

function run(c: any, q: any): unknown {
  const doc = c.doc === undefined ? (null as any) : C.parse(c.doc);
  const chain = q.meaning === false ? null : c.chain;
  const o = { chain };
  switch (q.fn) {
    case 'parse':
      return plain(C.parse(q.raw));
    case 'planOf':
      return plain(C.planOf(doc, q.site, q.user, q.day));
    case 'roleOf':
      return C.roleOf(doc, q.site, q.user);
    case 'team':
      return plain(C.team(doc, q.site, q.day));
    case 'people':
      return plain(C.people(doc, q.site));
    case 'crewOn':
      return plain(C.crewOn(doc, q.site, q.day, q.shift, o));
    case 'coverage':
      return plain(C.coverage(doc, q.site, q.day, q.shift, o));
    case 'reassign':
      return plain(C.reassign(doc, q.site, q.user, q.day, o));
    case 'onShift': {
      const cal = calendar({ chain: c.chain, tz: c.tz });
      return C.onShift(q.site, Date.parse(q.ts), { doc, calendar: cal as any, chain }).map((r) => ({ ...r, start: iso(r.start), end: iso(r.end) }));
    }
    case 'sameShift':
      return C.sameShift(q.a, q.b);
    case 'isManager':
      return C.isManager(q.r);
    case 'abbr':
      return plain(C.abbr(q.roles));
    default:
      throw new Error('unknown fn ' + q.fn);
  }
}

describe('crew vectors (shared contract)', () => {
  let total = 0;
  for (const c of V.cases) {
    total += c.queries.length;
    it(c.name, () => {
      c.queries.forEach((q: any, i: number) => {
        const exp = q.fn === 'onShift' ? normRows(q.expect) : q.expect;
        expect(run(c, q), `${c.name} #${i + 1} ${q.fn}`).toEqual(exp);
      });
    });
  }
  it('the vectors are all there', () => expect(total).toBeGreaterThanOrEqual(70));
});

describe('crew core: what the vectors do not pin', () => {
  it('parse never shares the default roles', () => {
    const a = C.parse(null);
    a.roles[0].name = 'changed';
    expect(C.parse(null).roles[0].name).toBe('Primary operator');
  });
  it('dayNum / dayStr / weekday', () => {
    expect(C.dayStr(C.dayNum('2026-11-19')!)).toBe('2026-11-19');
    expect(C.dayNum('2026-02-30')).toBeNull();
    expect(C.weekday('2026-11-19')).toBe(4);
  });
  it('onShift without a calendar or a doc is empty', () => {
    expect(C.onShift('s', Date.now(), { doc: null, calendar: null })).toEqual([]);
    expect(C.onShift('s', Date.now(), { doc: C.parse(null), calendar: null })).toEqual([]);
  });
});
