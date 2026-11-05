/**
 * Form controls of the builder's right panel (D-033).
 *
 * - `sectionize(form, scope)`: turns a flat form whose groups start with `<div class="dbb-sec">`
 *   headers into collapsible section cards. Collapsed state is kept per scope + title for the
 *   page's lifetime, so it survives the panel re-rendering after every edit.
 * - `picker(host, options)`: searchable dropdown with checkboxes (multi) or a single choice, used
 *   for properties and specific machines instead of long radio / checkbox lists.
 *
 * Both are built from plain elements with their own classes (`.dbb-grp*`, `.dbb-pk*`, styled in
 * builder/styles.ts) and no native checkboxes or radios, so host page CSS (ThingsBoard, app
 * themes) can't restyle them.
 */
import { esc } from '../render/theme';

const collapsed = new Set<string>();
// Check mark and dot are real elements, not ::before/::after, so pages that hide pseudo-elements don't break them.
const TICK = '<svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 6.2l2.3 2.3 4.7-5"/></svg>';
// the app's "calculated" mark (App UI _shared/machine.js calcMark): the same icon
const CALC = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M10 20c1.6 0 2.3-1.4 2.7-3.6l1.6-8.8C14.7 5.4 15.5 4 17.5 4"/><path d="M8.5 10.5h7"/></svg>';
const calcMark = (i: PickItem) => (i.calc ? ` <span class="calc" role="img" aria-label="Calculated value" title="${esc(i.calc)}">${CALC}</span>` : '');
const CHEV = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';

/**
 * Wraps each `.dbb-sec` header of `form` and the elements after it (up to the next header, or an
 * element marked `data-nosec`) into a section card with a clickable header. Elements before the
 * first header and from a `data-nosec` element on stay outside. Moves the existing nodes, so
 * event listeners wired before the call keep working.
 * A header "2 · Properties" gets the number as a badge.
 * @param scope Distinguishes the tabs, e.g. 'widget', 'style', 'theme'.
 */
export function sectionize(form: HTMLElement, scope: string) {
  let body: HTMLElement | null = null;
  for (const k of [...form.children] as HTMLElement[]) {
    if (k.classList.contains('dbb-sec')) {
      const raw = (k.textContent ?? '').trim();
      const m = /^(\d+)\s*·\s*(.+)$/.exec(raw);
      const title = m ? m[2] : raw;
      const id = `${scope}:${title}`;
      const grp = document.createElement('div');
      grp.className = `dbb-grp${collapsed.has(id) ? ' shut' : ''}`;
      grp.dataset.grp = title;
      grp.innerHTML = `<button type="button" class="dbb-grp-h" aria-expanded="${!collapsed.has(id)}">${m ? `<span class="n">${esc(m[1])}</span>` : ''}<span class="t">${esc(title)}</span><span class="c">${CHEV}</span></button><div class="dbb-grp-b"></div>`;
      const h = grp.firstElementChild as HTMLButtonElement;
      h.onclick = () => {
        const shut = grp.classList.toggle('shut');
        h.setAttribute('aria-expanded', String(!shut));
        shut ? collapsed.add(id) : collapsed.delete(id);
      };
      k.replaceWith(grp);
      body = grp.lastElementChild as HTMLElement;
    } else if (k.hasAttribute('data-nosec')) body = null;
    else if (body) body.appendChild(k);
  }
}

/** One choice of a picker. */
export interface PickItem {
  value: string;
  label: string;
  /** Secondary text on the right (unit, machine type). */
  sub?: string;
  /** Can't be chosen; `why` is the tooltip. A selected item is never disabled. */
  disabled?: boolean;
  why?: string;
  /** Small grey tag after the label (e.g. "text" for a property that can't be charted). */
  tag?: string;
  /** D-077: a calculated value (App UI U-128): the app's "calculated" icon after the label, this text as its tooltip
   * ("Calculated: Motor power = Motor Power × 1.341"); "calculated" also finds it in the search. */
  calc?: string;
}

export interface PickOptions {
  items: PickItem[];
  selected: string[];
  /** Checkboxes (true) or a single choice that closes the list (false). */
  multi: boolean;
  /** Multi only: at most this many; further rows are greyed out. */
  max?: number;
  placeholder: string;
  /** Singular / plural noun for the summary and search box, e.g. ['property', 'properties']. */
  noun: [string, string];
  /** Called once with the new selection: on pick (single), or when the list closes (multi) if it changed. */
  onChange(values: string[]): void;
  /** data-pk attribute on the host, for tests. */
  name: string;
  /** The list opens in the flow (pushing content down) instead of floating: for dialogs that scroll. */
  inline?: boolean;
}

/**
 * Searchable dropdown. The closed control shows the selection as chips (each with ✕ to remove)
 * or the single value; clicking opens a list with a search box. In multi mode ticks are collected
 * and applied once when the list closes (Done, click outside, Escape, Tab out), so the builder
 * records one undo step and redraws once.
 */
export function picker(host: HTMLElement, o: PickOptions) {
  let sel = [...o.selected];
  let open = false;
  let query = '';
  const byVal = new Map(o.items.map((i) => [i.value, i]));
  host.classList.add('dbb-pk');
  host.classList.toggle('inline', !!o.inline);
  host.dataset.pk = o.name;

  const commit = (v: string[]) => {
    if (o.selected.join('\u0001') !== v.join('\u0001')) o.onChange(v);
  };
  const full = () => o.multi && o.max != null && sel.length >= o.max;
  const rowState = (i: PickItem) => {
    const on = sel.includes(i.value);
    const dis = !on && (!!i.disabled || full());
    const why = !on && i.disabled ? i.why : !on && full() ? `At most ${o.max} ${o.noun[1]}. Remove one first.` : '';
    return { on, dis, why };
  };

  const trigHtml = () => {
    const chosen = sel.map((v) => byVal.get(v) ?? { value: v, label: v });
    const inner = !chosen.length
      ? `<span class="ph">${esc(o.placeholder)}</span>`
      : o.multi
        ? `<span class="chips">${chosen.map((i) => `<span class="chip" title="${esc(i.label)}">${esc(i.label)}<span class="x" role="button" aria-label="Remove ${esc(i.label)}" data-rm="${esc(i.value)}">✕</span></span>`).join('')}</span>`
        : `<span class="one">${esc(chosen[0].label)}${calcMark(chosen[0])}${chosen[0].sub ? ` <span class="sub">${esc(chosen[0].sub)}</span>` : ''}</span>`;
    return `<div class="dbb-pk-trig${open ? ' open' : ''}" role="combobox" tabindex="0" aria-expanded="${open}" aria-haspopup="listbox">${inner}<span class="car">${CHEV}</span></div>`;
  };
  const listHtml = () => {
    // Every word must appear in the label or the secondary text ("pune 1" finds "Pune Compressor 1").
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const rows = o.items.filter((i) => {
      const hay = `${i.label} ${i.sub ?? ''}${i.calc ? ' calculated' : ''}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    return rows.length
      ? rows
          .map((i) => {
            const s = rowState(i);
            return `<div class="dbb-pk-row${s.on ? ' on' : ''}${s.dis ? ' dis' : ''}" role="option" aria-selected="${s.on}" aria-disabled="${s.dis}" tabindex="-1" data-v="${esc(i.value)}" ${s.why ? `title="${esc(s.why)}"` : ''}>${o.multi ? `<span class="box">${TICK}</span>` : '<span class="dot"><span></span></span>'}<span class="l">${esc(i.label)}${calcMark(i)}${i.tag ? ` <span class="tag">${esc(i.tag)}</span>` : ''}</span>${i.sub ? `<span class="sub">${esc(i.sub)}</span>` : ''}</div>`;
          })
          .join('')
      : `<div class="dbb-pk-none">No ${esc(o.noun[1])} match “${esc(query)}”.</div>`;
  };
  const footHtml = () =>
    o.multi
      ? `<div class="dbb-pk-f"><span>${sel.length}${o.max != null ? ` of ${o.max}` : ''} selected</span><span class="grow"></span>${sel.length ? '<button type="button" data-clear>Clear</button>' : ''}<button type="button" class="done" data-done>Done</button></div>`
      : '';

  const render = () => {
    host.innerHTML =
      trigHtml() +
      (open
        ? `<div class="dbb-pk-pop" role="listbox" aria-multiselectable="${o.multi}">${o.items.length > 4 ? `<div class="dbb-pk-s"><input type="text" placeholder="Search ${esc(o.noun[1])}…" value="${esc(query)}" aria-label="Search ${esc(o.noun[1])}"/></div>` : ''}<div class="dbb-pk-list">${listHtml()}</div>${footHtml()}</div>`
        : '');
    wire();
  };
  const refreshList = () => {
    const list = host.querySelector('.dbb-pk-list');
    if (list) list.innerHTML = listHtml();
    const f = host.querySelector('.dbb-pk-f');
    if (f) f.outerHTML = footHtml();
    const t = host.querySelector('.dbb-pk-trig');
    if (t) t.outerHTML = trigHtml();
    wire(false);
  };

  const close = (apply = true) => {
    if (!open) return;
    open = false;
    query = '';
    document.removeEventListener('mousedown', onDoc, true);
    document.removeEventListener('keydown', onKey, true);
    render();
    if (apply) commit(sel);
  };
  const onDoc = (e: MouseEvent) => {
    if (!host.isConnected) return cleanup();
    if (!host.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (!host.isConnected) return cleanup();
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
      (host.querySelector('.dbb-pk-trig') as HTMLElement)?.focus();
    }
  };
  const cleanup = () => {
    document.removeEventListener('mousedown', onDoc, true);
    document.removeEventListener('keydown', onKey, true);
  };
  const toggle = (v: string) => {
    const i = byVal.get(v);
    if (!i) return;
    const s = rowState(i);
    if (s.dis) return;
    if (!o.multi) {
      sel = [v];
      close();
      return;
    }
    sel = s.on ? sel.filter((x) => x !== v) : [...sel, v];
    const hadFocus = (document.activeElement as HTMLElement | null)?.classList.contains('dbb-pk-row');
    refreshList();
    if (hadFocus) [...host.querySelectorAll<HTMLElement>('.dbb-pk-row')].find((r) => r.dataset.v === v)?.focus();
  };
  const rows = () => [...host.querySelectorAll<HTMLElement>('.dbb-pk-row:not(.dis)')];

  const wire = (full = true) => {
    const trig = host.querySelector('.dbb-pk-trig') as HTMLElement;
    trig.onclick = (e) => {
      const rm = (e.target as HTMLElement).closest('[data-rm]') as HTMLElement | null;
      if (rm) {
        e.stopPropagation();
        sel = sel.filter((x) => x !== rm.dataset.rm);
        if (open) refreshList();
        else {
          render();
          commit(sel);
        }
        return;
      }
      if (open) close();
      else {
        open = true;
        render();
        document.addEventListener('mousedown', onDoc, true);
        document.addEventListener('keydown', onKey, true);
        const inp = host.querySelector<HTMLInputElement>('.dbb-pk-s input');
        (inp ?? rows()[0])?.focus();
        host.querySelector('.dbb-pk-pop')?.scrollIntoView?.({ block: 'nearest' });
      }
    };
    trig.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault();
        if (!open) trig.click();
      }
    };
    host.querySelectorAll<HTMLElement>('.dbb-pk-row').forEach((r) => {
      r.onmousedown = (e) => e.preventDefault(); // keep focus in the search box
      r.onclick = () => toggle(r.dataset.v!);
      r.onkeydown = (e) => {
        const rs = rows();
        const ix = rs.indexOf(r);
        if (e.key === 'ArrowDown') (e.preventDefault(), rs[ix + 1]?.focus());
        else if (e.key === 'ArrowUp') (e.preventDefault(), (rs[ix - 1] ?? host.querySelector<HTMLElement>('.dbb-pk-s input'))?.focus());
        else if (e.key === 'Enter' || e.key === ' ') (e.preventDefault(), toggle(r.dataset.v!));
        else if (e.key === 'Tab') close();
      };
    });
    host.querySelector<HTMLElement>('[data-done]')?.addEventListener('click', () => close());
    host.querySelector<HTMLElement>('[data-clear]')?.addEventListener('click', () => {
      sel = [];
      refreshList();
    });
    if (!full) return;
    const inp = host.querySelector<HTMLInputElement>('.dbb-pk-s input');
    if (inp) {
      inp.oninput = () => {
        query = inp.value;
        refreshList();
      };
      inp.onkeydown = (e) => {
        if (e.key === 'ArrowDown') (e.preventDefault(), rows()[0]?.focus());
        else if (e.key === 'Enter') {
          e.preventDefault();
          const r = rows()[0];
          if (r) toggle(r.dataset.v!);
        } else if (e.key === 'Tab') close();
      };
    }
  };
  render();
}
