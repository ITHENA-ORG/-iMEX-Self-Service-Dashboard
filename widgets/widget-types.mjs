// ThingsBoard widget-type definitions (names, sizes, settings forms). Used by build.mjs to write one
// importable widget-type JSON per widget into widgets/dist/widget-types/. Keep in sync with deploy/deploy-browser.js.
//
// The deploy script has its own copy of these three objects (it is pasted into a browser console and
// can't import this module), so change both when adding or renaming a setting. Settings are read by
// the entry points as `tbCtx.settings.<name>` (see widgets/src/entries/*.ts for what each one does).
// Keys: launcher = tenant.imex_dbb_launcher, renderer = tenant.imex_dbb_renderer, listing = tenant.imex_dbb_listing.

/** Per widget type: JSON-schema `schema` and ThingsBoard `form` (field order) for the widget settings dialog. */
export const settingsSchemas = {
  launcher: {
    schema: {
      type: 'object',
      properties: {
        label: { title: 'Edit icon tooltip', type: 'string', default: 'Edit dashboards' },
        adminOnly: { title: 'No longer used (D-050): edit rights come from the role (dashboards.build)', type: 'boolean', default: true },
        homeState: { title: 'Home (map) state id', type: 'string', default: 'default' },
        homeLabel: { title: 'Home link label', type: 'string', default: 'Map page' },
        listingState: { title: 'Listing state id', type: 'string', default: 'listing' },
        listingLabel: { title: 'Listing link label', type: 'string', default: 'Listing page' },
        machineState: { title: 'Machine state id', type: 'string', default: 'machine' },
        machineLabel: { title: 'Machine state label', type: 'string', default: 'Machine page' },
        customerId: { title: 'Customer id to show when a tenant admin opens the app', type: 'string', default: '' },
        navbar: { title: 'Render as full navbar (stand-in app)', type: 'boolean', default: false },
        appName: { title: 'App name (navbar mode)', type: 'string', default: 'iMEX' },
        lightStyle: { title: 'Light icon button (for light headers)', type: 'boolean', default: false },
        chatEnabled: { title: 'Enable chat', type: 'boolean', default: true },
        chatEnabledRoles: { title: 'No longer used (D-050): chat follows chatEnabled only', type: 'string', default: '' },
        hideForRoles: { title: 'No longer used (D-050): the icon is removed when the role hides Dashboards', type: 'string', default: '' },
        dashboardList: { title: 'Show "Dashboard list" (standalone dashboards) to every user', type: 'boolean', default: true },
        overviewState: { title: 'Dashboard Overview state id (standalone dashboards)', type: 'string', default: 'dashboard_overview' },
          builderTop: { title: 'Dashboard Builder starts below (auto = below the navbar; px; 0 = full screen)', type: 'string', default: 'auto' },
          headless: { title: 'Headless: draw nothing, only provide the builder API (window.IMEX_DBB) for an app menu of its own', type: 'boolean', default: false },
      },
    },
    form: ['label', 'adminOnly', 'navbar', 'appName', 'homeState', 'homeLabel', 'listingState', 'listingLabel', 'machineState', 'machineLabel', 'customerId', 'lightStyle', 'chatEnabled', 'chatEnabledRoles', 'hideForRoles', 'dashboardList', 'overviewState', 'builderTop', 'headless'],
  },
  renderer: {
    schema: { type: 'object', properties: { refreshSeconds: { title: 'Refresh every (s)', type: 'number', default: 10 }, chatEnabled: { title: 'Enable chat in builder', type: 'boolean', default: true }, customerId: { title: 'Customer id for tenant admins', type: 'string', default: '' }, analyzerState: { title: 'State that the Analyzer button of the bar opens (analytics = the Analyzer; trend = the phone Trend screen)', type: 'string', default: 'analytics' } } },
    form: ['refreshSeconds', 'chatEnabled', 'customerId', 'analyzerState'],
  },
  listing: {
    schema: {
      type: 'object',
      properties: {
        mode: { title: "Mode ('listing' or 'map')", type: 'string', default: 'listing' },
        machineState: { title: 'Machine state id', type: 'string', default: 'machine' },
        dashboardState: { title: 'Standalone dashboard state id', type: 'string', default: 'dashboard' },
        title: { title: 'Map mode: title', type: 'string', default: 'Map page' },
        buttonLabel: { title: 'Map mode: button label', type: 'string', default: 'Go to machine listing' },
        listingState: { title: 'Map mode: listing state id', type: 'string', default: 'listing' },
        siteProfile: { title: 'Map mode: asset profile of the site nodes', type: 'string', default: 'Site' },
        customerId: { title: 'Customer id for tenant admins', type: 'string', default: '' },
      },
    },
    form: ['mode', 'machineState', 'dashboardState', 'title', 'buttonLabel', 'listingState', 'siteProfile', 'customerId'],
  },
};
/** Widget type display names (also the default widget title). */
export const names = { launcher: 'iMEX Navbar / edit menu', renderer: 'iMEX Machine dashboard', listing: 'iMEX Listing / Map page (stand-in)' };
/** Default size [sizeX, sizeY] in ThingsBoard grid cells when the widget is added to a dashboard. */
export const sizes = { launcher: [6, 1], renderer: [24, 12], listing: [24, 12] };
