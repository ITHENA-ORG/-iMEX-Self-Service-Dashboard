/**
 * Dashboard Builder sub-editors (DECISIONS D-019, D-020), shown in the builder's right panel:
 * - `richEditor`: WYSIWYG rich text for text widgets and widget descriptions (Settings / Style tab).
 * - `ruleEditor`: value-based colour rules (Colours tab).
 * - `styleEditor`: per-widget card style (Style tab).
 * - `themeEditor`: dashboard theme (Dashboard tab, shown when no widget is selected).
 * - `initialRules`, `CARD_TYPES`: helpers shared with the builder.
 *
 * Runs in the browser inside the builder overlay of a ThingsBoard widget. Each editor renders
 * into a `host` element it fully owns (its `innerHTML` is replaced), wires its own events, and
 * reports changes through callbacks. The editors never write the dashboard themselves:
 * `builder/builder.ts` applies the change to its draft (with undo) and usually re-renders the
 * right panel, which calls the editor again with fresh data. So an editor instance lives only
 * until the next change; keep no long-lived state in it.
 *
 * Dependencies: `render/rich.ts` (sanitising), `render/rules.ts` (value types, rule matching,
 * legacy bands), `render/theme.ts` (swatches, presets, font loading), `render/icons.ts`,
 * and constants / types from `core/schema.ts`.
 *
 * All user-entered text that goes into markup is escaped with `esc`; rich text is sanitised.
 */
import type { ColorRule, RuleOp, CardStyle, DashboardTheme, Widget } from '../core/schema';
import { RULE_OP_LABELS, ICONS, FONTS, THEME_PRESETS } from '../core/schema';
import type { KeyMeta } from '../core/types';
import { esc, SWATCHES, PRESETS, loadFont, STATUS, safeUrl, appDarkMode } from '../render/theme';
import { sanitizeHtml } from '../render/rich';
import { valueType, ValueType, matchRule, bandsToRules } from '../render/rules';
import { ICON_SVG, ICON_TITLE } from '../render/icons';
import { sectionize } from './controls';

/** Wraps path data in a 24x24 stroke icon for the rich-text toolbar. */
const I = (d: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const TB_ICONS: Record<string, string> = {
  bold: '<b style="font-size:14px">B</b>',
  italic: '<i style="font-family:Georgia,serif;font-size:14px">I</i>',
  underline: '<u style="font-size:14px">U</u>',
  strike: '<s style="font-size:14px">S</s>',
  left: I('<path d="M4 6h16M4 10h10M4 14h16M4 18h10"/>'),
  center: I('<path d="M4 6h16M7 10h10M4 14h16M7 18h10"/>'),
  right: I('<path d="M4 6h16M10 10h10M4 14h16M10 18h10"/>'),
  ul: I('<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>'),
  ol: I('<path d="M10 6h10M10 12h10M10 18h10"/><path d="M4 5l1.5-1V9M3.5 13.5a1.5 1.5 0 0 1 3 .5c0 1-3 2-3 3h3"/>'),
  link: I('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
  clear: I('<path d="M5 5h12M11 5l-4 14M15 13l6 6M21 13l-6 6"/>'),
  quote: I('<path d="M7 7h4v4c0 3-2 5-4 6M15 7h4v4c0 3-2 5-4 6"/>'),
};

// ---------------------------------------------------------------- rich text

/** Options for `richEditor`. */
export interface RichOptions {
  /** Initial HTML (sanitised before it is shown). */
  html: string;
  /** Keys offered in the "+ Live value" menu; inserted as `{{key}}`. Menu hidden when empty. */
  placeholders?: { key: string; label: string }[];
  /** Editing area min height in px (default 110). */
  minHeight?: number;
  /** Receives sanitised HTML, only when it differs from the last value sent. */
  onChange(html: string): void;
}

/**
 * WYSIWYG editor built on `contenteditable` + `document.execCommand` (deprecated but still the
 * only no-dependency way to get browser-native formatting; there is no framework in the bundle,
 * D-010). Commits sanitised HTML 500 ms after the last input and immediately on blur.
 * Pasted HTML is sanitised before insertion. Links are limited to http(s) and mailto.
 * @param host Element to render into (contents replaced).
 * @returns `{ flush }`: commits any pending (debounced) change immediately. Blur already does
 *   this, so the builder currently doesn't need to call it.
 */
export function richEditor(host: HTMLElement, o: RichOptions) {
  host.innerHTML = `<div class="dbb-rte">
    <div class="dbb-rte-bar">
      <select data-rc="block" title="Paragraph style"><option value="p">Paragraph</option><option value="h1">Heading 1</option><option value="h2">Heading 2</option><option value="h3">Heading 3</option><option value="blockquote">Quote</option></select>
      <select data-rc="font" title="Font"><option value="">Font</option>${FONTS.map((f) => `<option value="${f}" style="font-family:'${f}'">${f}</option>`).join('')}</select>
      <select data-rc="size" title="Size"><option value="">Size</option>${[11, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48].map((n) => `<option value="${n}">${n}</option>`).join('')}</select>
      <span class="sep"></span>
      <button data-rc="bold" title="Bold (Ctrl+B)">${TB_ICONS.bold}</button><button data-rc="italic" title="Italic (Ctrl+I)">${TB_ICONS.italic}</button><button data-rc="underline" title="Underline (Ctrl+U)">${TB_ICONS.underline}</button><button data-rc="strikeThrough" title="Strikethrough">${TB_ICONS.strike}</button>
      <label class="dbb-rte-col" title="Text colour"><span style="border-bottom:3px solid #d03b3b">A</span><input type="color" data-rc="foreColor" value="#d03b3b"/></label>
      <label class="dbb-rte-col" title="Highlight"><span style="background:#fde68a;padding:0 3px;border-radius:3px">H</span><input type="color" data-rc="hiliteColor" value="#fde68a"/></label>
      <span class="sep"></span>
      <button data-rc="justifyLeft" title="Align left">${TB_ICONS.left}</button><button data-rc="justifyCenter" title="Centre">${TB_ICONS.center}</button><button data-rc="justifyRight" title="Align right">${TB_ICONS.right}</button>
      <button data-rc="insertUnorderedList" title="Bulleted list">${TB_ICONS.ul}</button><button data-rc="insertOrderedList" title="Numbered list">${TB_ICONS.ol}</button>
      <button data-rc="link" title="Link">${TB_ICONS.link}</button><button data-rc="removeFormat" title="Clear formatting">${TB_ICONS.clear}</button>
      ${
        o.placeholders?.length
          ? `<select data-rc="ph" title="Insert a live value"><option value="">+ Live value</option>${o.placeholders.map((p) => `<option value="${esc(p.key)}">${esc(p.label)}</option>`).join('')}</select>`
          : ''
      }
    </div>
    <div class="dbb-rte-link" hidden><input placeholder="https://…" data-l/><button class="dbb-btn sm primary" data-lok>Add link</button><button class="dbb-btn sm" data-lx>Cancel</button></div>
    <div class="dbb-rte-ed dbb-md" contenteditable="true" spellcheck="true" style="min-height:${o.minHeight ?? 110}px">${sanitizeHtml(o.html)}</div>
  </div>`;
  const ed = host.querySelector('.dbb-rte-ed') as HTMLElement;
  // Last selection inside the editor. Toolbar selects/inputs take focus and lose the selection,
  // so it is saved on every key/mouse up and restored before each command.
  let saved: Range | null = null;
  let t: any = null;
  let last = sanitizeHtml(o.html);
  const commit = () => {
    clearTimeout(t);
    const html = sanitizeHtml(ed.innerHTML);
    if (html !== last) {
      last = html;
      o.onChange(html);
    }
  };
  const later = () => {
    clearTimeout(t);
    t = setTimeout(commit, 500);
  };
  const keep = () => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && ed.contains(sel.anchorNode)) saved = sel.getRangeAt(0).cloneRange();
  };
  const restore = () => {
    ed.focus();
    if (saved) {
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(saved);
    }
  };
  /**
   * Runs an execCommand on the restored selection, then schedules a commit.
   * @param css true → browser writes `<span style>` instead of `<font>`/`<b>` where it can.
   */
  const exec = (cmd: string, val?: string, css = true) => {
    restore();
    try {
      document.execCommand('styleWithCSS', false, css as any);
    } catch {
      /* old browsers */
    }
    document.execCommand(cmd, false, val);
    keep();
    later();
  };
  ed.addEventListener('keyup', keep);
  ed.addEventListener('mouseup', keep);
  ed.addEventListener('input', later);
  ed.addEventListener('blur', commit);
  ed.addEventListener('paste', (e) => {
    // paste as sanitised HTML
    const html = e.clipboardData?.getData('text/html');
    if (!html) return;
    e.preventDefault();
    document.execCommand('insertHTML', false, sanitizeHtml(html));
  });
  host.querySelectorAll<HTMLButtonElement>('.dbb-rte-bar button').forEach((b) => {
    // Prevent the button from taking focus, which would drop the text selection.
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => {
      const c = b.dataset.rc!;
      if (c === 'link') {
        keep();
        const row = host.querySelector('.dbb-rte-link') as HTMLElement;
        row.hidden = false;
        (row.querySelector('[data-l]') as HTMLInputElement).focus();
        return;
      }
      exec(c);
    });
  });
  const linkRow = host.querySelector('.dbb-rte-link') as HTMLElement;
  linkRow.querySelector('[data-lok]')!.addEventListener('click', () => {
    const v = (linkRow.querySelector('[data-l]') as HTMLInputElement).value.trim();
    linkRow.hidden = true;
    // Same rule as the sanitiser's safeHref; anything else is silently ignored.
    if (/^(https?:\/\/|mailto:)/i.test(v)) exec('createLink', v);
  });
  linkRow.querySelector('[data-lx]')!.addEventListener('click', () => (linkRow.hidden = true));
  host.querySelectorAll<HTMLSelectElement | HTMLInputElement>('.dbb-rte-bar select, .dbb-rte-bar input').forEach((s) => {
    s.addEventListener('mousedown', keep);
    s.addEventListener('focus', keep);
    s.addEventListener(s.tagName === 'INPUT' ? 'input' : 'change', () => {
      const c = s.dataset.rc!;
      const v = s.value;
      if (c === 'block') exec('formatBlock', `<${v}>`);
      else if (c === 'font' && v) {
        loadFont(v);
        exec('fontName', `'${v}'`);
      } else if (c === 'size' && v) {
        // execCommand('fontSize') only knows sizes 1-7. Mark the selection with <font size="7">
        // (CSS mode off so a <font> tag is produced), then swap each marker for a px-sized span.
        exec('fontSize', '7', false);
        const made: HTMLElement[] = [];
        ed.querySelectorAll('font[size="7"]').forEach((f) => {
          const sp = document.createElement('span');
          sp.style.fontSize = `${v}px`;
          while (f.firstChild) sp.appendChild(f.firstChild);
          f.replaceWith(sp);
          made.push(sp);
        });
        if (made.length) {
          // keep the resized text selected so the next toolbar action applies to it
          const r = document.createRange();
          r.setStartBefore(made[0]);
          r.setEndAfter(made[made.length - 1]);
          const sel = window.getSelection()!;
          sel.removeAllRanges();
          sel.addRange(r);
          saved = r.cloneRange();
        }
        later();
      } else if (c === 'foreColor' || c === 'hiliteColor') exec(c, v);
      else if (c === 'ph' && v) exec('insertText', `{{${v}}}`);
      // Font / size / live-value menus act like buttons: reset to their label after use.
      if (s.tagName === 'SELECT' && c !== 'block') (s as HTMLSelectElement).value = '';
    });
  });
  return { flush: commit };
}

// ---------------------------------------------------------------- colour rules

/** Conditions offered per value type; the first is the default when a rule's op doesn't fit. */
const OPS_BY_TYPE: Record<ValueType, RuleOp[]> = {
  number: ['gt', 'gte', 'lt', 'lte', 'between', 'eq', 'neq'],
  boolean: ['isTrue', 'isFalse'],
  string: ['eq', 'neq', 'contains'],
};

/** Options for `ruleEditor`. */
export interface RuleEditorOptions {
  /** The widget being edited (read only; its settings seed the editor). */
  widget: Widget;
  /** Catalogue entries of the widget's keys, in key order. More than one enables per-key rules. */
  metas: KeyMeta[];
  /** Latest sample per key for type inference and the test box. */
  samples?: Record<string, unknown>;
  /**
   * Called on every change with the full rule list (undefined when empty) and, optionally,
   * other settings to set; an `undefined` value in `extra` means "delete that setting".
   */
  onChange(rules: ColorRule[] | undefined, extra?: Partial<Widget['settings']>): void;
}

/** Single-card widget types whose rule colour can target background, accent, value or icon. */
export const CARD_TYPES = new Set(['value', 'kpi', 'gauge', 'progress', 'status', 'summary']);

/**
 * Initial rules for the editor: explicit rules (copied), else legacy bands, else a status
 * widget's legacy `statusMap` as `eq` rules. Nothing is written back until the user edits.
 * @returns A new array the caller may mutate.
 */
export function initialRules(w: Widget): ColorRule[] {
  const s = w.settings;
  if (s.colorRules?.length) return s.colorRules.map((r) => ({ ...r }));
  // The band catch-all (> -Infinity) can't be shown in a number box, so it is left out here;
  // once the user edits, values above the last band get no rule colour.
  if (s.bands?.length) return bandsToRules(s.bands).filter((r) => Number.isFinite(Number(r.value)));
  if (w.type === 'status' && s.statusMap?.length) return s.statusMap.map((m) => ({ op: 'eq' as const, value: m.value, color: m.color, label: m.label }));
  return [];
}

/**
 * Colour-rule editor. The operator list and value box follow the property's value type
 * (`valueType` from rules.ts, from the catalogue and the latest sample): numbers get
 * > >= < <= between = !=, on/off gets is on / is off, text gets equals / not / contains.
 * For a single-key widget the user can override the inferred type with the Number / On-off /
 * Text switch. Multi-key widgets get a per-rule property selector ("Any property" = key-less).
 * Also offers presets (traffic light, running/stopped), the colour target for card widgets,
 * threshold lines for charts, and a "test a value" box that runs `matchRule`.
 * Re-renders its own DOM after structural changes; reports via `o.onChange`.
 */
export function ruleEditor(host: HTMLElement, o: RuleEditorOptions) {
  const w = o.widget;
  const s = w.settings;
  // Working copy, mutated in place by the row handlers (rows are addressed by index).
  let rules = initialRules(w);
  const multi = o.metas.length > 1;
  const metaOf = (k?: string) => o.metas.find((m) => m.key === k) ?? o.metas[0];
  const typeOf = (k?: string): ValueType => {
    const m = metaOf(k);
    return valueType(m, o.samples?.[m?.key ?? '']);
  };
  // Type chosen with the value-type switch (single-key widgets only); lasts for this editor instance.
  let forcedType: Record<string, ValueType> = {};
  const tOf = (k?: string) => forcedType[k ?? metaOf(k)?.key ?? ''] ?? typeOf(k);

  const emit = (extra?: Partial<Widget['settings']>) => o.onChange(rules.length ? rules.map(clean) : undefined, extra);
  /** Strips fields that don't apply to the rule's op (and empty key/label) so saved JSON stays minimal and schema-valid. */
  const clean = (r: ColorRule): ColorRule => {
    const x: any = { ...r };
    if (!x.key) delete x.key;
    if (!x.label) delete x.label;
    if (['isTrue', 'isFalse'].includes(x.op)) {
      delete x.value;
      delete x.value2;
    }
    if (x.op !== 'between') delete x.value2;
    return x;
  };

  /** Rebuilds the whole editor DOM from `rules`, then re-wires events. */
  const render = () => {
    const k0 = multi ? undefined : o.metas[0]?.key;
    const vt = tOf(k0);
    const isCard = CARD_TYPES.has(w.type);
    const isChart = ['line', 'area', 'bar'].includes(w.type);
    host.innerHTML = `<div class="dbb-rules">
      <div class="dbb-hint">Colour ${isCard ? 'this card' : w.type === 'table' || w.type === 'multivalue' ? 'cells' : 'the chart'} by value. The first matching rule wins.</div>
      ${
        !multi && o.metas[0]
          ? `<div class="dbb-seg" role="radiogroup" aria-label="Value type">${(['number', 'boolean', 'string'] as ValueType[])
              .map((t) => `<button data-vt="${t}" class="${t === vt ? 'on' : ''}">${t === 'number' ? '123 Number' : t === 'boolean' ? 'On / off' : 'Abc Text'}</button>`)
              .join('')}</div>`
          : ''
      }
      <div class="dbb-rule-list">${rules.map((r, i) => row(r, i)).join('') || '<div class="dbb-hint" style="text-align:center;padding:8px">No rules yet.</div>'}</div>
      <div class="dbb-row wrap">
        <button class="dbb-btn sm" data-add>+ Add rule</button>
        ${vt === 'number' || multi ? `<button class="dbb-btn sm" data-preset="traffic">Traffic light</button>` : ''}
        ${vt === 'boolean' ? `<button class="dbb-btn sm" data-preset="onoff">Running / stopped</button>` : ''}
        ${rules.length ? `<button class="dbb-btn sm danger" data-clear>Clear</button>` : ''}
      </div>
      ${
        isCard && w.type !== 'gauge'
          ? `<label class="dbb-field"><span>Apply the colour to</span><select data-target>${[
              ['background', 'Card background (tint + bar)'],
              ['accent', 'Accent bar only'],
              ['value', 'Value text'],
              ['icon', 'Title icon'],
            ]
              .map(([v, l]) => `<option value="${v}" ${(s.colorTarget ?? 'background') === v ? 'selected' : ''}>${l}</option>`)
              .join('')}</select></label>`
          : ''
      }
      ${w.type === 'gauge' ? `<label class="dbb-check"><input type="checkbox" data-gv ${s.colorTarget === 'value' ? 'checked' : ''}/> Colour the number too</label>` : ''}
      ${isChart ? `<label class="dbb-check"><input type="checkbox" data-thr ${s.showThresholds !== false ? 'checked' : ''}/> Draw number rules as threshold lines</label>` : ''}
      ${w.type === 'heatmap' ? `<div class="dbb-hint">Set <b>Colours → Use rules</b> in the Widget tab to colour cells by these rules.</div>` : ''}
      <div class="dbb-test"><span>Test a value</span><input data-test placeholder="${vt === 'boolean' ? 'true / 1 / off' : vt === 'number' ? 'e.g. 82' : 'e.g. Fault'}"/><span class="dbb-test-out"></span></div>
    </div>`;
    wire();
  };

  /** Markup for rule `i`. Its type comes from the rule's own key, else the widget's (first) key. */
  const row = (r: ColorRule, i: number) => {
    const t = tOf(r.key ?? (multi ? undefined : o.metas[0]?.key));
    const ops = OPS_BY_TYPE[t];
    // Display-only fallback: the stored op is unchanged until the user picks one.
    const op = ops.includes(r.op) ? r.op : ops[0];
    const valBox =
      t === 'boolean'
        ? ''
        : t === 'number'
          ? `<input type="number" step="any" data-f="value" value="${esc(r.value ?? '')}" placeholder="value"/>${op === 'between' ? `<span class="dbb-muted">and</span><input type="number" step="any" data-f="value2" value="${esc(r.value2 ?? '')}" placeholder="value"/>` : ''}`
          : `<input data-f="value" value="${esc(r.value ?? '')}" placeholder="text"/>`;
    return `<div class="dbb-rule" data-i="${i}">
      <div class="dbb-rule-main">
        ${multi ? `<select data-f="key" title="Property"><option value="">Any property</option>${o.metas.map((m) => `<option value="${esc(m.key)}" ${r.key === m.key ? 'selected' : ''}>${esc(m.displayName)}</option>`).join('')}</select>` : ''}
        <select data-f="op" title="Condition">${ops.map((x) => `<option value="${x}" ${x === op ? 'selected' : ''}>${esc(RULE_OP_LABELS[x])}</option>`).join('')}</select>
        ${valBox}
        <label class="dbb-swatch" title="Colour" style="background:${esc(r.color)}"><input type="color" data-f="color" value="${esc(/^#[0-9a-f]{6}$/i.test(r.color) ? r.color : '#2a78d6')}"/></label>
        <button class="dbb-x" data-del title="Remove rule">✕</button>
      </div>
      <div class="dbb-rule-sub">
        <input data-f="label" value="${esc(r.label ?? '')}" placeholder="Label (optional), e.g. Too hot" maxlength="40"/>
        <span class="dbb-sw-row">${SWATCHES.slice(0, 9).map((c) => `<button data-sw="${c}" style="background:${c}" title="${c}"></button>`).join('')}</span>
      </div>
    </div>`;
  };

  // Debounces colour-picker drags so the canvas isn't redrawn on every pixel.
  let colorTimer: any;
  /** Attaches event handlers to the freshly rendered DOM. */
  const wire = () => {
    host.querySelectorAll<HTMLElement>('[data-vt]').forEach((b) =>
      b.addEventListener('click', () => {
        // Switching type converts every rule's op to one valid for the new type.
        forcedType = { [o.metas[0].key]: b.dataset.vt as ValueType };
        rules = rules.map((r) => ({ ...r, op: OPS_BY_TYPE[b.dataset.vt as ValueType].includes(r.op) ? r.op : OPS_BY_TYPE[b.dataset.vt as ValueType][0] }));
        render();
        if (rules.length) emit();
      }),
    );
    host.querySelectorAll<HTMLElement>('.dbb-rule').forEach((el) => {
      const i = Number(el.dataset.i);
      el.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-f]').forEach((inp) =>
        inp.addEventListener(inp.type === 'color' ? 'input' : 'change', () => {
          const f = inp.dataset.f!;
          if (f === 'color') {
            // Live preview on the swatch without re-rendering (which would close the picker).
            rules[i].color = inp.value;
            (inp.parentElement as HTMLElement).style.background = inp.value;
            clearTimeout(colorTimer);
            colorTimer = setTimeout(() => emit(), 250);
            return;
          }
          const r: any = rules[i];
          // Number-typed rules store numbers (empty box → undefined); text rules store the string.
          if (f === 'value') r.value = tOf(r.key ?? o.metas[0]?.key) === 'number' ? (inp.value === '' ? undefined : Number(inp.value)) : inp.value;
          else if (f === 'value2') r.value2 = inp.value === '' ? undefined : Number(inp.value);
          // Unreachable (colour inputs listen to 'input' and return above); kept as a fallback.
          else if (f === 'color') {
            r.color = inp.value;
            (inp.parentElement as HTMLElement).style.background = inp.value;
          } else r[f] = inp.value || undefined;
          // A new op or key can change which value boxes the row needs.
          if (f === 'op' || f === 'key') render();
          emit();
        }),
      );
      el.querySelectorAll<HTMLElement>('[data-sw]').forEach((b) =>
        b.addEventListener('click', () => {
          rules[i].color = b.dataset.sw!;
          render();
          emit();
        }),
      );
      el.querySelector('[data-del]')!.addEventListener('click', () => {
        rules.splice(i, 1);
        render();
        emit();
      });
    });
    host.querySelector('[data-add]')?.addEventListener('click', () => {
      const t = tOf(multi ? undefined : o.metas[0]?.key);
      const m = metaOf();
      // New rule: first status colour not used yet; default condition depends on the type
      // (on/off: the missing one of is-on / is-off; number: > 80% of range; text: equals '').
      const used = new Set(rules.map((r) => r.color));
      const color = [STATUS.critical, STATUS.warning, STATUS.good, '#2a78d6', '#4a3aa7'].find((c) => !used.has(c)) ?? '#2a78d6';
      rules.push(t === 'boolean' ? { op: rules.some((r) => r.op === 'isTrue') ? 'isFalse' : 'isTrue', color } : t === 'number' ? { op: 'gt', value: Math.round((m?.min ?? 0) + ((m?.max ?? 100) - (m?.min ?? 0)) * 0.8), color } : { op: 'eq', value: '', color });
      render();
      emit();
    });
    // Presets replace all rules. Traffic light uses the same 75% / 90% split as the templates.
    host.querySelector('[data-preset="traffic"]')?.addEventListener('click', () => {
      const m = metaOf();
      const span = (m?.max ?? 100) - (m?.min ?? 0) || 1;
      const r = (f: number) => Math.round(((m?.min ?? 0) + span * f) * 10) / 10;
      rules = [
        { op: 'gt', value: r(0.9), color: STATUS.critical, label: 'High' },
        { op: 'gt', value: r(0.75), color: STATUS.warning, label: 'Watch' },
        { op: 'lte', value: r(0.75), color: STATUS.good, label: 'Normal' },
      ];
      render();
      emit();
    });
    host.querySelector('[data-preset="onoff"]')?.addEventListener('click', () => {
      rules = [
        { op: 'isTrue', color: STATUS.good, label: 'Running' },
        { op: 'isFalse', color: STATUS.neutral, label: 'Stopped' },
      ];
      render();
      emit();
    });
    host.querySelector('[data-clear]')?.addEventListener('click', () => {
      rules = [];
      render();
      // Also remove the legacy settings, otherwise effectiveRules() would bring the bands back.
      emit({ bands: undefined, statusMap: undefined });
    });
    host.querySelector<HTMLSelectElement>('[data-target]')?.addEventListener('change', (e) => emit({ colorTarget: (e.target as HTMLSelectElement).value as any }));
    host.querySelector<HTMLInputElement>('[data-gv]')?.addEventListener('change', (e) => emit({ colorTarget: (e.target as HTMLInputElement).checked ? 'value' : undefined }));
    // Threshold lines default to on, so "on" is stored as absent and only `false` is saved.
    host.querySelector<HTMLInputElement>('[data-thr]')?.addEventListener('change', (e) => emit({ showThresholds: (e.target as HTMLInputElement).checked ? undefined : false }));
    const test = host.querySelector<HTMLInputElement>('[data-test]');
    const out = host.querySelector('.dbb-test-out') as HTMLElement;
    test?.addEventListener('input', () => {
      if (!test.value) return void (out.innerHTML = '');
      const r = matchRule(rules, test.value, multi ? undefined : o.metas[0]?.key);
      out.innerHTML = r ? `<span class="dbb-dot" style="background:${esc(r.color)}"></span> ${esc(r.label ?? 'matches')}` : '<span class="dbb-muted">no rule matches</span>';
    });
  };
  render();
}

// ---------------------------------------------------------------- card style

/** Options for `styleEditor`. */
export interface StyleEditorOptions {
  widget: Widget;
  /**
   * New `settings.style` (undefined = reset to theme defaults), plus optional other settings
   * (used for the footer; `undefined` values mean delete).
   */
  onChange(style: CardStyle | undefined, extra?: Partial<Widget['settings']>): void;
  /** "Copy this style to all widgets" was clicked; the builder copies it (keeping each icon). */
  onCopyToAll(): void;
  /** Gives the builder the element where it mounts a `richEditor` for the ⓘ description. */
  descriptionHost(el: HTMLElement): void;
}

/**
 * Colour picker bound to a CardStyle field (`data-st`). An unset field shows "theme" and the
 * native input starts at `fallback`; a set field gets an ✕ button that removes it.
 */
const colorInput = (f: string, v: string | undefined, fallback: string) =>
  `<span class="dbb-colf"><label class="dbb-swatch ${v ? '' : 'empty'}" style="${v ? `background:${esc(v)}` : ''}"><input type="color" data-st="${f}" value="${esc(v && /^#[0-9a-f]{6}$/i.test(v) ? v : fallback)}"/></label>${v ? `<button class="dbb-x" data-unset="${f}" title="Use the theme default">✕</button>` : '<span class="dbb-muted">theme</span>'}</span>`;

/**
 * Per-widget card style editor (Style tab): title (visibility, icon, colour, size, weight, font,
 * alignment), layout (value alignment and title position, D-020), card (background, gradient,
 * accent bar, border, shadow, padding, radius), value (size, colour, font) and help text.
 * Only fields the user set are stored (anything unset falls back to the theme): unset / empty /
 * false values are dropped, and an empty style is reported as undefined. Colour and slider
 * changes are debounced 250 ms.
 */
export function styleEditor(host: HTMLElement, o: StyleEditorOptions) {
  const w = o.widget;
  // Local working copy; each change emits the whole cleaned object.
  const st: CardStyle = { ...(w.settings.style ?? {}) };
  const isValue = ['value', 'kpi', 'progress', 'summary', 'multivalue', 'gauge'].includes(w.type);
  /** Widgets whose values/labels can be aligned (charts and tables lay themselves out). */
  const hasLayout = ['value', 'kpi', 'progress', 'summary', 'multivalue', 'status'].includes(w.type);
  /** Segmented button group for a style field; `def` is highlighted when the field is unset. */
  const seg = (f: keyof CardStyle, opts: [string, string][], cur: string | undefined, def: string) =>
    `<div class="dbb-seg sm">${opts.map(([v, l]) => `<button data-seg="${f}" data-v="${v}" class="${(cur ?? def) === v ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  host.innerHTML = `<div class="dbb-form">
    <div class="dbb-sec">Title</div>
    <label class="dbb-check"><input type="checkbox" data-st="hideTitle" ${st.hideTitle ? '' : 'checked'}/> Show title</label>
    <div class="dbb-field"><span>Icon</span><div class="dbb-icons"><button data-icon="" class="${!st.icon ? 'on' : ''}" title="No icon">∅</button>${ICONS.map((n) => `<button data-icon="${n}" class="${st.icon === n ? 'on' : ''}" title="${ICON_TITLE[n] ?? n}">${ICON_SVG[n]}</button>`).join('')}</div></div>
    <div class="dbb-row"><div class="dbb-field half"><span>Icon colour</span>${colorInput('iconColor', st.iconColor, '#2a78d6')}</div><div class="dbb-field half"><span>Title colour</span>${colorInput('titleColor', st.titleColor, '#52514e')}</div></div>
    <div class="dbb-row">
      <label class="dbb-field half"><span>Title size</span><select data-st="titleSize"><option value="">Default</option>${[11, 12, 13, 14, 16, 18, 20, 24].map((n) => `<option ${st.titleSize === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <label class="dbb-field half"><span>Weight</span><select data-st="titleWeight"><option value="">Default</option>${[['400', 'Regular'], ['500', 'Medium'], ['600', 'Semibold'], ['700', 'Bold']].map(([v, l]) => `<option value="${v}" ${st.titleWeight === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    </div>
    <div class="dbb-row">
      <label class="dbb-field half"><span>Title font</span><select data-st="titleFont"><option value="">Theme font</option>${FONTS.map((f) => `<option ${st.titleFont === f ? 'selected' : ''}>${f}</option>`).join('')}</select></label>
      <div class="dbb-field half"><span>Align</span>${seg('titleAlign', [['left', 'Left'], ['center', 'Centre'], ['right', 'Right']], st.titleAlign, 'left')}</div>
    </div>
    ${
      hasLayout
        ? `<div class="dbb-sec">Layout</div>
    <div class="dbb-field"><span>Values &amp; labels · horizontal</span>${seg('align', [['left', '⇤ Left'], ['center', '↔ Centre'], ['right', 'Right ⇥']], st.align, 'left')}</div>
    ${w.type === 'multivalue' ? '' : `<div class="dbb-field"><span>Values &amp; labels · vertical</span>${seg('valign', [['top', '⤒ Top'], ['middle', '↕ Middle'], ['bottom', 'Bottom ⤓']], st.valign, w.type === 'kpi' ? 'top' : 'middle')}</div>`}
    <div class="dbb-field"><span>Title position</span>${seg('titlePos', [['top', 'Above'], ['bottom', 'Below']], st.titlePos, 'top')}</div>`
        : `<div class="dbb-sec">Layout</div><div class="dbb-field"><span>Title position</span>${seg('titlePos', [['top', 'Above'], ['bottom', 'Below']], st.titlePos, 'top')}</div>`
    }
    <div class="dbb-sec">Card</div>
    <div class="dbb-row"><div class="dbb-field half"><span>Background</span>${colorInput('bg', st.bg, '#ffffff')}</div><div class="dbb-field half"><span>Accent bar</span>${colorInput('accentBar', st.accentBar, '#2a78d6')}</div></div>
    <label class="dbb-check"><input type="checkbox" data-st="gradient" ${st.gradient ? 'checked' : ''} ${st.bg ? '' : 'disabled'}/> Gradient background</label>
    <div class="dbb-field"><span>Border</span>${seg('border', [['none', 'None'], ['thin', 'Thin'], ['thick', 'Thick']], st.border, 'thin')}</div>
    <div class="dbb-field"><span>Border colour</span>${colorInput('borderColor', st.borderColor, '#e6e5e0')}</div>
    <div class="dbb-field"><span>Shadow</span>${seg('shadow', [['none', 'None'], ['soft', 'Soft'], ['strong', 'Lifted']], st.shadow, 'soft')}</div>
    <div class="dbb-field"><span>Padding</span>${seg('padding', [['compact', 'Compact'], ['normal', 'Normal'], ['roomy', 'Roomy']], st.padding, 'normal')}</div>
    <label class="dbb-field"><span>Corner radius · <b data-rv>${st.radius ?? 'theme'}</b></span><input type="range" min="0" max="28" data-st="radius" value="${st.radius ?? 12}"/></label>
    ${
      isValue
        ? `<div class="dbb-sec">Value</div>
    <label class="dbb-field"><span>Value size · <b data-vv>${st.valueSize ?? 'auto'}</b></span><input type="range" min="12" max="72" data-st="valueSize" value="${st.valueSize ?? 30}"/></label>
    <div class="dbb-row"><div class="dbb-field half"><span>Value colour</span>${colorInput('valueColor', st.valueColor, '#0b0b0b')}</div>
      <label class="dbb-field half"><span>Value font</span><select data-st="valueFont"><option value="">Theme font</option>${FONTS.map((f) => `<option ${st.valueFont === f ? 'selected' : ''}>${f}</option>`).join('')}</select></label></div>
`
        : ''
    }
    <div class="dbb-sec">Help text</div>
    <div class="dbb-hint">Shown as an ⓘ tooltip next to the title.</div>
    <div data-desc></div>
    <label class="dbb-field"><span>Footer note</span><input data-footer maxlength="200" value="${esc(w.settings.footer ?? '')}" placeholder="e.g. Source: PLC tag DP-01"/></label>
    <div class="dbb-row wrap" data-nosec style="margin-top:8px"><button class="dbb-btn sm" data-copyall>Copy this style to all widgets</button><button class="dbb-btn sm danger" data-reset>Reset style</button></div>
  </div>`;
  o.descriptionHost(host.querySelector('[data-desc]') as HTMLElement);
  const emit = () => {
    const clean: any = {};
    for (const [k, v] of Object.entries(st)) if (v !== undefined && v !== '' && v !== false) clean[k] = v;
    o.onChange(Object.keys(clean).length ? clean : undefined);
  };
  host.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-st]').forEach((inp) => {
    const f = inp.dataset.st as keyof CardStyle;
    const ev = inp.type === 'color' || inp.type === 'range' ? 'input' : 'change';
    let tm: any;
    inp.addEventListener(ev, () => {
      const any: any = st;
      // The checkbox reads "Show title", so it is the inverse of the stored hideTitle.
      if (f === 'hideTitle') any.hideTitle = !(inp as HTMLInputElement).checked || undefined;
      else if (f === 'gradient') any.gradient = (inp as HTMLInputElement).checked || undefined;
      else if (f === 'radius' || f === 'valueSize' || f === 'titleSize') any[f] = inp.value === '' ? undefined : Number(inp.value);
      else any[f] = inp.value || undefined;
      if (f === 'titleFont' || f === 'valueFont') loadFont(inp.value);
      if (inp.type === 'color') {
        const sw = inp.parentElement as HTMLElement;
        sw.style.background = inp.value;
        sw.classList.remove('empty');
      }
      if (f === 'radius') (host.querySelector('[data-rv]') as HTMLElement).textContent = inp.value;
      if (f === 'valueSize') (host.querySelector('[data-vv]') as HTMLElement).textContent = inp.value;
      clearTimeout(tm);
      tm = setTimeout(emit, ev === 'input' ? 250 : 0);
    });
  });
  host.querySelectorAll<HTMLElement>('[data-unset]').forEach((b) =>
    b.addEventListener('click', () => {
      delete (st as any)[b.dataset.unset!];
      // A gradient is derived from the background colour, so it goes with it.
      if (b.dataset.unset === 'bg') delete st.gradient;
      emit();
    }),
  );
  host.querySelectorAll<HTMLElement>('[data-seg]').forEach((b) =>
    b.addEventListener('click', () => {
      (st as any)[b.dataset.seg!] = b.dataset.v;
      emit();
    }),
  );
  host.querySelectorAll<HTMLElement>('[data-icon]').forEach((b) =>
    b.addEventListener('click', () => {
      st.icon = (b.dataset.icon || undefined) as any;
      emit();
    }),
  );
  // The footer is a widget setting, not part of the style: pass the stored style unchanged plus `extra`.
  host.querySelector<HTMLInputElement>('[data-footer]')!.addEventListener('change', (e) => o.onChange(w.settings.style, { footer: (e.target as HTMLInputElement).value.trim() || undefined }));
  host.querySelector('[data-reset]')!.addEventListener('click', () => o.onChange(undefined));
  host.querySelector('[data-copyall]')!.addEventListener('click', () => o.onCopyToAll());
  sectionize(host.querySelector('.dbb-form') as HTMLElement, 'style');
}

// ---------------------------------------------------------------- dashboard theme

/**
 * Dashboard theme editor (Dashboard tab, shown when no widget is selected; D-019): preset,
 * accent, font, page background colour or https image, card colour, radius, shadow, density
 * and title alignment, plus a "Start from a template" shortcut.
 * @param theme Current `Dashboard.theme` (optional in the schema, so old saves still load).
 * @param onChange Receives the cleaned theme (empty/unset fields dropped), or undefined for
 *   "Reset theme" / nothing set. Colour and slider changes are debounced 250 ms.
 * @param extra.onTemplates Opens the builder's template dialog.
 */
export function themeEditor(host: HTMLElement, theme: DashboardTheme | undefined, onChange: (t: DashboardTheme | undefined) => void, extra: { onTemplates(): void }) {
  const t: DashboardTheme = { ...(theme ?? {}) };
  const cur = t.preset ?? 'light';
  const img = t.bgImage ?? '';
  const isData = /^data:/i.test(img);
  const seg = (f: keyof DashboardTheme, opts: [string, string][], v: string | undefined, def: string) =>
    `<div class="dbb-seg sm">${opts.map(([x, l]) => `<button data-tseg="${f}" data-v="${x}" class="${(v ?? def) === x ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  host.innerHTML = `<div class="dbb-form">
    <div class="dbb-banner" style="display:flex;align-items:center;gap:8px">Select a widget to edit it. These settings style the whole dashboard.</div>
    <button class="dbb-btn" data-tpl style="justify-content:center">✦ Start from a template…</button>
    <div class="dbb-sec">Theme</div>
    <div class="dbb-presets">${THEME_PRESETS.map((p) => {
      const P = PRESETS[p];
      return `<button data-preset="${p}" class="${cur === p ? 'on' : ''}" title="${P.label}"><span class="pv" style="background:${P.plane}"><i style="background:${P.surface};border-color:${P.line}"></i><i style="background:${P.surface};border-color:${P.line}"><b style="background:${P.accent}"></b></i></span><span>${P.label}</span></button>`;
    }).join('')}</div>
    ${appDarkMode() && !PRESETS[cur]?.dark ? '<div class="dbb-hint">The app is in dark mode, so this light theme is shown with dark colours. In light mode it looks as chosen here.</div>' : ''}
    <div class="dbb-row"><div class="dbb-field half"><span>Accent colour</span>${colorInputT('accent', t.accent, PRESETS[cur].accent)}</div>
      <label class="dbb-field half"><span>Font</span><select data-t="font"><option value="">Same as the app (default)</option>${FONTS.filter((f) => f !== 'Inter').map((f) => `<option ${t.font === f ? 'selected' : ''}>${f}</option>`).join('')}</select></label></div>
    <div class="dbb-sec">Background</div>
    <div class="dbb-field"><span>Page colour</span>${colorInputT('bg', t.bg, PRESETS[cur].plane)}</div>
    <div class="dbb-field"><span>Image</span>${
      isData
        ? `<div class="dbb-bgimg"><span class="pv" style="background-image:url(&quot;${esc(safeUrl(img) ?? '')}&quot;)"></span><span class="nm">Uploaded image</span><button class="dbb-x" data-bgclear title="Remove the image">✕</button></div>`
        : ''
    }${isData ? '' : `<input data-t="bgImage" value="${esc(img)}" placeholder="https://… address of an image"/>`}
      <label class="dbb-btn sm dbb-upl">Upload image…<input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" data-bgfile hidden/></label>
      <div class="dbb-bgst" data-bgst></div></div>
    ${img ? `<div class="dbb-field"><span>Image fit</span>${seg('bgFit', [['cover', 'Fill'], ['contain', 'Fit'], ['tile', 'Tile']], t.bgFit, 'cover')}</div>` : ''}
    <div class="dbb-hint">The image shows in the gaps between cards. Use a light image or the Dark theme so text stays readable. Uploads up to 150 KB.</div>
    <div class="dbb-sec">Cards</div>
    <div class="dbb-field"><span>Card colour</span>${colorInputT('cardBg', t.cardBg, PRESETS[cur].surface)}</div>
    <label class="dbb-field"><span>Corner radius · <b data-rv>${t.radius ?? 12}</b></span><input type="range" min="0" max="28" data-t="radius" value="${t.radius ?? 12}"/></label>
    <div class="dbb-field"><span>Shadow</span>${seg('shadow', [['none', 'Flat'], ['soft', 'Soft'], ['strong', 'Lifted']], t.shadow, 'soft')}</div>
    <div class="dbb-field"><span>Density</span>${seg('density', [['compact', 'Compact'], ['normal', 'Normal'], ['roomy', 'Roomy']], t.density, 'normal')}</div>
    <div class="dbb-field"><span>Titles</span>${seg('titleAlign', [['left', 'Left'], ['center', 'Centred']], t.titleAlign, 'left')}</div>
    <button class="dbb-btn sm danger" data-treset data-nosec style="align-self:flex-start;margin-top:6px">Reset theme</button>
  </div>`;
  const emit = () => {
    const c: any = {};
    for (const [k, v] of Object.entries(t)) if (v !== undefined && v !== '') c[k] = v;
    onChange(Object.keys(c).length ? c : undefined);
  };
  host.querySelector('[data-tpl]')!.addEventListener('click', extra.onTemplates);
  host.querySelectorAll<HTMLElement>('[data-preset]').forEach((b) =>
    b.addEventListener('click', () => {
      t.preset = b.dataset.preset as any;
      // Drop custom page/card colours so the new preset's own colours show.
      delete t.bg;
      delete t.cardBg;
      emit();
    }),
  );
  host.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-t]').forEach((inp) => {
    const f = inp.dataset.t as keyof DashboardTheme;
    let tm: any;
    inp.addEventListener(inp.type === 'color' || inp.type === 'range' ? 'input' : 'change', () => {
      (t as any)[f] = f === 'radius' ? Number(inp.value) : inp.value.trim() || undefined;
      if (f === 'font') loadFont(inp.value);
      if (f === 'radius') (host.querySelector('[data-rv]') as HTMLElement).textContent = inp.value;
      if (inp.type === 'color') (inp.parentElement as HTMLElement).style.background = inp.value;
      clearTimeout(tm);
      tm = setTimeout(emit, inp.type === 'color' || inp.type === 'range' ? 250 : 0);
    });
  });
  host.querySelectorAll<HTMLElement>('[data-tunset]').forEach((b) =>
    b.addEventListener('click', () => {
      delete (t as any)[b.dataset.tunset!];
      emit();
    }),
  );
  host.querySelectorAll<HTMLElement>('[data-tseg]').forEach((b) =>
    b.addEventListener('click', () => {
      (t as any)[b.dataset.tseg!] = b.dataset.v;
      emit();
    }),
  );
  host.querySelector('[data-treset]')!.addEventListener('click', () => onChange(undefined));
  // Background image (D-033): upload as a data: URI (150 KB cap, like the image widget), remove,
  // and a status line that says why an address is not used or could not be loaded.
  host.querySelector('[data-bgclear]')?.addEventListener('click', () => {
    delete t.bgImage;
    delete t.bgFit;
    emit();
  });
  const st = host.querySelector('[data-bgst]') as HTMLElement;
  host.querySelector<HTMLInputElement>('[data-bgfile]')!.addEventListener('change', (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    if (f.size > 150 * 1024) {
      st.className = 'dbb-bgst err';
      st.textContent = `That image is ${Math.round(f.size / 1024)} KB; the limit is 150 KB. Use a smaller file or an https:// address.`;
      return;
    }
    const r = new FileReader();
    r.onload = () => {
      t.bgImage = String(r.result);
      emit();
    };
    r.readAsDataURL(f);
  });
  if (img) {
    const u = safeUrl(img);
    if (!u) {
      st.className = 'dbb-bgst err';
      st.textContent = /^http:\/\//i.test(img) ? 'Not shown: the address must start with https:// (the dashboard is served over https).' : 'Not shown: use an https:// address of an image file, without spaces, quotes or brackets.';
    } else {
      st.className = 'dbb-bgst';
      st.textContent = 'Checking the image…';
      const probe = new Image();
      probe.onload = () => {
        if (!st.isConnected) return;
        st.className = 'dbb-bgst ok';
        st.textContent = `✓ Image loaded (${probe.naturalWidth} × ${probe.naturalHeight})`;
      };
      probe.onerror = () => {
        if (!st.isConnected) return;
        st.className = 'dbb-bgst err';
        st.textContent = "Couldn't load an image from this address. Check that it opens an image file (not a web page) and that the site allows embedding, or upload the file instead.";
      };
      probe.src = u;
    }
  }
  sectionize(host.querySelector('.dbb-form') as HTMLElement, 'theme');
}

/**
 * Colour picker bound to a DashboardTheme field (`data-t`). Unset fields show the preset's
 * colour and "preset"; set ones get an ✕ to go back to it. Declared after `themeEditor` but
 * only called at run time, so the order is safe.
 */
const colorInputT = (f: string, v: string | undefined, fallback: string) =>
  `<span class="dbb-colf"><label class="dbb-swatch" style="background:${esc(v ?? fallback)}"><input type="color" data-t="${f}" value="${esc(v && /^#[0-9a-f]{6}$/i.test(v) ? v : fallback)}"/></label>${v ? `<button class="dbb-x" data-tunset="${f}" title="Use the preset colour">✕</button>` : '<span class="dbb-muted">preset</span>'}</span>`;
