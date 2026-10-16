// Role core (core/perm.ts): runs every section of perm-vectors.json (byte-identical copy of the App UI's
// tests/perm-vectors.json, the contract shared with the JavaScript and Python copies), plus a few unit checks.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as P from '../src/core/perm';
import * as A from '../src/core/access';

const V: any = JSON.parse(readFileSync(new URL('./perm-vectors.json', import.meta.url), 'utf8'));
const plain = (x: any) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
const eff = (r: any) => P.effective(r === 'unrestricted' ? 'unrestricted' : r);
const tree = A.makeTree(V.tree);
const accessOf = (e: any) => (e === 'unrestricted' ? A.unrestricted() : A.resolveTree(e, tree));

describe('perm vectors (every runtime)', () => {
  it('the catalogue and the built-ins', () => {
    expect(plain(P.CATALOGUE.map((r) => ({ key: r.key, section: r.section, states: r.states, levels: r.levels, actions: r.actions.map((a) => a.id) })))).toEqual(V.catalogue);
    expect(plain(P.ACTIONS)).toEqual(V.actions);
    expect(plain(P.RESERVED)).toEqual(V.reserved);
    const b = P.BUILTINS();
    expect(plain(b[0])).toEqual(V.builtins.admin);
    expect(plain(b[1])).toEqual(V.builtins.viewer);
    for (const r of P.CATALOGUE) expect(!!r.label && r.actions.every((a) => !!a.label), `${r.key} has labels`).toBe(true);
  });
  it("the labels follow the app's page names (D-058: the App UI catalogue of 15 Oct 2026)", () => {
    const row = (k: string) => P.CATALOGUE.find((r) => r.key === k)!;
    expect([row('sites').label, row('users').label]).toEqual(['Overview', 'Users & roles']);
    expect([row('alertrules.default').label, row('alertrules.default').parent, row('alertrules.custom').label, row('alertrules.custom').parent]).toEqual(['Default rules', 'Alarm rules', 'Custom rules', 'Alarm rules']);
    expect(row('alertrules.default').actions.map((a) => a.label)).toEqual(['Export alarm rules']);
    // no page or action label says "alert" or "Fleet overview" any more (the app says Alarms / Overview)
    for (const r of P.CATALOGUE) for (const t of [r.label, r.parent ?? '', ...r.actions.map((a) => a.label)]) expect(t, r.key).not.toMatch(/alert|fleet overview/i);
  });
  it('parseStore', () => {
    for (const c of V.parseStore) {
      const s = P.parseStore(c.raw);
      expect(s.source, c.name).toBe(c.expect.source);
      expect(s.rev, c.name).toBe(c.expect.rev);
      expect(plain(s.roles.map((r) => r.id)), c.name).toEqual(c.expect.ids);
      expect(plain(s.warnings), c.name).toEqual(c.expect.warnings);
      for (const [id, r] of Object.entries(c.expect.roles || {})) expect(plain(s.roles.find((x) => x.id === id)), `${c.name}: ${id}`).toEqual(r);
    }
  });
  it('parseUser', () => {
    for (const c of V.parseUser) {
      const u = P.parseUser(c.store, c.user);
      expect({ roleId: u.roleId, source: u.source, warnings: plain(u.warnings) }, c.name).toEqual(c.expect);
      if (u.roleId) expect(u.role!.id, c.name).toBe(u.roleId);
    }
  });
  it('effective', () => {
    for (const c of V.effective) expect(plain(eff(c.role)), c.name).toEqual(c.expect);
  });
  it('page, can, canState', () => {
    for (const c of V.can) {
      const e = eff(c.role);
      for (const [k, v] of Object.entries(c.page)) expect(P.page(e, k), `${c.name}: page ${k}`).toBe(v);
      for (const q of c.can) expect(q.level === undefined ? P.can(e, q.k) : P.can(e, q.k, q.level), `${c.name}: can ${q.k} ${q.level || ''}`).toBe(q.expect);
      for (const [s, v] of Object.entries(c.canState)) expect(P.canState(e, s), `${c.name}: canState ${s}`).toBe(v);
    }
  });
  it('covers', () => {
    for (const c of V.covers) expect(plain(P.covers(eff(c.editor), eff(c.target))), c.name).toEqual(c.expect);
  });
  it('coversScope', () => {
    for (const c of V.coversScope) expect(plain(P.coversScope(accessOf(c.editor), c.grants)), c.name).toEqual(c.expect);
  });
  it('lastAdmin', () => {
    for (const c of V.lastAdmin) {
      const users = c.users.map((u: any) => ({ ...u, eff: eff(V.roles[u.roleId]) }));
      const ch: any = {};
      if (c.change.userId !== undefined) ch.userId = c.change.userId;
      if (c.change.roleId !== undefined) ch.roleId = c.change.roleId;
      if ('newRoleId' in c.change) ch.newEff = c.change.newRoleId === null ? null : eff(V.roles[c.change.newRoleId]);
      if ('newRole' in c.change) ch.newEff = c.change.newRole === null ? null : eff(c.change.newRole);
      if ('enabled' in c.change) ch.enabled = c.change.enabled;
      const r = P.lastAdminCheck(users, ch);
      const exp = { reason: c.expect.ok ? '' : undefined, ...c.expect };
      expect({ ok: r.ok, code: r.code, reason: r.reason }, c.name).toEqual(exp);
    }
  });
  it('validateRole', () => {
    for (const c of V.validateRole) {
      const editor = eff(c.editor === undefined ? V.builtins.admin : c.editor);
      const r = P.validateRole(c.role, V.store1, editor, accessOf(c.editorAccess === undefined ? 'unrestricted' : c.editorAccess));
      expect(plain(r.errors), c.name).toEqual(c.expect.errors);
      if ('missing' in c.expect) expect(plain(r.missing), `${c.name} (missing)`).toEqual(c.expect.missing);
      if ('outside' in c.expect) expect(plain(r.outside), `${c.name} (outside)`).toEqual(c.expect.outside);
      if ('role' in c.expect) expect(plain(r.role), `${c.name} (role)`).toEqual(c.expect.role);
    }
  });
  it('deleteCheck and legacyName', () => {
    for (const c of V.deleteCheck.cases) expect(plain(P.deleteCheck(c.roleId, V.store1, V.deleteCheck.users)), c.name).toEqual(c.expect);
    for (const c of V.legacyName) expect(P.legacyName(c.role), c.name).toBe(c.expect);
  });
});

describe('perm vectors (the JavaScript-only sections, ported too)', () => {
  it('templates and the migration mapping', () => {
    const t = P.TEMPLATES();
    for (const c of V.templates) {
      const r = t.find((x) => x.template === c.template);
      expect(!!r && r.id === null && !r.builtIn, c.name).toBe(true);
      expect(plain(eff(r)), c.name).toEqual(c.expect);
    }
    for (const c of V.migrate) expect(plain(P.migrateRole(c.user, c.opts)), c.name).toEqual(c.expect);
  });
  it('baseKeys and newKeys (S14)', () => {
    expect(plain(P.BASE_KEYS)).toEqual(V.baseKeys);
    for (const c of V.newKeys) expect(plain(P.newKeys(c.role)), c.name).toEqual(c.expect);
  });
});

describe('perm core details', () => {
  it('builderVariant: Dashboards at Full, a new role, the original unchanged', () => {
    const v = P.builderVariant(V.builtins.viewer);
    expect(v.name).toBe('Viewer + Builder');
    expect(v.id).toBeNull();
    expect(v.builtIn).toBe(false);
    const e = eff(v);
    expect(e.pages.dashboards).toBe('full');
    expect(e.actions['dashboards.build'] && e.actions['dashboards.applyMany'] && e.actions['dashboards.deleteAny']).toBe(true);
    expect(e.pages.reports).toBe('view');
    expect(V.builtins.viewer.perms.dashboards).toBe('view');
  });
  it('newRoleId: r_ and 6 base36 characters, never one in use', () => {
    let i = 0;
    const seq = [0, 0, 0, 0, 0, 0, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
    expect(P.newRoleId(['r_000000'], () => seq[i++ % seq.length])).toBe('r_iiiiii');
    expect(P.newRoleId([])).toMatch(/^r_[0-9a-z]{6}$/);
  });
  it('the Builder flags of the built-ins: Admin builds, applies to many, deletes any; Viewer only views', () => {
    const [admin, viewer] = P.BUILTINS().map((r) => eff(r));
    for (const a of ['dashboards.build', 'dashboards.applyMany', 'dashboards.deleteAny']) {
      expect(P.can(admin, a)).toBe(true);
      expect(P.can(viewer, a)).toBe(false);
    }
    expect(P.page(viewer, 'dashboards')).toBe('view');
    expect(P.canState(viewer, 'dashboard_overview')).toBe('view');
    expect(P.canState(viewer, 'user_management')).toBe('hidden');
    expect(P.rowOf('dashboards.build')!.key).toBe('dashboards');
  });
});
