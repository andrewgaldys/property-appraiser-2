import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './styles/app.css';
import './styles/brief.css';

import { DEFAULT_FILTERS } from './config';
import { DataStore } from './data';
import { h, icon, toast } from './dom';
import { MapController } from './map/controller';
import { Store, loadSavedView, saveView } from './state';
import type { AppState, Bbox, Manifest, OwnerRef, ParcelRecord, Portfolio, PortfolioItem, TileProps } from './types';
import { ActiveFilters } from './ui/activeFilters';
import { AerialCard } from './ui/aerial';
import { Brief } from './ui/brief';
import { Drawer } from './ui/drawer';
import { FilterPanel, type SectionId } from './ui/filters';
import { FirstVisitHint } from './ui/hint';
import { Legend } from './ui/legend';
import { OwnerProfile } from './ui/ownerProfile';
import { OwnersPanel } from './ui/owners';
import { ProspectingPanel } from './ui/prospecting';
import { ResultsPanel } from './ui/results';
import { SearchBox } from './ui/search';
import { ownerRefOf } from './results';
import { LocalScreenRepository, SCREEN_KEYS, paramsScreen, screenParams, type ScreenState } from './screens';
import { MAX_SET, resolveSearch } from './search';
import { Toolbar } from './ui/toolbar';
import { Tooltip } from './ui/tooltip';

// ---- URL hash: MapLibre owns `map=`, we own `p=` (selected parcel) ----------------
/**
 * Hash values must survive MapLibre's own hash updates, which re-serialize the whole hash and
 * percent-decode it on every map move (a raw "&" or "+" would then split or change a value). So
 * values use only characters that come through that unchanged: letters, digits, -_.!*'() , : /,
 * "+" for a space and "~XX" for every other byte.
 */
function encodeHashValue(v: string): string {
  return encodeURIComponent(v)
    .replace(/~/g, '%7E')
    .replace(/%2C/g, ',')
    .replace(/%3A/g, ':')
    .replace(/%2F/g, '/')
    .replace(/%20/g, '+')
    .replace(/%/g, '~');
}

function decodeHashValue(v: string): string {
  try {
    return decodeURIComponent(v.replace(/\+/g, ' ').replace(/~(?=[0-9A-Fa-f]{2})/g, '%'));
  } catch {
    return v;
  }
}

function hashParam(key: string): string | null {
  for (const part of window.location.hash.slice(1).split('&')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i) === key) return decodeHashValue(part.slice(i + 1));
  }
  return null;
}

function setHashParam(key: string, value: string | null): void {
  setHashParams({ [key]: value });
}

/** Set several hash params in one history entry replace (null removes); other params are kept. */
function setHashParams(values: Record<string, string | null | undefined>): void {
  const keys = new Set(Object.keys(values));
  const parts = window.location.hash
    .slice(1)
    .split('&')
    .filter((p) => p && !keys.has(p.split('=')[0]!));
  for (const [k, v] of Object.entries(values)) if (v) parts.push(`${k}=${encodeHashValue(v)}`);
  const url = `${window.location.pathname}${window.location.search}${parts.length ? `#${parts.join('&')}` : ''}`;
  window.history.replaceState(window.history.state, '', url);
}

function fatal(message: string, detail?: string): void {
  document.body.append(
    h(
      'div',
      { class: 'fatal', role: 'alert' },
      h('h1', null, 'Data bundle not found'),
      h('p', null, message),
      detail ? h('pre', null, detail) : null,
    ),
  );
}

async function boot(): Promise<void> {
  const data = new DataStore();
  let manifest: Manifest;
  try {
    manifest = await data.loadManifest();
  } catch (err) {
    fatal(
      `Could not load ${data.url('manifest.json')}. Generate the sample data first, then reload:`,
      'python pipeline/generate_sample_data.py',
    );
    console.error(err);
    return;
  }

  // A link that carries a screen (filters, presets, search, grouping, table) wins over this browser's last view.
  const linked = paramsScreen(hashParam);
  const store = new Store<AppState>({
    filters: { ...DEFAULT_FILTERS },
    extrude: 'value',
    shade: 'class',
    basemap: 'dark',
    lens: true,
    selection: null,
    focus: false,
    ownerGroup: 'name',
    search: null,
    ownerFocus: null,
    ...loadSavedView(),
    ...(linked
      ? { filters: linked.filters, ownerGroup: linked.ownerGroup, extrude: linked.extrude ?? 'value', shade: linked.shade ?? 'class' }
      : {}),
  });
  store.subscribe((s, prev) => {
    if (
      s.filters !== prev.filters || s.extrude !== prev.extrude || s.shade !== prev.shade ||
      s.basemap !== prev.basemap || s.lens !== prev.lens || s.ownerGroup !== prev.ownerGroup
    ) saveView(s);
  });

  const mapEl = document.getElementById('map')!;
  const tooltip = new Tooltip(manifest, (pid) => data.parcel(pid));
  const brief = new Brief();
  const aerial = new AerialCard(manifest, data);
  let current: { rec: ParcelRecord; portfolio: Portfolio | null } | null = null;
  let token = 0;

  const drawer = new Drawer(document.getElementById('drawer')!, manifest, {
    onClose: () => clearSelection(),
    onSelectItem: (it: PortfolioItem) => void select(it.parcel_id, { fly: true, keepFocus: true }),
    onFitPortfolio: (items) => mapc.fitItems(items),
    onToggleFocus: () => toggleFocus(),
    onExport: () => void exportBrief(),
    onCopyLink: () => copyLink('Link to this parcel copied'),
    onBack: () => clearSelection(),
    onOwnerProfile: () => {
      if (current) void openOwner(refForRecord(current.rec));
    },
  }, aerial);

  // Owner profile: the drawer-sized panel the parcel drawer opens on top of.
  const profile = new OwnerProfile(manifest, {
    onClose: () => closeOwner(),
    onSelectParcel: (pid) => void select(pid, { fly: true }),
    onOpenOwner: (ref) => void openOwner(ref),
    onCopyLink: () => copyLink('Link to this owner copied'),
  });
  document.getElementById('app')!.append(profile.el);

  function copyLink(done: string): void {
    navigator.clipboard?.writeText(window.location.href).then(
      () => toast(done),
      () => toast('Copy failed: use the address bar'),
    );
  }

  const mapc: MapController = new MapController(
    mapEl,
    manifest,
    data,
    store,
    {
      onReady: () => {
        document.body.classList.add('map-ready');
        const pid = hashParam('p');
        const owner = hashParam('o');
        if (owner) void openOwnerFromHash(owner, !pid);
        if (pid) void select(pid, { fly: true });
      },
      onSelect: (props: TileProps) => void select(props.pid, { hint: props }),
      onClear: () => clearSelection(),
      onStats: (s) => {
        panel.setStats(s);
        owners.setStats(s);
      },
    },
    tooltip,
  );

  const panel = new FilterPanel(document.getElementById('filters')!, manifest, store, {
    onCounty: (code) => {
      if (!code) return;
      const c = manifest.counties.find((x) => x.code === code);
      if (c) mapc.fitBbox(c.bbox, { maxZoom: 12.5 });
    },
    onMarket: (b: Bbox) => {
      if (window.matchMedia('(max-width: 900px)').matches) setPanelOpen(false);
      mapc.fitBbox(b, { maxZoom: 15.3, pitch: store.get().extrude === 'flat' ? 0 : 55 });
    },
    onShowResults: () => {
      if (window.matchMedia('(max-width: 900px)').matches) setPanelOpen(false);
      results.show('owners');
    },
  });
  // Top owners in view: sits right under the In-view totals it shares a computation with.
  const owners = new OwnersPanel(manifest, data, store, {
    onPick: (row) => {
      if (window.matchMedia('(max-width: 900px)').matches) setPanelOpen(false);
      void openOwner({ kind: row.kind, id: row.id }, { fit: false });
    },
  });
  document.querySelector('#filters .inview')?.after(owners.el);

  // Prospecting presets + saved screens, right under Top owners.
  const prospecting = new ProspectingPanel(manifest, store, new LocalScreenRepository(), {
    capture: () => captureScreen(true),
    apply: (state) => applyScreen(state, true),
    copyLink: () => copyLink('Link to this screen copied'),
  });
  owners.el.after(prospecting.el);
  const legend = new Legend(mapEl, manifest, store);

  // Owners & parcels tables under the map: every matching parcel, grouped into owners.
  const RESULTS_BAR = 46;
  /** True while a link or saved screen sets the table: the map keeps its (linked) center. */
  let restoring = false;
  const results = new ResultsPanel(manifest, data, store, {
    onOpenOwner: (ref) => void openOwner(ref),
    onSelectParcel: (pid) => void select(pid, { fly: true }),
    onLayout: (px) => {
      legend.setTableOpen(px > RESULTS_BAR);
      // On phones the open table covers the map, so the map's own controls stay put under it.
      const phone = window.matchMedia('(max-width: 720px)').matches;
      const h = phone ? RESULTS_BAR : Math.round(px);
      mapEl.style.setProperty('--results-h', `${h}px`);
      mapc.setBottomInset(h, restoring);
    },
    viewBbox: () => mapc.viewBbox(),
    onStateChange: () => writeScreenHash(),
  });
  mapEl.append(results.el);
  mapEl.style.setProperty('--results-h', `${RESULTS_BAR}px`);
  mapc.map.on('moveend', () => results.mapMoved());
  window.addEventListener('resize', () => results.relayout());

  // Map overlay, top-left: [Filters (narrow screens)] [basemap + lens], then the applied-filter chips.
  const panelToggle = h(
    'button',
    {
      type: 'button',
      class: 'panel-toggle',
      'aria-controls': 'filters',
      'aria-expanded': 'false',
      onclick: () => setPanelOpen(!document.body.classList.contains('panel-open')),
    },
    icon('filters'),
    'Filters',
  );
  // Search: owners, addresses, parcel IDs, property types, mailing addresses ("/" from anywhere).
  const searchBox = new SearchBox(manifest, data, store, {
    onShowSet: (set) => {
      firstHint.dismiss();
      store.set({ search: set });
      mapc.fitBbox(set.bbox, { maxZoom: 16 });
    },
    onSelectParcel: (pid) => {
      firstHint.dismiss();
      void select(pid, { fly: true });
    },
  });
  mapEl.append(
    h(
      'div',
      { class: 'map-top' },
      h('div', { class: 'map-top-row' }, panelToggle, searchBox.el, new Toolbar(store).el),
      new ActiveFilters(store).el,
    ),
  );

  function setPanelOpen(open: boolean): void {
    document.body.classList.toggle('panel-open', open);
    panelToggle.setAttribute('aria-expanded', String(open));
  }

  /** Bring a sidebar section into view (on narrow screens the sidebar slides in first). */
  function showSection(id: SectionId): void {
    if (window.matchMedia('(max-width: 900px)').matches) setPanelOpen(true);
    panel.openSection(id);
  }
  const firstHint = new FirstVisitHint(mapEl, {
    onPickMarket: () => showSection('markets'),
    onRunScreen: () => showSection('screens'),
  });
  // The hint has done its job once someone filters.
  store.subscribe((s, prev) => {
    if (firstHint.visible && s.filters !== prev.filters) firstHint.dismiss();
  });

  if (import.meta.env.DEV) {
    // Dev-only handle for console debugging (stripped from production builds).
    (window as unknown as Record<string, unknown>).__pa2 = { map: mapc.map, store, data };
  }

  function drawerInset(): number {
    return window.matchMedia('(max-width: 720px)').matches ? 0 : drawer.el.getBoundingClientRect().width;
  }

  /** focus: spotlight the parcel's portfolio right away (top-owner picks). */
  async function select(pid: string, opts: { fly?: boolean; hint?: TileProps; keepFocus?: boolean; focus?: boolean } = {}): Promise<void> {
    const my = ++token;
    const prev = store.get();
    const hint = opts.hint;
    firstHint.dismiss();
    const samePortfolio =
      !!prev.selection &&
      !!hint &&
      ((hint.onk != null && hint.onk === prev.selection.nameKey) || (hint.oak != null && hint.oak === prev.selection.addrKey));
    store.set({
      selection: { pid, nameKey: hint?.onk ?? null, addrKey: hint?.oak ?? null },
      focus: opts.focus ?? (prev.focus && (opts.keepFocus || samePortfolio)),
    });
    drawer.setBack(profile.isOpen ? profile.current?.label || 'owner' : null);
    drawer.showLoading(hint);
    mapc.setRightInset(drawerInset());
    try {
      const rec = await data.parcel(pid);
      if (my !== token) return;
      if (!rec) {
        drawer.showError(`Parcel ${pid} is not in this dataset.`);
        setHashParam('p', null);
        return;
      }
      store.set({ selection: { pid, nameKey: rec.owner_name_key, addrKey: rec.owner_addr_key } });
      current = { rec, portfolio: null };
      drawer.render(rec, undefined, store.get().focus);
      setHashParam('p', pid);
      if (opts.fly) mapc.flyToParcel(rec);
      else mapc.ensureVisible(rec);
      const pf = await data.portfolio(rec.owner_name_key, rec.owner_addr_key);
      if (my !== token) return;
      current = { rec, portfolio: pf };
      drawer.render(rec, pf, store.get().focus);
    } catch (err) {
      if (my !== token) return;
      console.error(err);
      drawer.showError('Could not load this parcel record. Check your connection and try again.');
    }
  }

  function clearSelection(): void {
    token++;
    current = null;
    store.set({ selection: null, focus: false });
    drawer.close();
    drawer.setBack(null);
    // Closing a parcel opened from an owner profile goes back to the profile.
    mapc.setRightInset(profile.isOpen ? drawerInset() : 0);
    setHashParam('p', null);
  }

  /** The owner group of a parcel record, by the current grouping (as in the tables and Top owners). */
  function refForRecord(rec: ParcelRecord): OwnerRef {
    return ownerRefOf({ pid: rec.parcel_id, onk: rec.owner_name_key, oak: rec.owner_addr_key }, store.get().ownerGroup, data.loadedIndex);
  }

  /** Open an owner profile: spotlight its parcels on the map and frame them. */
  async function openOwner(ref: OwnerRef, opts: { fit?: boolean } = {}): Promise<void> {
    firstHint.dismiss();
    let ix = data.loadedIndex;
    if (!ix) {
      toast('Loading owner data…', 1200);
      ix = await data.parcelIndex().catch(() => null);
    }
    if (!ix) {
      toast('Could not load owner data. Check your connection and try again.');
      return;
    }
    if (drawer.isOpen) {
      token++;
      current = null;
      store.set({ selection: null, focus: false });
      drawer.close();
      setHashParam('p', null);
    }
    store.set({ ownerFocus: ref });
    const rows = profile.show(ix, ref);
    mapc.setRightInset(drawerInset());
    if (rows.length && opts.fit !== false) mapc.fitItems(rows);
    setHashParam('o', rows[0] ? `${ref.kind}.${rows[0].pid}` : null);
  }

  function closeOwner(): void {
    profile.close();
    store.set({ ownerFocus: null });
    if (!drawer.isOpen) mapc.setRightInset(0);
    drawer.setBack(null);
    setHashParam('o', null);
  }

  // ---- Screens: the link always describes the current screen; saved screens and links restore it ----

  function captureScreen(withView: boolean): ScreenState {
    const s = store.get();
    const c = mapc.map.getCenter();
    return {
      filters: s.filters,
      search: s.search?.spec ?? null,
      ownerGroup: s.ownerGroup,
      extrude: s.extrude,
      shade: s.shade,
      results: results.getState(),
      ...(withView
        ? { view: { center: [c.lng, c.lat] as [number, number], zoom: mapc.map.getZoom(), bearing: mapc.map.getBearing(), pitch: mapc.map.getPitch() } }
        : {}),
    };
  }

  function writeScreenHash(): void {
    const p = screenParams(captureScreen(false));
    setHashParams(Object.fromEntries(SCREEN_KEYS.map((k) => [k, p[k] ?? null])));
  }

  /** Put a screen back: filters, search (rebuilt from the data), grouping, table, and the saved map view. */
  function applyScreen(state: ScreenState, fly: boolean): void {
    store.set({
      filters: state.filters,
      ownerGroup: state.ownerGroup,
      extrude: state.extrude ?? store.get().extrude,
      shade: state.shade ?? store.get().shade,
      search: null,
    });
    searchBox.setText('');
    if (state.search) void restoreSearch(state.search);
    if (state.results) restoreResults(state.results);
    if (fly && state.view) mapc.map.flyTo({ ...state.view, duration: 1400, essential: true });
    writeScreenHash();
  }

  function restoreResults(st: NonNullable<ScreenState['results']>): void {
    restoring = true;
    try {
      results.applyState(st);
    } finally {
      restoring = false;
    }
  }

  async function restoreSearch(spec: ScreenState['search']): Promise<void> {
    if (!spec) return;
    const ix = await data.parcelIndex().catch(() => null);
    const r = ix ? resolveSearch(ix, spec) : null;
    if (!r?.set) {
      toast(
        !r
          ? 'Search is unavailable right now, so the screen opened without its search.'
          : r.count
            ? `The search matches ${r.count.toLocaleString('en-US')} parcels, more than the ${MAX_SET.toLocaleString('en-US')} the map can show at once, so the screen opened without it.`
            : 'The search no longer matches any parcel, so the screen opened without it.',
      );
      return;
    }
    store.set({ search: r.set });
    searchBox.setText(spec.kind === 'query' ? spec.q : spec.kind === 'owner' ? spec.name : spec.label);
  }

  store.subscribe((s, prev) => {
    if (
      s.filters !== prev.filters || s.search !== prev.search || s.ownerGroup !== prev.ownerGroup ||
      s.extrude !== prev.extrude || s.shade !== prev.shade
    ) writeScreenHash();
  });
  if (linked) {
    if (linked.search) void restoreSearch(linked.search);
    if (linked.results?.open || linked.results?.scope === 'view') restoreResults(linked.results);
  }
  writeScreenHash();

  /** "o=n.<parcel id>": the owner-name (n), mailing-address (a) or single-parcel (p) group of that parcel. */
  async function openOwnerFromHash(value: string, fit: boolean): Promise<void> {
    const [kind, pid] = value.split('.');
    const ix = await data.parcelIndex().catch(() => null);
    const row = pid ? ix?.byPid.get(pid) : undefined;
    if (!row) return;
    const ref: OwnerRef =
      kind === 'a' && row.oak != null ? { kind: 'a', id: row.oak } : kind === 'n' && row.onk != null ? { kind: 'n', id: row.onk } : { kind: 'p', id: row.pid };
    await openOwner(ref, { fit });
  }

  function toggleFocus(): void {
    if (!current) return;
    const focus = !store.get().focus;
    store.set({ focus });
    drawer.render(current.rec, current.portfolio, focus);
    if (focus && current.portfolio) mapc.fitItems(current.portfolio.items);
  }

  async function exportBrief(): Promise<void> {
    if (!current) return;
    const { rec, portfolio } = current;
    const moved = new Promise<void>((resolve) => {
      const t = window.setTimeout(resolve, 2600);
      mapc.map.once('moveend', () => {
        window.clearTimeout(t);
        resolve();
      });
    });
    mapc.flyToParcel(rec);
    await moved;
    const image = await mapc.captureParcel(rec);
    const aerialImage = await aerial.snapshot();
    brief.open(rec, portfolio, image, manifest, aerialImage);
  }

  // A parcel or owner link pasted into an already-open tab only changes the hash: follow it.
  window.addEventListener('hashchange', () => {
    // A pasted screen link: apply it if it differs from what is on screen (no map needed for this).
    const pasted = paramsScreen(hashParam);
    if (pasted && JSON.stringify(screenParams(pasted)) !== JSON.stringify(screenParams(captureScreen(false)))) applyScreen(pasted, false);
    if (!mapc.isReady) return;
    const pid = hashParam('p');
    const cur = store.get().selection?.pid ?? null;
    if (pid && pid !== cur) void select(pid, { fly: true });
    else if (!pid && cur) clearSelection();
    const owner = hashParam('o');
    if (owner && !profile.isOpen) void openOwnerFromHash(owner, true);
    else if (!owner && profile.isOpen) closeOwner();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || brief.isOpen) return;
    if (document.body.classList.contains('panel-open')) setPanelOpen(false);
    else if (drawer.isOpen) clearSelection();
    else if (profile.isOpen) closeOwner();
  });
}

void boot();
