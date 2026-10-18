/**
 * Stylesheet for the full-screen Dashboard Builder and the shared UI pieces it uses (modals,
 * toasts, banners, form fields, rule / style / theme / rich-text editors, template gallery,
 * palette, chat panel).
 *
 * How it is loaded: `BUILDER_CSS` is a plain string. It is injected into `document.head` ONCE
 * per page via `ensureCss('dbb-css-builder', BUILDER_CSS)` (`render/theme.ts`), which skips the
 * insert if a `<style id="dbb-css-builder">` already exists. Both `builder/builder.ts` (when the
 * builder opens) and `entries/renderer.ts` (for the machine page's edit-menu dialogs) call it.
 * Each ThingsBoard widget type embeds its own copy of the library, so whichever loads first wins;
 * after changing this CSS, reload the page (not just the widget) to see the new version.
 *
 * Class-naming convention:
 * - Every block class is prefixed `dbb-` ("dashboard builder") so nothing collides with
 *   ThingsBoard / Angular Material styles, e.g. `.dbb-overlay`, `.dbb-field`, `.dbb-rule`.
 * - Parts of a block use a short suffix: `.dbb-modal-h` / `-b` / `-f` (header / body / footer),
 *   `.dbb-rte-bar`, `.dbb-rte-ed`.
 * - State and size modifiers are short unprefixed classes that only appear combined with a
 *   `dbb-` class: `.on`, `.sel`, `.sm`, `.half`, `.grow`, `.warn`, `.err`, `.primary`, `.danger`.
 * - Colours come from CSS variables (`--accent`, `--line`, `--ink`, `--ink-2`, `--ink-3`,
 *   `--surface`, `--plane`, `--danger`...) defined on `.dbb-root` in `render/theme.ts` and
 *   overridden per dashboard theme by `applyTheme`. Prefer the variables over hard-coded colours.
 * Grid-specific rules live next to the grid code (`GRID_CSS` in `render/grid.ts`); base card and
 * page styles are `CSS` in `render/theme.ts`.
 */
export const BUILDER_CSS = `
.dbb-overlay{position:fixed;inset:0;z-index:10000;background:#f4f5f7;display:flex;flex-direction:column;font-family:Inter,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
.dbb-overlay .dbb-center{font-family:var(--font)}
.dbb-top{display:flex;align-items:flex-end;gap:10px;padding:10px 14px;background:#fff;border-bottom:1px solid var(--line);flex-wrap:wrap;box-shadow:0 1px 3px rgba(16,24,40,.05);position:relative;z-index:3}
.dbb-vsep{width:1px;height:24px;background:var(--line);margin:0 2px}
.dbb-field{display:flex;flex-direction:column;gap:4px;font-size:12px;min-width:0}
.dbb-field>span{color:var(--ink-3);font-size:11px;font-weight:500}
.dbb-field.grow{flex:1;min-width:160px}
.dbb-field.half{flex:1}
.dbb-field input:not([type=range]):not([type=color]):not([type=checkbox]):not([type=file]),.dbb-field select,.dbb-field textarea,.dbb-sub select,.dbb-rule input,.dbb-rule select,.dbb-test input,.dbb-rte-link input,.dbb-pal-search input{font:inherit;padding:7px 9px;border:1px solid var(--line);border-radius:8px;background:#fff;color:var(--ink);min-width:0;transition:border-color .12s,box-shadow .12s}
.dbb-field input:focus,.dbb-field select:focus,.dbb-rule input:focus,.dbb-rule select:focus,.dbb-pal-search input:focus,.dbb-test input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 18%,transparent)}
.dbb-field input[type=range]{accent-color:var(--accent)}
.dbb-field input[type=file]{font-size:12px}
.dbb-field textarea{resize:vertical}
.dbb-tools{display:flex;gap:6px;align-items:center;margin-left:auto;flex-wrap:wrap}
.dbb-btn.icon{padding:6px 8px;font-size:15px;line-height:1}
.dbb-btn.icon svg{width:16px;height:16px}
.dbb-btn.sm{padding:4px 9px;font-size:12px}
.dbb-btn.on{background:color-mix(in srgb,var(--accent) 10%,#fff);border-color:var(--accent);color:var(--accent)}
.dbb-btn.danger-fill{background:var(--danger);border-color:var(--danger)}
.dbb-btn.icon.danger:hover:not(:disabled){background:var(--imx-bad-bg,#FEE2E2);border-color:color-mix(in srgb,var(--imx-bad-tx,#B91C1C) 30%,var(--line));color:var(--imx-bad-tx,#B91C1C)}
.dbb-banner-row{display:flex;flex-direction:column;gap:4px;padding:8px 14px 0}
.dbb-banner-row[hidden]{display:none}
.dbb-main{flex:1;display:flex;min-height:0}
.dbb-left{width:220px;background:#fff;border-right:1px solid var(--line);padding:12px;overflow:auto;flex:none}
.dbb-right{width:350px;background:#fff;border-left:1px solid var(--line);display:flex;flex-direction:column;flex:none;min-height:0}
.dbb-left[hidden],.dbb-right[hidden]{display:none}
.dbb-center{flex:1;overflow:auto;position:relative;min-width:0;background-color:var(--plane);transition:background-color .2s}
.dbb-canvas{margin:6px;min-height:400px;background-image:linear-gradient(to right,color-mix(in srgb,var(--ink) 5%,transparent) 1px,transparent 1px);background-size:calc((100% - 10px)/12) 100%;background-position:5px 0;border-radius:10px}
.dbb-canvas.preview{background-image:none}
.dbb-canvas.preview .dbb-gdrag,.dbb-canvas.preview .dbb-gresize,.dbb-canvas.preview .dbb-gtools{display:none}
.dbb-sec{font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-3);margin:14px 0 6px}
.dbb-sec:first-child{margin-top:0}
.dbb-pal-search{position:sticky;top:-12px;background:#fff;padding:0 0 4px;z-index:1}
.dbb-pal-search input{width:100%;padding-left:30px;background:#f6f7f9 url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23898781' stroke-width='2'%3E%3Ccircle cx='11' cy='11' r='7'/%3E%3Cpath d='M20 20l-4-4'/%3E%3C/svg%3E") no-repeat 9px center/14px}
.dbb-palette{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.dbb-pal{display:flex;flex-direction:column;align-items:center;gap:5px;padding:10px 4px 8px;border:1px solid var(--line);border-radius:10px;background:#fff;cursor:grab;font:inherit;font-size:11.5px;color:var(--ink-2);text-align:center;line-height:1.2;transition:border-color .12s,background .12s,transform .12s,box-shadow .12s}
.dbb-pal:hover{border-color:var(--accent);background:#f5f9fe;color:var(--ink);transform:translateY(-1px);box-shadow:0 3px 8px rgba(42,120,214,.12)}
.dbb-pal:active{cursor:grabbing}
.dbb-pal svg{width:22px;height:22px;flex:none;color:var(--accent)}
.dbb-hint{font-size:12px;color:var(--ink-3);margin:4px 0;line-height:1.45}
.dbb-hint code,.dbb-tip-row code{font-size:11px;background:#f1f0ec;padding:0 4px;border-radius:4px}
.dbb-muted{color:var(--ink-3);font-size:11px}
.dbb-count{font-size:11px;color:var(--ink-3);margin-top:14px;text-align:center}
.dbb-count.full{color:#b3541e;font-weight:600}
.dbb-pal.off{opacity:.42;cursor:not-allowed;filter:grayscale(1)}
.dbb-pal.off:hover{transform:none;box-shadow:none;border-color:var(--line);background:#fff}
.dbb-check.off{opacity:.45;cursor:not-allowed}
.dbb-na{font-size:10.5px;font-weight:600;color:var(--ink-3);background:#eceae4;border-radius:999px;padding:1px 7px;margin-left:2px;white-space:nowrap}
.dbb-range{display:flex;align-items:center;gap:6px}
.dbb-range select{padding:5px 8px}
.dbb-live{display:inline-block;width:7px;height:7px;border-radius:50%;background:#0ca30c;margin-right:6px;box-shadow:0 0 0 3px rgba(12,163,12,.18);vertical-align:1px}
.dbb-sel-h{display:flex;align-items:center;gap:10px;padding:12px 14px 4px}
.dbb-sel-h .ic{width:34px;height:34px;border-radius:10px;background:color-mix(in srgb,var(--accent) 12%,#fff);color:var(--accent);display:inline-flex;align-items:center;justify-content:center;flex:none}
.dbb-sel-h .ic svg{width:20px;height:20px}
.dbb-sel-h>div{flex:1;min-width:0}
.dbb-sel-h .t{font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dbb-sel-h .s{font-size:11px;color:var(--ink-3)}
.dbb-tabs{display:flex;gap:4px;margin:8px 12px 0;padding:3px;background:#f1f2f4;border-radius:10px;flex:none}
.dbb-tab{flex:1;border:0;background:none;padding:7px 6px;font:inherit;font-size:12.5px;color:var(--ink-2);cursor:pointer;border-radius:8px;transition:background .12s,color .12s}
.dbb-tab:hover{color:var(--ink)}
.dbb-tab.on{background:#fff;color:var(--ink);font-weight:600;box-shadow:0 1px 3px rgba(16,24,40,.12)}
.dbb-panel{flex:1;overflow:auto;padding:12px 14px 20px;min-height:0;display:flex;flex-direction:column}
.dbb-form{display:flex;flex-direction:column;gap:9px}
.dbb-grp{border:1px solid var(--line);border-radius:10px;background:#fff;flex:none}
.dbb-grp-h{all:unset;box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;padding:9px 12px;cursor:pointer;font-size:12.5px;font-weight:600;color:var(--ink);border-radius:10px;font-family:inherit}
.dbb-grp-h:hover{background:#f7f8fa}
.dbb-grp-h:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.dbb-grp-h .n{width:18px;height:18px;border-radius:50%;background:color-mix(in srgb,var(--accent) 12%,#fff);color:var(--accent);font-size:10.5px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;flex:none}
.dbb-grp-h .t{flex:1}
.dbb-grp-h .c{display:inline-flex;color:var(--ink-3);transition:transform .15s}
.dbb-grp.shut .dbb-grp-h .c{transform:rotate(-90deg)}
.dbb-grp-b{display:flex;flex-direction:column;gap:9px;padding:4px 12px 12px;border-top:1px solid var(--grid)}
.dbb-grp-b>:first-child{margin-top:6px}
.dbb-grp.shut .dbb-grp-b{display:none}
.dbb-bgimg{display:flex;align-items:center;gap:8px;padding:6px;border:1px solid var(--line);border-radius:8px;background:#fafaf9}
.dbb-bgimg .pv{width:44px;height:30px;border-radius:5px;background-size:cover;background-position:center;flex:none;border:1px solid var(--line)}
.dbb-bgimg .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--ink-2)}
.dbb-upl{align-self:flex-start;cursor:pointer;margin-top:2px}
.dbb-bgst{font-size:11.5px;color:var(--ink-3);line-height:1.4}
.dbb-bgst:empty{display:none}
.dbb-bgst.ok{color:#1c7c3c}
.dbb-bgst.err{color:var(--danger)}
.dbb-pk{position:relative;font-size:13px}
.dbb-pk *{box-sizing:border-box}
.dbb-pk-trig{display:flex;align-items:center;gap:6px;min-height:34px;padding:4px 8px 4px 9px;border:1px solid var(--line);border-radius:8px;background:#fff;cursor:pointer;color:var(--ink);transition:border-color .12s,box-shadow .12s}
.dbb-pk-trig:hover{border-color:color-mix(in srgb,var(--accent) 45%,var(--line))}
.dbb-pk-trig:focus-visible,.dbb-pk-trig.open{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 18%,transparent)}
.dbb-pk-trig .ph{color:var(--ink-3);flex:1}
.dbb-pk-trig .one{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dbb-pk-trig .chips{flex:1;display:flex;flex-wrap:wrap;gap:4px;min-width:0}
.dbb-pk-trig .chip{display:inline-flex;align-items:center;gap:4px;max-width:100%;padding:2px 4px 2px 8px;border-radius:6px;background:color-mix(in srgb,var(--accent) 10%,#fff);color:color-mix(in srgb,var(--accent) 80%,#000);font-size:12px;font-weight:500;line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dbb-pk-trig .chip .x{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:4px;font-size:10px;color:inherit;opacity:.7;flex:none}
.dbb-pk-trig .chip .x:hover{opacity:1;background:color-mix(in srgb,var(--accent) 18%,#fff)}
.dbb-pk-trig .car{display:inline-flex;color:var(--ink-3);flex:none;transition:transform .15s}
.dbb-pk-trig.open .car{transform:rotate(180deg)}
.dbb-pk .sub{color:var(--ink-3);font-size:11.5px}
.dbb-pk.inline .dbb-pk-pop{position:static;margin-top:6px;box-shadow:0 4px 14px rgba(16,24,40,.08)}
.dbb-pk-pop{position:absolute;left:0;right:0;top:calc(100% + 4px);z-index:20;background:#fff;border:1px solid var(--line);border-radius:10px;box-shadow:0 12px 32px rgba(16,24,40,.16),0 2px 6px rgba(16,24,40,.08);overflow:hidden;display:flex;flex-direction:column}
.dbb-pk-s{padding:8px;border-bottom:1px solid var(--grid)}
.dbb-pk-s input{all:unset;box-sizing:border-box;display:block;width:100%;padding:6px 9px;border:1px solid var(--line);border-radius:7px;font:inherit;font-size:13px;color:var(--ink);background:#fff}
.dbb-pk-s input:focus{border-color:var(--accent)}
.dbb-pk-list{max-height:248px;overflow:auto;padding:4px}
.dbb-pk-row{display:flex;align-items:center;gap:9px;padding:7px 8px;border-radius:7px;cursor:pointer;line-height:1.3;outline:none}
.dbb-pk-row:hover,.dbb-pk-row:focus{background:#f3f6fb}
.dbb-pk-row .l{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dbb-pk-row .tag{font-size:10.5px;color:var(--ink-3);background:#f1f1ef;border-radius:4px;padding:0 5px;margin-left:4px}
.dbb-pk-row.dis{opacity:.45;cursor:not-allowed}
.dbb-pk-row.dis:hover{background:none}
.dbb-pk-row .box,.dbb-pk-row .dot{width:16px;height:16px;flex:none;border:1.5px solid #b9b8b2;background:#fff;display:inline-flex;align-items:center;justify-content:center;transition:background .12s,border-color .12s}
.dbb-pk-row .box{border-radius:4px}
.dbb-pk-row .dot{border-radius:50%}
.dbb-pk-row.on .box{background:var(--accent);border-color:var(--accent)}
.dbb-pk-row .box svg{color:#fff;opacity:0}
.dbb-pk-row.on .box svg{opacity:1}
.dbb-pk-row.on .dot{border-color:var(--accent)}
.dbb-pk-row .dot>span{width:8px;height:8px;border-radius:50%;background:transparent}
.dbb-pk-row.on .dot>span{background:var(--accent)}
.dbb-pk-none{padding:12px;color:var(--ink-3);font-size:12px;text-align:center}
.dbb-pk-f{display:flex;align-items:center;gap:6px;padding:7px 8px 7px 12px;border-top:1px solid var(--grid);font-size:12px;color:var(--ink-3);background:#fafaf9}
.dbb-pk-f .grow{flex:1}
.dbb-pk-f button{all:unset;cursor:pointer;padding:4px 10px;border-radius:6px;font-size:12px;font-weight:500;color:var(--ink-2);font-family:inherit}
.dbb-pk-f button:hover{background:#efefed}
.dbb-pk-f button.done{background:var(--accent);color:#fff}
.dbb-pk-f button.done:hover{filter:brightness(1.08)}
.dbb-row{display:flex;gap:8px;align-items:flex-end}
.dbb-row.wrap{flex-wrap:wrap}
.dbb-check{display:flex;align-items:flex-start;gap:7px;font-size:13px;cursor:pointer;line-height:1.35}
.dbb-check input{margin-top:2px;accent-color:var(--accent)}
.dbb-check.dis{opacity:.55;cursor:default}
.dbb-src{display:flex;flex-direction:column;gap:6px}
.dbb-sub{margin-left:22px;display:flex;flex-direction:column;gap:6px;font-size:12px}
.dbb-sub[hidden]{display:none}
.dbb-keys{display:flex;flex-direction:column;gap:5px;max-height:220px;overflow:auto;padding:8px;border:1px solid var(--grid);border-radius:8px;background:#fbfbfa}
.dbb-tip-row{font-size:12px;color:var(--ink-3);background:#f6f7f9;border-radius:8px;padding:8px 10px;line-height:1.45}
.dbb-tip-row a{color:var(--accent);font-weight:500}
.dbb-seg{display:inline-flex;padding:3px;background:#f1f2f4;border-radius:9px;gap:2px;flex-wrap:wrap}
.dbb-seg button{border:0;background:none;font:inherit;font-size:12px;padding:5px 10px;border-radius:7px;color:var(--ink-2);cursor:pointer;white-space:nowrap}
.dbb-seg button.on{background:#fff;color:var(--ink);font-weight:600;box-shadow:0 1px 2px rgba(16,24,40,.14)}
.dbb-seg.sm button{padding:4px 9px;font-size:11.5px}
.dbb-swatch{position:relative;display:inline-block;width:30px;height:30px;border-radius:8px;border:1px solid rgba(0,0,0,.12);cursor:pointer;flex:none;box-shadow:inset 0 0 0 2px rgba(255,255,255,.6)}
.dbb-swatch.empty{background:repeating-conic-gradient(#e6e5e0 0 25%,#fff 0 50%) 0 0/10px 10px}
.dbb-swatch input,.dbb-swatch input[type=color]{position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%;border:0;padding:0}
.dbb-colf{display:inline-flex;align-items:center;gap:6px}
.dbb-x{border:0;background:none;color:var(--ink-3);cursor:pointer;font-size:12px;padding:4px;border-radius:6px;line-height:1}
.dbb-x:hover{background:#f1f0ec;color:var(--danger)}
.dbb-icons{display:grid;grid-template-columns:repeat(8,1fr);gap:4px}
.dbb-icons button{aspect-ratio:1;border:1px solid var(--line);background:#fff;border-radius:7px;color:var(--ink-2);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;padding:0;font-size:13px}
.dbb-icons button svg{width:17px;height:17px}
.dbb-icons button:hover{border-color:var(--accent);color:var(--accent)}
.dbb-icons button.on{background:var(--accent);border-color:var(--accent);color:#fff}
.dbb-presets{display:grid;grid-template-columns:repeat(5,1fr);gap:6px}
.dbb-presets button{border:2px solid transparent;background:none;padding:0;border-radius:10px;cursor:pointer;font:inherit;font-size:11px;color:var(--ink-2);display:flex;flex-direction:column;gap:4px;align-items:stretch}
.dbb-presets button.on{color:var(--ink);font-weight:600}
.dbb-presets .pv{height:44px;border-radius:9px;display:grid;grid-template-columns:1fr 1fr;gap:4px;padding:6px;border:1px solid var(--line)}
.dbb-presets button.on .pv{border-color:var(--accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 35%,transparent)}
.dbb-presets .pv i{border-radius:4px;border:1px solid;position:relative}
.dbb-presets .pv b{position:absolute;left:3px;right:3px;bottom:3px;height:4px;border-radius:2px}
.dbb-rules{display:flex;flex-direction:column;gap:10px}
.dbb-rule-list{display:flex;flex-direction:column;gap:8px}
.dbb-rule{border:1px solid var(--line);border-radius:10px;padding:8px;display:flex;flex-direction:column;gap:6px;background:#fbfbfa}
.dbb-rule-main{display:flex;gap:6px;align-items:center}
.dbb-rule-main select{flex:none;max-width:110px}
.dbb-rule-main input:not([type=color]){flex:1;width:60px}
.dbb-rule-sub{display:flex;gap:6px;align-items:center}
.dbb-rule-sub input{flex:1;font-size:12px!important;padding:5px 8px!important}
.dbb-sw-row{display:flex;gap:3px}
.dbb-sw-row button{width:14px;height:14px;border-radius:4px;border:1px solid rgba(0,0,0,.12);cursor:pointer;padding:0}
.dbb-test{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--ink-3);border-top:1px dashed var(--line);padding-top:10px}
.dbb-test input{width:110px}
.dbb-test-out{display:inline-flex;align-items:center;gap:5px;color:var(--ink);font-weight:500}
.dbb-rte{border:1px solid var(--line);border-radius:10px;overflow:hidden;background:#fff}
.dbb-rte:focus-within{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 16%,transparent)}
.dbb-rte-bar{display:flex;flex-wrap:wrap;gap:3px;padding:5px;background:#f6f7f9;border-bottom:1px solid var(--line);align-items:center}
.dbb-rte-bar button{width:28px;height:28px;border:0;background:none;border-radius:6px;cursor:pointer;color:var(--ink-2);display:inline-flex;align-items:center;justify-content:center;padding:0}
.dbb-rte-bar button:hover{background:#fff;color:var(--ink);box-shadow:0 1px 2px rgba(0,0,0,.1)}
.dbb-rte-bar button svg{width:16px;height:16px}
.dbb-rte-bar select{font:inherit;font-size:11.5px;padding:4px 4px;border:1px solid var(--line);border-radius:6px;background:#fff;max-width:96px;height:28px}
.dbb-rte-bar .sep{width:1px;height:18px;background:var(--line);margin:0 2px}
.dbb-rte-col{position:relative;width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;border-radius:6px;cursor:pointer;font-weight:700;font-size:13px}
.dbb-rte-col:hover{background:#fff}
.dbb-rte-col input{position:absolute;inset:0;opacity:0;cursor:pointer}
.dbb-rte-link{display:flex;gap:6px;padding:6px;border-bottom:1px solid var(--line);background:#fffbe8}
.dbb-rte-link[hidden]{display:none}
.dbb-rte-link input{flex:1}
.dbb-rte-ed{padding:10px 12px;outline:none;font-size:13px;max-height:340px;overflow:auto;height:auto!important}
.dbb-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;z-index:1;padding:20px}
.dbb-empty[hidden]{display:none}
.dbb-empty-card{pointer-events:auto;background:var(--surface);color:var(--ink);border:1px solid var(--line);border-radius:16px;padding:26px 28px;max-width:680px;text-align:center;box-shadow:0 10px 30px rgba(16,24,40,.08)}
.dbb-empty-t{font-size:18px;font-weight:600;margin-bottom:6px;letter-spacing:-.01em}
.dbb-empty-s{font-size:13px;color:var(--ink-2);margin:6px 0}
.dbb-empty-a{display:flex;gap:8px;justify-content:center;margin-top:14px;flex-wrap:wrap}
.dbb-tpl-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:12px;margin-top:10px}
.dbb-tpl-grid.mini{grid-template-columns:repeat(4,1fr);gap:10px;margin-top:16px;text-align:left}
.dbb-tpl{border:1px solid var(--line);background:#fff;border-radius:12px;padding:8px;cursor:pointer;font:inherit;text-align:left;display:flex;flex-direction:column;gap:4px;transition:border-color .12s,transform .12s,box-shadow .12s;color:#0b0b0b}
.dbb-tpl:hover{border-color:var(--accent);transform:translateY(-2px);box-shadow:0 8px 20px rgba(16,24,40,.1)}
.dbb-tpl .pv{height:74px;border-radius:8px;display:grid;grid-template-columns:repeat(3,1fr);grid-template-rows:1fr 1fr;gap:5px;padding:7px;margin-bottom:4px}
.dbb-tpl .pv i{border-radius:5px;position:relative;box-shadow:0 1px 2px rgba(0,0,0,.08)}
.dbb-tpl .pv b{position:absolute;left:5px;bottom:5px;height:5px;width:45%;border-radius:3px}
.dbb-tpl .nm{font-weight:600;font-size:13px}
.dbb-tpl .ds{font-size:11px;color:#6e6d68;line-height:1.35;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.dbb-tpl-grid.mini .dbb-tpl .ds{display:none}
.dbb-tpl-grid.mini .dbb-tpl .pv{height:54px}
.dbb-busy{position:absolute;right:16px;bottom:16px;background:#1a1a19;color:#fff;border-radius:10px;padding:9px 13px;display:flex;gap:8px;align-items:center;font-size:12px;z-index:20;box-shadow:0 6px 18px rgba(0,0,0,.2)}
.dbb-busy[hidden]{display:none}
.dbb-spin{width:14px;height:14px;border:2px solid rgba(255,255,255,.3);border-top-color:var(--accent);border-radius:50%;animation:dbbspin .8s linear infinite}
@keyframes dbbspin{to{transform:rotate(360deg)}}
.dbb-chat{display:flex;flex-direction:column;height:100%;gap:8px;min-height:0}
.dbb-chat-log{flex:1;overflow:auto;display:flex;flex-direction:column;gap:8px;min-height:120px}
.dbb-msg{padding:9px 12px;border-radius:14px;font-size:13px;line-height:1.45;max-width:92%}
.dbb-msg.user{background:var(--accent);color:#fff;align-self:flex-end;border-bottom-right-radius:4px}
.dbb-msg.assistant{background:#f1f2f4;align-self:flex-start;border-bottom-left-radius:4px}
.dbb-msg.system{background:none;color:var(--ink-3);font-size:12px;align-self:center;padding:2px}
.dbb-msg-sum{font-size:11px;color:var(--ink-2);margin-top:4px}
.dbb-msg-sum a{color:var(--accent)}
.dbb-opts{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.dbb-chat-bar{display:flex;gap:6px;flex-wrap:wrap}
.dbb-chat-form{display:flex;gap:6px;align-items:flex-end}
.dbb-chat-form textarea{flex:1;font:inherit;padding:9px;border:1px solid var(--line);border-radius:12px;resize:none}
.dbb-typing{color:var(--ink-3)}
.dbb-msg-busy{display:flex;flex-direction:column;gap:7px;min-width:140px}
.dbb-msg-busy .imx-prog{width:100%}
.dbb-modal{position:absolute;inset:0;background:rgba(10,14,20,.42);backdrop-filter:blur(2px);display:flex;align-items:center;justify-content:center;z-index:30}
.dbb-modal-box{background:#fff;border-radius:14px;min-width:360px;max-width:min(820px,94vw);max-height:86vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.3);animation:dbbfade .18s ease-out}
.dbb-modal-h{font-size:16px;font-weight:600;padding:16px 18px 6px;line-height:1.35;margin:0}
.dbb-modal-b{padding:6px 18px;overflow:auto;font-size:13px;line-height:1.45}
.dbb-modal-f{display:flex;justify-content:flex-end;gap:8px;padding:12px 18px 16px}
.dbb-preview{display:flex;flex-direction:column;gap:6px;margin-top:6px}
.dbb-nd *::before,.dbb-nd *::after,.dbb-modal::before,.dbb-modal::after,.dbb-modal-box::before,.dbb-modal-box::after,.dbb-modal-box>*::before,.dbb-modal-box>*::after,.dbb-modal-f>*::before,.dbb-modal-f>*::after{content:none!important;display:none!important}
.dbb-nd,.dbb-nd *{box-sizing:border-box;font-family:Inter,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;float:none;text-indent:0}
.dbb-nd{width:min(560px,86vw);display:flex;flex-direction:column;gap:18px;padding:4px 0 6px;color:#1f2933}
.dbb-nd-sec{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;border:0;background:none}
.dbb-nd-sec[hidden]{display:none}
.dbb-nd-cap{display:block;font-size:12px;font-weight:600;letter-spacing:.02em;color:#5c6470;line-height:1.2;margin:0;padding:0;background:none;border:0;list-style:none}
.dbb-nd-in{display:block;width:100%;height:38px;padding:0 12px;font-size:14px;line-height:38px;color:#1f2933;background:#fff;border:1px solid #d5d9e0;border-radius:8px;outline:none;margin:0;box-shadow:none;appearance:none}
.dbb-nd-in:focus{border-color:#2a78d6;box-shadow:0 0 0 3px rgba(42,120,214,.16)}
.dbb-nd-cards{display:flex;flex-direction:column;gap:10px;margin:0;padding:0}
.dbb-nd-opt{display:flex;flex-direction:row;gap:12px;align-items:flex-start;width:100%;padding:14px 16px;border:1px solid #e1e4ea;border-radius:10px;cursor:pointer;background:#fff;transition:border-color .12s,background .12s,box-shadow .12s;margin:0;font-weight:400;text-align:left;outline:none}
.dbb-nd-opt:hover{border-color:#b9d3f3}
.dbb-nd-opt:focus-visible{box-shadow:0 0 0 3px rgba(42,120,214,.2)}
.dbb-nd-opt.on{border-color:#2a78d6;box-shadow:0 0 0 1px #2a78d6 inset}
.dbb-nd-opt.off{opacity:.55;cursor:not-allowed}
.dbb-nd-dot{flex:none;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;margin:1px 0 0;padding:0;border-radius:50%;border:1.5px solid #b4bac4;background:#fff}
.dbb-nd-dot>span{display:block;width:8px;height:8px;border-radius:50%;background:transparent}
.dbb-nd-opt.on .dbb-nd-dot{border-color:#2a78d6}
.dbb-nd-opt.on .dbb-nd-dot>span{background:#2a78d6}
.dbb-nd-txt{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1;margin:0;padding:0}
.dbb-nd-t{display:block;font-size:14px;font-weight:600;color:#111827;line-height:1.3;margin:0}
.dbb-nd-d{display:block;font-size:13px;color:#5c6470;line-height:1.5;margin:0}
.dbb-st,.dbb-st *{box-sizing:border-box;font-family:Inter,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
.dbb-st{pointer-events:auto;width:min(760px,100%);background:#fff;color:#1f2933;border:1px solid #e6e8ec;border-radius:16px;box-shadow:0 12px 36px rgba(16,24,40,.10);padding:28px 28px 22px;display:flex;flex-direction:column;gap:22px;max-height:calc(100% - 8px);overflow:auto}
.dbb-st-head{display:flex;flex-direction:column;gap:6px}
.dbb-st-h1{font-size:20px;font-weight:600;letter-spacing:-.01em;color:#111827;line-height:1.25}
.dbb-st-sub{font-size:13.5px;color:#5c6470;line-height:1.5}
.dbb-st .dbb-st-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}
.dbb-st button{all:unset;box-sizing:border-box;cursor:pointer}
.dbb-st .dbb-st-tile{display:flex;flex-direction:column;align-items:flex-start;gap:6px;padding:16px;border:1px solid #e1e4ea;border-radius:12px;background:#fff;transition:border-color .12s,box-shadow .12s,transform .12s;text-align:left}
.dbb-st .dbb-st-tile:hover,.dbb-st .dbb-st-tile:focus-visible{border-color:#9cc0ee;box-shadow:0 6px 18px rgba(42,120,214,.12);transform:translateY(-1px)}
.dbb-st .dbb-st-tile:focus-visible{outline:2px solid #2a78d6;outline-offset:2px}
.dbb-st-ic{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:10px;background:#eef4fd;color:#2a78d6;margin-bottom:4px}
.dbb-st-ic svg{width:18px;height:18px}
.dbb-st .dbb-st-tile.primary{background:linear-gradient(135deg,#2a78d6,#4b8fe6);border-color:#2a78d6;color:#fff}
.dbb-st .dbb-st-tile.primary .dbb-st-ic{background:rgba(255,255,255,.18);color:#fff}
.dbb-st .dbb-st-tile.primary .dbb-st-td{color:#e3eefc}
.dbb-st .dbb-st-tile.primary:hover{box-shadow:0 8px 22px rgba(42,120,214,.32)}
.dbb-st-tt{font-size:14px;font-weight:600;line-height:1.3}
.dbb-st-td{font-size:12.5px;color:#6b7380;line-height:1.45}
.dbb-st-sec{display:flex;flex-direction:column;gap:10px}
.dbb-st-sh{font-size:11.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#6b7380}
.dbb-st-list{display:flex;flex-direction:column;border:1px solid #e6e8ec;border-radius:12px;overflow:hidden}
.dbb-st .dbb-st-row{display:flex;align-items:center;gap:12px;padding:11px 14px;border-bottom:1px solid #eef0f3;transition:background .12s}
.dbb-st .dbb-st-row:last-child{border-bottom:none}
.dbb-st .dbb-st-row:hover,.dbb-st .dbb-st-row:focus-visible{background:#f3f8fe}
.dbb-st .dbb-st-row:focus-visible{outline:2px solid #2a78d6;outline-offset:-2px}
.dbb-st-av{flex:none;display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:10px;color:#fff;font-size:13px;font-weight:600;letter-spacing:.02em}
.dbb-st-main{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1}
.dbb-st-name{font-size:14px;font-weight:600;color:#111827;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.3}
.dbb-st-meta{display:flex;align-items:center;gap:8px;font-size:12.5px;color:#6b7380;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dbb-st-tag{display:inline-block;padding:1px 8px;border-radius:999px;background:#eaf2fd;color:#1d5fb8;font-size:11.5px;font-weight:500}
.dbb-st-tag.ov{background:#f1eefd;color:#5b3fc4}
.dbb-st-time{flex:none;font-size:12px;color:#8a919c;white-space:nowrap}
.dbb-st-chev{flex:none;display:inline-flex;color:#9aa1ac}
.dbb-st-chev svg{width:16px;height:16px}
.dbb-st-skel{display:flex;align-items:center;gap:12px;height:58px;padding:11px 14px;border-bottom:1px solid #eef0f3}
.dbb-st-skel:last-child{border-bottom:none}
.dbb-st-skel .av{flex:none;width:36px;height:36px;border-radius:10px}
.dbb-st-skel .ln{display:flex;flex-direction:column;gap:7px;flex:1;min-width:0}
.dbb-st-skel .ln .imx-skel{height:11px;width:45%}
.dbb-st-skel .ln .imx-skel+.imx-skel{width:70%}
.dbb-st-none{padding:18px;text-align:center;font-size:13px;color:#6b7380}
.dbb-st-foot{font-size:12.5px;color:#8a919c;text-align:center}
@media (max-width:640px){.dbb-st{padding:20px 16px}.dbb-st-time{display:none}}
.dbb-modal-box.wide{width:min(1040px,94vw);max-width:min(1040px,94vw)}
/* D-027: Open dashboard dialog. Divs + grid (not <table>) so ThingsBoard's table styles can't change font or size. D-044: every header and value centred. */
.dbb-od,.dbb-od *{font-family:Inter,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;box-sizing:border-box}
.dbb-od-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:2px 0 12px}
.dbb-od-count{font-size:13px;color:#5c6470}
.dbb-od-list{border:1px solid #e6e8ec;border-radius:10px;overflow:auto;max-height:56vh}
.dbb-od-row{display:grid;grid-template-columns:minmax(220px,2.2fr) minmax(130px,1.2fr) 80px minmax(130px,1.3fr) minmax(170px,1.4fr);column-gap:24px;align-items:center;padding:11px 18px;border-bottom:1px solid #eef0f3;font-size:13.5px;color:#1f2933;line-height:1.35}
.dbb-od-row>*{text-align:center;min-width:0}
.dbb-od-row:last-child{border-bottom:none}
.dbb-od-head{position:sticky;top:0;z-index:1;background:#f7f8fa;font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:#6b7380;padding-top:10px;padding-bottom:10px}
.dbb-od-body .dbb-od-row{cursor:pointer;transition:background .12s}
.dbb-od-body .dbb-od-row:hover,.dbb-od-body .dbb-od-row:focus-visible{background:#f1f6fd;outline:none}
.dbb-od-name{font-weight:600;color:#111827;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dbb-od-name .dbb-od-sub{font-weight:400;color:#8a919c;margin-left:6px;font-size:12px}
.dbb-od-type{justify-self:center;display:inline-block;font-size:12px;font-weight:500;padding:3px 10px;border-radius:999px;background:#eaf2fd;color:#1d5fb8;white-space:nowrap}
.dbb-od-type.sa{background:#f1eefd;color:#5b3fc4}
.dbb-od-num{text-align:center;font-variant-numeric:tabular-nums}
.dbb-od-muted{color:#5c6470;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dbb-od-muted small{color:#8a919c;font-size:12px}
.dbb-od-empty{padding:28px;text-align:center;color:#6b7380;font-size:13px}
@media (max-width:760px){.dbb-od-row{grid-template-columns:1fr auto;row-gap:4px}.dbb-od-row>:nth-child(n+3){display:none}}
.dbb-toasts{position:absolute;left:50%;bottom:18px;transform:translateX(-50%);display:flex;flex-direction:column;gap:6px;z-index:40}
.dbb-toast{background:#1a1a19;color:#fff;padding:9px 16px;border-radius:10px;font-size:13px;max-width:70vw;box-shadow:0 6px 18px rgba(0,0,0,.2);animation:dbbfade .2s ease-out}
.dbb-toast.err{background:#8e2222}
.dbb-toast.warn{background:#7a5200}
@media (max-width:1100px){.dbb-left{width:170px}.dbb-palette{grid-template-columns:1fr}.dbb-right{width:300px}.dbb-tpl-grid.mini{grid-template-columns:1fr 1fr}}
/* D-056: the app's dark mode (html[data-imx-mode="dark"], App UI U-051). The builder's own panels, pickers, dialogs and
   chat take the app's dark colours; the canvas takes the dashboard theme (a light one drawn dark, render/theme.ts).
   Light mode is untouched: every rule below needs the dark attribute. */
html[data-imx-mode="dark"] .dbb-overlay{--surface:var(--imx-surface,#121A2B);--surface-2:var(--imx-surface2,#162036);--plane:var(--imx-bg,#0B1220);--line:var(--imx-line,#26324A);--grid:var(--imx-surface2,#162036);--ink:var(--imx-text,#E6EBF3);--ink-2:var(--imx-text2,#C9D3E1);--ink-3:var(--imx-muted,#97A6BC);--hover:var(--imx-ph,#1B263C);background:var(--imx-bg,#0B1220);color-scheme:dark}
html[data-imx-mode="dark"] .dbb-top,html[data-imx-mode="dark"] .dbb-left,html[data-imx-mode="dark"] .dbb-right,html[data-imx-mode="dark"] .dbb-pal-search,html[data-imx-mode="dark"] .dbb-pal,html[data-imx-mode="dark"] .dbb-pal.off:hover,html[data-imx-mode="dark"] .dbb-grp,html[data-imx-mode="dark"] .dbb-pk-trig,html[data-imx-mode="dark"] .dbb-pk-pop,html[data-imx-mode="dark"] .dbb-icons button,html[data-imx-mode="dark"] .dbb-rte,html[data-imx-mode="dark"] .dbb-tpl,html[data-imx-mode="dark"] .dbb-pk-row .box,html[data-imx-mode="dark"] .dbb-pk-row .dot{background-color:var(--imx-surface,#121A2B)}
html[data-imx-mode="dark"] .dbb-field input:not([type=range]):not([type=color]):not([type=checkbox]):not([type=file]),html[data-imx-mode="dark"] .dbb-field select,html[data-imx-mode="dark"] .dbb-field textarea,html[data-imx-mode="dark"] .dbb-sub select,html[data-imx-mode="dark"] .dbb-rule input,html[data-imx-mode="dark"] .dbb-rule select,html[data-imx-mode="dark"] .dbb-test input,html[data-imx-mode="dark"] .dbb-rte-link input,html[data-imx-mode="dark"] .dbb-pal-search input,html[data-imx-mode="dark"] .dbb-pk-s input,html[data-imx-mode="dark"] .dbb-rte-bar select,html[data-imx-mode="dark"] .dbb-chat-form textarea{background-color:var(--imx-surface2,#162036);color:var(--imx-text,#E6EBF3);border-color:var(--imx-line2,#33415C)}
html[data-imx-mode="dark"] .dbb-field input::placeholder,html[data-imx-mode="dark"] .dbb-field textarea::placeholder,html[data-imx-mode="dark"] .dbb-pal-search input::placeholder,html[data-imx-mode="dark"] .dbb-pk-s input::placeholder,html[data-imx-mode="dark"] .dbb-chat-form textarea::placeholder{color:var(--imx-muted,#97A6BC);opacity:1}
html[data-imx-mode="dark"] .dbb-tabs,html[data-imx-mode="dark"] .dbb-seg,html[data-imx-mode="dark"] .dbb-tip-row,html[data-imx-mode="dark"] .dbb-keys,html[data-imx-mode="dark"] .dbb-rule,html[data-imx-mode="dark"] .dbb-bgimg,html[data-imx-mode="dark"] .dbb-pk-f,html[data-imx-mode="dark"] .dbb-rte-bar,html[data-imx-mode="dark"] .dbb-msg.assistant,html[data-imx-mode="dark"] .dbb-od-head,html[data-imx-mode="dark"] .dbb-hint code,html[data-imx-mode="dark"] .dbb-tip-row code,html[data-imx-mode="dark"] .dbb-na,html[data-imx-mode="dark"] .dbb-pk-row .tag{background-color:var(--imx-surface2,#162036)}
html[data-imx-mode="dark"] .dbb-msg.assistant{color:var(--imx-text,#E6EBF3)}
html[data-imx-mode="dark"] .dbb-tab.on,html[data-imx-mode="dark"] .dbb-seg button.on{background:var(--imx-line,#26324A);color:var(--imx-text,#E6EBF3);box-shadow:none}
html[data-imx-mode="dark"] .dbb-pal:hover,html[data-imx-mode="dark"] .dbb-grp-h:hover,html[data-imx-mode="dark"] .dbb-pk-row:hover,html[data-imx-mode="dark"] .dbb-pk-row:focus,html[data-imx-mode="dark"] .dbb-pk-f button:hover,html[data-imx-mode="dark"] .dbb-x:hover,html[data-imx-mode="dark"] .dbb-rte-bar button:hover,html[data-imx-mode="dark"] .dbb-rte-col:hover,html[data-imx-mode="dark"] .dbb-st .dbb-st-row:hover,html[data-imx-mode="dark"] .dbb-st .dbb-st-row:focus-visible,html[data-imx-mode="dark"] .dbb-od-body .dbb-od-row:hover,html[data-imx-mode="dark"] .dbb-od-body .dbb-od-row:focus-visible{background:var(--imx-ph,#1B263C)}
html[data-imx-mode="dark"] .dbb-pal:hover{box-shadow:0 3px 10px rgba(0,0,0,.35)}
html[data-imx-mode="dark"] .dbb-pk-row.dis:hover{background:none}
html[data-imx-mode="dark"] .dbb-btn.on{background:color-mix(in srgb,var(--accent) 18%,var(--imx-surface,#121A2B));color:color-mix(in srgb,var(--accent) 55%,#fff)}
html[data-imx-mode="dark"] .dbb-sel-h .ic,html[data-imx-mode="dark"] .dbb-grp-h .n{background:color-mix(in srgb,var(--accent) 20%,var(--imx-surface,#121A2B));color:color-mix(in srgb,var(--accent) 55%,#fff)}
html[data-imx-mode="dark"] .dbb-pk-trig .chip{background:color-mix(in srgb,var(--accent) 20%,var(--imx-surface,#121A2B));color:color-mix(in srgb,var(--accent) 45%,#fff)}
html[data-imx-mode="dark"] .dbb-pk-trig .chip .x:hover{background:color-mix(in srgb,var(--accent) 34%,var(--imx-surface,#121A2B))}
html[data-imx-mode="dark"] .dbb-pk-row .box,html[data-imx-mode="dark"] .dbb-pk-row .dot{border-color:var(--imx-line2,#33415C)}
html[data-imx-mode="dark"] .dbb-pk-row.on .box{background:var(--accent);border-color:var(--accent)}
html[data-imx-mode="dark"] .dbb-pk-row.on .dot{border-color:var(--accent)}
html[data-imx-mode="dark"] .dbb-swatch{border-color:rgba(255,255,255,.18);box-shadow:inset 0 0 0 2px rgba(0,0,0,.25)}
html[data-imx-mode="dark"] .dbb-swatch.empty{background:repeating-conic-gradient(var(--imx-line2,#33415C) 0 25%,var(--imx-surface,#121A2B) 0 50%) 0 0/10px 10px}
html[data-imx-mode="dark"] .dbb-sw-row button{border-color:rgba(255,255,255,.18)}
html[data-imx-mode="dark"] .dbb-rte-link{background:rgba(245,158,11,.12)}
html[data-imx-mode="dark"] .dbb-count.full{color:#F0A070}
html[data-imx-mode="dark"] .dbb-bgst.ok{color:var(--imx-ok-tx,#86EFAC)}
html[data-imx-mode="dark"] .dbb-tpl{color:var(--imx-text,#E6EBF3)}
html[data-imx-mode="dark"] .dbb-tpl .ds{color:var(--imx-muted,#97A6BC)}
html[data-imx-mode="dark"] .dbb-tpl:hover{box-shadow:0 8px 20px rgba(0,0,0,.4)}
html[data-imx-mode="dark"] .dbb-overlay .dbb-banner{background:rgba(57,135,229,.14);color:#B7D3F6}
html[data-imx-mode="dark"] .dbb-overlay .dbb-banner.warn{background:rgba(245,158,11,.16);color:#FCD34D}
html[data-imx-mode="dark"] .dbb-overlay .dbb-banner.err{background:rgba(239,68,68,.16);color:#FCA5A5}
html[data-imx-mode="dark"] .dbb-modal{background:rgba(2,6,15,.62)}
html[data-imx-mode="dark"] .dbb-modal-box{background:var(--imx-surface,#121A2B);color:var(--imx-text,#E6EBF3);border:1px solid var(--imx-line,#26324A);box-shadow:0 24px 64px rgba(0,0,0,.55)}
html[data-imx-mode="dark"] .dbb-modal-box .dbb-btn:not(.primary){background:var(--imx-surface,#121A2B);border-color:var(--imx-line2,#33415C);color:var(--imx-text,#E6EBF3)}
html[data-imx-mode="dark"] .dbb-modal-box .dbb-btn:not(.primary):hover{background:var(--imx-ph,#1B263C)}
html[data-imx-mode="dark"] .dbb-nd{color:var(--imx-text,#E6EBF3)}
html[data-imx-mode="dark"] .dbb-nd-cap,html[data-imx-mode="dark"] .dbb-nd-d{color:var(--imx-muted,#97A6BC)}
html[data-imx-mode="dark"] .dbb-nd-t{color:var(--imx-text,#E6EBF3)}
html[data-imx-mode="dark"] .dbb-nd-in{color:var(--imx-text,#E6EBF3);background:var(--imx-surface2,#162036);border-color:var(--imx-line2,#33415C)}
html[data-imx-mode="dark"] .dbb-nd-opt{background:var(--imx-surface,#121A2B);border-color:var(--imx-line,#26324A)}
html[data-imx-mode="dark"] .dbb-nd-opt:hover{border-color:var(--imx-line2,#33415C)}
html[data-imx-mode="dark"] .dbb-nd-opt.on{border-color:#3987e5;box-shadow:0 0 0 1px #3987e5 inset}
html[data-imx-mode="dark"] .dbb-nd-dot{background:var(--imx-surface,#121A2B);border-color:var(--imx-line2,#33415C)}
html[data-imx-mode="dark"] .dbb-nd-opt.on .dbb-nd-dot{border-color:#3987e5}
html[data-imx-mode="dark"] .dbb-nd-opt.on .dbb-nd-dot>span{background:#3987e5}
html[data-imx-mode="dark"] .dbb-st{background:var(--imx-surface,#121A2B);color:var(--imx-text,#E6EBF3);border-color:var(--imx-line,#26324A);box-shadow:0 12px 36px rgba(0,0,0,.4)}
html[data-imx-mode="dark"] .dbb-st-h1,html[data-imx-mode="dark"] .dbb-st-name{color:var(--imx-text,#E6EBF3)}
html[data-imx-mode="dark"] .dbb-st-sub,html[data-imx-mode="dark"] .dbb-st-td,html[data-imx-mode="dark"] .dbb-st-sh,html[data-imx-mode="dark"] .dbb-st-meta,html[data-imx-mode="dark"] .dbb-st-time,html[data-imx-mode="dark"] .dbb-st-chev,html[data-imx-mode="dark"] .dbb-st-none,html[data-imx-mode="dark"] .dbb-st-foot{color:var(--imx-muted,#97A6BC)}
html[data-imx-mode="dark"] .dbb-st .dbb-st-tile{background-color:var(--imx-surface2,#162036);border-color:var(--imx-line,#26324A)}
html[data-imx-mode="dark"] .dbb-st .dbb-st-tile:hover,html[data-imx-mode="dark"] .dbb-st .dbb-st-tile:focus-visible{border-color:var(--imx-line2,#33415C);box-shadow:0 6px 18px rgba(0,0,0,.35)}
html[data-imx-mode="dark"] .dbb-st .dbb-st-tile.primary{border-color:#2a78d6}
html[data-imx-mode="dark"] .dbb-st .dbb-st-tile.primary .dbb-st-td{color:#e3eefc}
html[data-imx-mode="dark"] .dbb-st-ic{background:rgba(57,135,229,.18);color:#9EC5F4}
html[data-imx-mode="dark"] .dbb-st-list{border-color:var(--imx-line,#26324A)}
html[data-imx-mode="dark"] .dbb-st .dbb-st-row,html[data-imx-mode="dark"] .dbb-st-skel{border-bottom-color:var(--imx-line,#26324A)}
html[data-imx-mode="dark"] .dbb-st-tag,html[data-imx-mode="dark"] .dbb-od-type{background:rgba(57,135,229,.18);color:#9EC5F4}
html[data-imx-mode="dark"] .dbb-st-tag.ov,html[data-imx-mode="dark"] .dbb-od-type.sa{background:rgba(144,133,233,.2);color:#C4BDF5}
html[data-imx-mode="dark"] .dbb-od-count,html[data-imx-mode="dark"] .dbb-od-muted,html[data-imx-mode="dark"] .dbb-od-muted small,html[data-imx-mode="dark"] .dbb-od-name .dbb-od-sub,html[data-imx-mode="dark"] .dbb-od-empty,html[data-imx-mode="dark"] .dbb-od-head{color:var(--imx-muted,#97A6BC)}
html[data-imx-mode="dark"] .dbb-od-list{border-color:var(--imx-line,#26324A)}
html[data-imx-mode="dark"] .dbb-od-row{border-bottom-color:var(--imx-line,#26324A);color:var(--imx-text2,#C9D3E1)}
html[data-imx-mode="dark"] .dbb-od-name{color:var(--imx-text,#E6EBF3)}
/* D-074 (UI audit H2): the app's drop-down (kit, window.imxKit.selects) on the Builder's selects, at the Builder's
   field size and font; its colours, list and dark mode are the kit's. Compact in the top bar, the rich-text toolbar
   and the colour-rule rows (as narrow as the native selects there were). */
.dbb-overlay button.imx-dd-b.imx-dd-b.imx-dd-b{height:32px;font-family:inherit;font-size:12.5px;border-radius:8px;border-color:var(--line)}
.dbb-overlay button.imx-dd-b.imx-dd-b.imx-dd-b.imx-dd-sm{height:32px;font-size:12.5px}
.dbb-overlay .dbb-rte-bar button.imx-dd-b.imx-dd-b.imx-dd-b{height:28px;min-width:0!important;max-width:120px;padding:0 4px 0 7px;border-radius:6px;font-size:11.5px}
.dbb-overlay .dbb-rule-main button.imx-dd-b.imx-dd-b.imx-dd-b{flex:0 1 auto;min-width:0!important;max-width:120px}
`;
