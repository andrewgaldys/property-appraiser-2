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
import type { AppState, Bbox, Manifest, ParcelRecord, Portfolio, PortfolioItem, TileProps } from './types';
import { ActiveFilters } from './ui/activeFilters';
import { AerialCard } from './ui/aerial';
import { Brief } from './ui/brief';
import { Drawer } from './ui/drawer';
import { FilterPanel, type SectionId } from './ui/filters';
import { FirstVisitHint } from './ui/hint';
import { Legend } from './ui/legend';
import { Toolbar } from './ui/toolbar';
import { Tooltip } from './ui/tooltip';

// ---- URL hash: MapLibre owns `map=`, we own `p=` (selected parcel) ----------------
function hashParam(key: string): string | null {
  for (const part of window.location.hash.slice(1).split('&')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i) === key) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}

function setHashParam(key: string, value: string | null): void {
  const parts = window.location.hash
    .slice(1)
    .split('&')
    .filter((p) => p && !p.startsWith(`${key}=`));
  if (value) parts.push(`${key}=${encodeURIComponent(value)}`);
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

  const store = new Store<AppState>({
    filters: { ...DEFAULT_FILTERS },
    extrude: 'value',
    shade: 'class',
    basemap: 'dark',
    lens: true,
    selection: null,
    focus: false,
    ...loadSavedView(),
  });
  store.subscribe((s, prev) => {
    if (
      s.filters !== prev.filters || s.extrude !== prev.extrude || s.shade !== prev.shade ||
      s.basemap !== prev.basemap || s.lens !== prev.lens
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
    onCopyLink: () => {
      navigator.clipboard?.writeText(window.location.href).then(
        () => toast('Link to this parcel copied'),
        () => toast('Copy failed: use the address bar'),
      );
    },
  }, aerial);

  const mapc: MapController = new MapController(
    mapEl,
    manifest,
    data,
    store,
    {
      onReady: () => {
        document.body.classList.add('map-ready');
        const pid = hashParam('p');
        if (pid) void select(pid, { fly: true });
      },
      onSelect: (props: TileProps) => void select(props.pid, { hint: props }),
      onClear: () => clearSelection(),
      onStats: (s) => panel.setStats(s),
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
  });
  new Legend(mapEl, manifest, store);

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
  mapEl.append(
    h(
      'div',
      { class: 'map-top' },
      h('div', { class: 'map-top-row' }, panelToggle, new Toolbar(store).el),
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

  async function select(pid: string, opts: { fly?: boolean; hint?: TileProps; keepFocus?: boolean } = {}): Promise<void> {
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
      focus: prev.focus && (opts.keepFocus || samePortfolio),
    });
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
    mapc.setRightInset(0);
    setHashParam('p', null);
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

  // A parcel link pasted into an already-open tab only changes the hash: follow it.
  window.addEventListener('hashchange', () => {
    if (!mapc.isReady) return;
    const pid = hashParam('p');
    const cur = store.get().selection?.pid ?? null;
    if (pid && pid !== cur) void select(pid, { fly: true });
    else if (!pid && cur) clearSelection();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || brief.isOpen) return;
    if (document.body.classList.contains('panel-open')) setPanelOpen(false);
    else if (drawer.isOpen) clearSelection();
  });
}

void boot();
