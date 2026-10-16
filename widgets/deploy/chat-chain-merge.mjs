// The chat relay chain on the server (deploy-node.mjs --target=server): a 3-way merge of rule-chain metadata, by node
// NAME, so the developers' hand edits on the server survive our update. Pure (no REST); tested by
// chat-chain-selftest.mjs.
//
//   base   = the chain as WE last left it on the server (mirror-data/target-chat-chain.json after a --go; for the
//            first run the server's own backup from the 7/8 Oct migration, --base=<file>)
//   server = the chain on the server now
//   ours   = DBB_CHAT_CHAIN(...) (deploy-browser.js) for the server
// Per node: unchanged on the server since base -> ours; changed on the server and not by us -> the server's (their
// edit stays); changed on both sides differently -> CONFLICT (nothing is written until it is resolved with
// --take-ours=<node,...> or --keep-server=<node,...>). A node they added stays, with its links; a node they deleted
// stays deleted unless we changed it too (conflict). Links: 3-way as a set (a link is kept when neither side removed
// it). Compared per node: type, configurationVersion, configuration, singletonMode, queueName. Not compared: ids,
// layout (the server's is kept), debug settings (always off: the LLM key and the user's request pass through, D-066).

/** Stable JSON (sorted keys). */
export function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}
const cmpOf = (n) => ({ type: n.type, configurationVersion: n.configurationVersion || 0, configuration: n.configuration || {}, singletonMode: !!n.singletonMode, queueName: n.queueName || null });
const linkKey = (from, type, to) => JSON.stringify([from, type, to]);

/** Metadata ({ nodes, connections, firstNodeIndex }) -> { nodes: Map name -> node, cmp: Map name -> canon, links: Set, first }. */
export function normalise(meta) {
  if (!meta || !Array.isArray(meta.nodes)) throw new Error('not rule-chain metadata (no nodes)');
  const nodes = new Map(), cmp = new Map(), dup = [];
  for (const n of meta.nodes) {
    if (nodes.has(n.name)) dup.push(n.name);
    nodes.set(n.name, n);
    cmp.set(n.name, canon(cmpOf(n)));
  }
  if (dup.length) throw new Error(`node names are not unique (${[...new Set(dup)].join(', ')}): the merge goes by name`);
  const links = new Set();
  for (const c of meta.connections || []) {
    const f = meta.nodes[c.fromIndex], t = meta.nodes[c.toIndex];
    if (f && t) links.add(linkKey(f.name, c.type, t.name));
  }
  const first = meta.firstNodeIndex != null && meta.nodes[meta.firstNodeIndex] ? meta.nodes[meta.firstNodeIndex].name : null;
  return { nodes, cmp, links, first, order: meta.nodes.map((n) => n.name) };
}

/** The chat chain's metadata in a backup / record file: { metadata }, { meta }, a rule-chains.json list, or bare metadata. */
export function metadataFromFile(j, chainName) {
  if (Array.isArray(j)) {
    const e = j.find((x) => ((x && (x.ruleChain || x.rc)) || x || {}).name === chainName);
    if (!e) throw new Error(`no rule chain "${chainName}" in the file`);
    return e.metadata || e.meta;
  }
  if (j && j.metadata && j.metadata.nodes) return j.metadata;
  if (j && j.meta && j.meta.nodes) return j.meta;
  if (j && Array.isArray(j.nodes)) return j;
  throw new Error('no rule-chain metadata in the file');
}

const strip = (n) => {
  const o = { type: n.type, name: n.name, configurationVersion: n.configurationVersion || 0, configuration: n.configuration, additionalInfo: n.additionalInfo };
  if (n.singletonMode) o.singletonMode = true;
  if (n.queueName) o.queueName = n.queueName;
  return o;
};

/**
 * 3-way merge. base may be null (no record: everything that differs is overwritten with ours, and the caller must not
 * write without a base). resolve: { [nodeName]: 'ours' | 'server' }.
 * Returns { metadata: { nodes, connections, firstNodeIndex }, actions: [{ name, action, from }], links: { added, removed },
 * conflicts: [name], debugOn: [name], changed: boolean } (changed = the result differs from the server).
 */
export function merge3({ base, server, ours, resolve = {} }) {
  const names = [...ours.order, ...server.order.filter((n) => !ours.nodes.has(n))];
  if (base) for (const n of base.order) if (!names.includes(n)) names.push(n);
  const actions = [], conflicts = [], picked = new Map();
  for (const name of names) {
    const b = base ? base.cmp.get(name) : undefined, s = server.cmp.get(name), o = ours.cmp.get(name);
    let from;
    if (s === o) from = s === undefined ? null : 'same';
    else if (!base) from = 'ours';
    else if (s === b) from = 'ours';
    else if (o === b) from = 'server';
    else if (resolve[name] === 'ours' || resolve[name] === 'server') from = resolve[name];
    else { from = 'conflict'; conflicts.push(name); }
    if (from === null) continue;
    // the node that goes into the result (none = it is left out); a conflict keeps ours here, but nothing is written
    const node = from === 'server' ? server.nodes.get(name) : from === 'same' ? ours.nodes.get(name) || server.nodes.get(name) : ours.nodes.get(name);
    let action;
    if (from === 'same') action = 'same';
    else if (from === 'conflict') action = 'CONFLICT';
    else if (from === 'server') action = resolve[name] === 'server' ? 'kept (--keep-server)' : s === undefined ? 'kept deleted (deleted on the server)' : b === undefined ? 'kept (added on the server)' : 'kept (hand edit on the server)';
    else action = (s === undefined ? 'add' : o === undefined ? 'remove' : 'update') + (resolve[name] === 'ours' && base && s !== b ? ' (--take-ours)' : '');
    actions.push({ name, action, from });
    if (node) {
      const out = strip(node);
      // the server's layout where the server has the node (the developers may have moved it)
      if (server.nodes.has(name) && server.nodes.get(name).additionalInfo) out.additionalInfo = server.nodes.get(name).additionalInfo;
      out.debugSettings = { failuresEnabled: false, allEnabled: false, allEnabledUntil: 0 };
      picked.set(name, out);
    }
  }
  // links: 3-way as a set; without a base, ours
  const all = new Set([...(base ? base.links : []), ...server.links, ...ours.links]);
  const keep = [];
  for (const l of all) {
    const inB = !!base && base.links.has(l), inS = server.links.has(l), inO = ours.links.has(l);
    const on = !base ? inO : inB ? inS && inO : inS || inO;
    if (on) keep.push(l);
  }
  const list = names.filter((n) => picked.has(n)).map((n) => picked.get(n));
  const index = new Map(list.map((n, i) => [n.name, i]));
  const connections = [];
  for (const l of keep) {
    const [f, type, t] = JSON.parse(l);
    if (index.has(f) && index.has(t)) connections.push({ fromIndex: index.get(f), toIndex: index.get(t), type });
  }
  let first = ours.first;
  if (base && server.first !== base.first && ours.first === base.first && index.has(server.first)) first = server.first;
  const finalLinks = new Set(connections.map((c) => linkKey(list[c.fromIndex].name, c.type, list[c.toIndex].name)));
  const added = [...finalLinks].filter((l) => !server.links.has(l)).map((l) => JSON.parse(l));
  const removed = [...server.links].filter((l) => !finalLinks.has(l)).map((l) => JSON.parse(l));
  const debugOn = [...server.nodes.values()].filter((n) => n.debugSettings && (n.debugSettings.allEnabled || n.debugSettings.failuresEnabled || n.debugSettings.allEnabledUntil > Date.now())).map((n) => n.name);
  const changed = actions.some((a) => a.action !== 'same' && !a.action.startsWith('kept')) || added.length > 0 || removed.length > 0 || first !== server.first || debugOn.length > 0;
  return { metadata: { nodes: list, connections, firstNodeIndex: index.get(first) ?? 0 }, actions, links: { added, removed }, conflicts, debugOn, changed };
}

// ---- printing (a key-like value is never printed)
const KEYLIKE = /sk-ant-[A-Za-z0-9_-]{10,}|\bsk-[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30,}|\bAQ\.[A-Za-z0-9_-]{20,}|eyJhbGciOi[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
export const mask = (s) => String(s).replace(KEYLIKE, '<key masked>');

function flat(v, path, out) {
  if (v && typeof v === 'object' && !Array.isArray(v)) { for (const k of Object.keys(v).sort()) flat(v[k], path ? path + '.' + k : k, out); return out; }
  out.set(path, typeof v === 'string' ? v : JSON.stringify(v === undefined ? null : v));
  return out;
}
/** Line diff (LCS) of two texts: '- ' / '+ ' lines with 1 line of context, at most `max` lines. */
export function lineDiff(a, b, max = 60) {
  const A = String(a).split('\n'), B = String(b).split('\n');
  const n = A.length, m = B.length;
  const T = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) T[i][j] = A[i] === B[j] ? T[i + 1][j + 1] + 1 : Math.max(T[i + 1][j], T[i][j + 1]);
  const ops = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) { ops.push(['  ', A[i]]); i++; j++; }
    else if (i < n && (j >= m || T[i + 1][j] >= T[i][j + 1])) { ops.push(['- ', A[i]]); i++; }
    else { ops.push(['+ ', B[j]]); j++; }
  }
  const show = ops.map((o, k) => o[0] !== '  ' || (ops[k - 1] && ops[k - 1][0] !== '  ') || (ops[k + 1] && ops[k + 1][0] !== '  '));
  const out = [];
  ops.forEach((o, k) => { if (show[k]) out.push(o[0] + o[1]); else if (out.length && out[out.length - 1] !== '  ...') out.push('  ...'); });
  return out.length > max ? [...out.slice(0, max), `  ... (${out.length - max} more lines)`] : out;
}
/** What differs between two versions of a node (a = from, b = to), as printable lines. */
export function nodeDiff(a, b) {
  if (!a) return ['  (new node) ' + mask(b.type)];
  if (!b) return ['  (removed)'];
  const fa = flat(cmpOf(a), '', new Map()), fb = flat(cmpOf(b), '', new Map());
  const out = [];
  for (const k of [...new Set([...fa.keys(), ...fb.keys()])]) {
    const x = fa.get(k), y = fb.get(k);
    if (x === y) continue;
    if ((x || '').includes('\n') || (y || '').includes('\n')) { out.push(`  ${k}:`); for (const l of lineDiff(x ?? '', y ?? '')) out.push('    ' + mask(l)); }
    else out.push(`  ${k}: ${mask(x ?? '(none)')} -> ${mask(y ?? '(none)')}`);
  }
  return out;
}
