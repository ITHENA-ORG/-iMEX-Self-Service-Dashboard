/**
 * D-089 (15 Nov 2026): the Builder's own screens on the app's ONE type scale (App UI U-184 .. U-186,
 * docs/design/TYPE_SCALE.md there; AI Insights A-077, Reports D-139). The sizes and weights are the iMEX kit's tokens
 * (`--imx-fs-*` / `--imx-fw-*`, carried by kit-css.ts; each rule keeps the token's value as its fallback).
 *
 * Appended to the core CSS (theme.ts `CSS`, injected on every Builder page); every selector starts with `html ` so it
 * wins over the builder, list and menu sheets that are injected after it, without touching their lines. Only sizes and
 * weights: colours stay with the sheets (light and dark). The dashboards the Builder makes keep their own theme (card
 * titles, values and charts follow the dashboard's Theme, not this scale).
 *
 *   dialog title 17/700 · the panel's groups ("Widget", "Data source", "Theme") 14/700 · labels 12.5/600 · what a field
 *   holds 14 · hints 13 · eyebrows ("VALUES", "CHARTS") 11.5/700 · table headers 12/600 · a list row's name 14/600
 */
export const SCALE_CSS = `
html .dbb-modal-h{font-size:var(--imx-fs-dialog,17px);font-weight:var(--imx-fw-dialog,700)}
html .dbb-grp-h{font-size:var(--imx-fs-sub,14px);font-weight:var(--imx-fw-sub,700)}
html .dbb-sel-h .t{font-size:var(--imx-fs-value,14px);font-weight:var(--imx-fw-sub,700)}
html .dbb-field>span{font-size:var(--imx-fs-label,12.5px);font-weight:var(--imx-fw-label,600)}
html .dbb-field{font-size:var(--imx-fs-value,14px)}
html .dbb-field input[type=file]{font-size:var(--imx-fs-help,13px)}
html .dbb-hint{font-size:var(--imx-fs-help,13px)}
html .dbb-sec,html .dbb-emenu-sec{font-size:var(--imx-fs-meta,11.5px);font-weight:var(--imx-fw-meta,700)}
html .dbb-od-head{font-size:var(--imx-fs-th,12px);font-weight:var(--imx-fw-th,600)}
html .dbb-nd-cap{font-size:var(--imx-fs-label,12.5px);font-weight:var(--imx-fw-label,600)}
html .dbb-st-h1{font-size:var(--imx-fs-title,20px);font-weight:var(--imx-fw-title,700)}
html .dbb-st-sub,html .dbb-modal-b{font-size:var(--imx-fs-help,13px)}
html .dbb-dl .nm{font-size:var(--imx-fs-value,14px);font-weight:var(--imx-fw-strong,600)}
html .dbb-dl .meta,html .dbb-dl .ttl span{font-size:var(--imx-fs-help,13px)}
`;
