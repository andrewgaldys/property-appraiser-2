import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './styles/app.css';
import './styles/brief.css';

import { DEFAULT_FILTERS, STARTER_SCREENS } from './config';
import { DataStore } from './data';
import { h, icon, toast } from './dom';
import { MapController } from './map/controller';
import { Store, loadSavedView, saveView } from './state';
import type { AppState, Bbox, Manifest, OwnerRef, ParcelRecord, Portfolio, PortfolioItem, TileProps } from './types';
import { ActiveFilters } from './ui/activeFilters';
import { AerialCard } from './ui/aerial';
import { Brief } from './ui/brief';
import { Drawer } from './ui/drawer';
import { DebtCard } from './ui/debtCard';
import { EntityCard } from './ui/entityCard';
import { SignalChips } from './ui/signalChips';
import { FilterPanel } from './ui/filters';
import { HelpDialog } from './ui/help';
import { FirstVisitHint } from './ui/hint';
import { Legend } from './ui/legend';
import { OwnerProfile } from './ui/ownerProfile';
import { OwnersPanel } from './ui/owners';
import { ProspectingPanel } from './ui/prospecting';
import { Rail } from './ui/rail';
import { ResultsPanel } from './ui/results';
import { SearchBox } from './ui/search';
import { ownerRefOf } from './results';
import { initSignals, isSignalPreset, setSignalFlags } from './signals';
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
    initSignals(manifest);
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

  // The owner's state business record (Sunbiz) in the parcel panel. A principal who also appears on
  // other owners' records opens the owner profile, where those owners are listed.
  const entityCard = new EntityCard(data, manifest, {
    linked: () =>
      h(
        'button',
        {
          type: 'button',
          class: 'ent-link',
          title: 'Other owners whose state record lists this person or company: see the owner profile',
          onclick: () => {
            if (current) void openOwner(refForRecord(current.rec));
          },
        },
        'Other owners',
        icon('arrow', 12),
      ),
  });

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
  }, aerial, entityCard, new SignalChips(data, manifest), new DebtCard(data, manifest));

  // Owner profile: the drawer-sized panel the parcel drawer opens on top of.
  const profile = new OwnerProfile(manifest, {
    onClose: () => closeOwner(),
    onSelectParcel: (pid) => void select(pid, { fly: true }),
    onOpenOwner: (ref) => void openOwner(ref),
    onCopyLink: () => copyLink('Link to this owner copied'),
  }, data);
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
        // The parcel table backs the totals, the owners list and search: on a desktop-size screen,
        // fetch it once the map is up. Phones fetch it when it is first needed (it is a large file).
        if (!window.matchMedia('(max-width: 900px)').matches) window.setTimeout(() => results.preload(), 1200);
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

  const help = new HelpDialog(manifest);
  const onPhone = () => window.matchMedia('(max-width: 720px)').matches;

  // The page is the map. A slim rail opens everything else as one pop-up panel at a time.
  const rail = new Rail(document.getElementById('rail')!, mapEl, {
    onList: () => results.toggle(),
    onHelp: () => help.open(),
    onPanel: (id) => {
      if (id) results.preload(); // totals and match counts read the parcel table
      mapc.setLeftInset(rail.inset());
    },
  });
  /** On a phone a panel covers the map, so an action that changes the map closes it. */
  const closePanelOnPhone = () => {
    if (onPhone()) rail.open(null);
  };
  window.addEventListener('resize', () => mapc.setLeftInset(rail.inset()));

  const panel = new FilterPanel({ filters: rail.body('filters'), insights: rail.body('insights'), map: rail.body('map') }, manifest, store, {
    onCounties: (codes) => {
      const boxes = codes.map((code) => manifest.counties.find((x) => x.code === code)?.bbox).filter((b): b is Bbox => !!b);
      if (!boxes.length) return;
      const union: Bbox = [
        Math.min(...boxes.map((b) => b[0])),
        Math.min(...boxes.map((b) => b[1])),
        Math.max(...boxes.map((b) => b[2])),
        Math.max(...boxes.map((b) => b[3])),
      ];
      mapc.fitBbox(union, { maxZoom: 12.5 });
    },
    onHelp: (section) => help.open(section),
    onMarket: (b: Bbox) => {
      closePanelOnPhone();
      mapc.fitBbox(b, { maxZoom: 15.3, pitch: store.get().extrude === 'flat' ? 0 : 55 });
    },
    onShowResults: () => {
      closePanelOnPhone();
      results.show('owners');
    },
  });
  const filterCount = (f: AppState['filters']): number =>
    (f.counties.length ? 1 : 0) + (f.classes.length ? 1 : 0) + f.presets.length + (f.minHold > 0 ? 1 : 0) + (f.lotStep > 0 ? 1 : 0) + (f.btlStep > 0 ? 1 : 0);
  rail.setFilterCount(filterCount(store.get().filters));
  store.subscribe((s, prev) => {
    if (s.filters !== prev.filters) rail.setFilterCount(filterCount(s.filters));
  });

  // Insights: Top owners under the live totals.
  const owners = new OwnersPanel(manifest, data, store, {
    onPick: (row) => {
      closePanelOnPhone();
      void openOwner({ kind: row.kind, id: row.id }, { fit: false });
    },
  });
  panel.slot('insights').append(owners.el);

  // Owner signals are step 3 of Filters; saved and starter screens have a panel of their own.
  const prospecting = new ProspectingPanel(manifest, store, new LocalScreenRepository(), {
    capture: () => captureScreen(true),
    apply: (state) => applyScreen(state, true),
    copyLink: () => copyLink('Link to this screen copied'),
    starter: (id) => applyStarter(id),
  });
  panel.slot('signals').append(prospecting.el);

  // Deal signals: the masks load once; a screen that uses a signal preset re-runs when they arrive.
  void data.signalFlags().then(
    (rows) => {
      setSignalFlags(rows);
      prospecting.signalsLoaded();
      const f = store.get().filters;
      if (f.presets.some(isSignalPreset)) store.set({ filters: { ...f } });
    },
    (err) => console.error('Deal signals failed to load', err),
  );
  rail.body('saved').append(prospecting.savedEl);
  prospecting.savedEl.open = true; // the panel is its header: the section inside never collapses

  // Map panel: the basemap switch, what height and color show (FilterPanel), then the legend.
  rail.body('map').prepend(h('div', { class: 'map-style' }, h('div', { class: 'field-label' }, 'Basemap'), new Toolbar(store).el));
  rail.body('map').append(new Legend(manifest, store).el);

  // Owners & parcels tables under the map: every matching parcel, grouped into owners.
  /** True while a link or saved screen sets the table: the map keeps its (linked) center. */
  let restoring = false;
  const results = new ResultsPanel(manifest, data, store, {
    onOpenOwner: (ref) => void openOwner(ref),
    onSelectParcel: (pid) => void select(pid, { fly: true }),
    onLayout: (px) => {
      // On phones the open list covers the map, so the map's own controls stay put under it.
      const height = onPhone() ? 0 : Math.round(px);
      mapEl.style.setProperty('--results-h', `${height}px`);
      mapc.setBottomInset(height, restoring);
    },
    viewBbox: () => mapc.viewBbox(),
    onStateChange: () => {
      rail.setListOpen(results.isOpen);
      writeScreenHash();
    },
    onCounts: (n) => {
      panel.setMatches(n);
      emptyNote.hidden = !n || n.parcels > 0;
    },
  });
  // Nothing matches: say so on the map, with the way out.
  const emptyNote = h(
    'div',
    { class: 'empty-note', role: 'status', hidden: true },
    h('b', null, 'No parcels match these filters.'),
    h('span', null, 'Remove a filter, or start over.'),
    h('button', { type: 'button', class: 'btn solid sm', onclick: () => store.set({ filters: { ...DEFAULT_FILTERS }, search: null }) }, 'Reset all filters'),
  );
  mapEl.append(emptyNote);
  mapEl.append(results.el);
  mapEl.style.setProperty('--results-h', '0px');
  mapc.map.on('moveend', () => results.mapMoved());
  window.addEventListener('resize', () => results.relayout());

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
  // Over the map, top-left: search, then the applied-filter chips beside it.
  mapEl.append(h('div', { class: 'map-top' }, searchBox.el, new ActiveFilters(store).el));

  /** A starter screen: keeps the counties already picked, sets the rest, and opens the owners list. */
  function applyStarter(id: string): void {
    const sc = STARTER_SCREENS.find((x) => x.id === id);
    if (!sc) return;
    store.set({ filters: { ...DEFAULT_FILTERS, counties: store.get().filters.counties, ...sc.filters }, search: null });
    searchBox.setText('');
    rail.open(null);
    results.show('owners');
  }
  const firstHint = new FirstVisitHint(
    mapEl,
    manifest,
    { onStarters: () => rail.open('saved'), onHelp: () => help.open() },
    !linked && !hashParam('p') && !hashParam('o'),
  );
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
    if (e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey && !(e.target instanceof HTMLElement && e.target.closest('input, textarea, select, [contenteditable]'))) {
      e.preventDefault();
      help.open();
      return;
    }
    if (e.key !== 'Escape' || brief.isOpen || help.isOpen) return;
    if (drawer.isOpen) clearSelection();
    else if (profile.isOpen) closeOwner();
    else if (rail.current) rail.open(null);
  });
}

void boot();
