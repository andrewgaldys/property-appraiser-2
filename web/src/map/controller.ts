import {
  AttributionControl,
  Map as MapLibreMap,
  NavigationControl,
  ScaleControl,
  addProtocol,
  setWorkerUrl,
  type LngLatBoundsLike,
  type MapGeoJSONFeature,
  type MapMouseEvent,
  type PaddingOptions,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { Protocol } from 'pmtiles';
import type { DataStore } from '../data';
import type { Store } from '../state';
import type { AppState, Bbox, Manifest, ParcelRecord, PortfolioItem, TileProps, ViewStats } from '../types';
import type { Tooltip } from '../ui/tooltip';
import { BASEMAP_LABEL_ANCHOR, buildBasemapStyle } from './basemap';
import {
  L_3D,
  L_FLAT,
  L_OUTLINE,
  L_POINTS,
  PARCEL_LAYERS,
  SRC_POLY,
  SRC_PTS,
  colorExpr,
  filterExpr,
  heightExpr,
  outlineColor,
  outlineWidth,
  parcelLayers,
  pointRadius,
  pointStrokeWidth,
} from './layers';

// MapLibre v6 ships its web worker as a separate ES module; hand Vite's URL for it to MapLibre.
setWorkerUrl(workerUrl);
// PMTiles: vector tiles straight out of one static file via HTTP Range requests.
const pmtiles = new Protocol();
addProtocol('pmtiles', pmtiles.tile);

export interface MapEvents {
  onReady(): void;
  onSelect(props: TileProps): void;
  onClear(): void;
  onStats(stats: ViewStats): void;
}

type FeatureKey = { source: string; sourceLayer?: string; id: string | number };

export class MapController {
  readonly map: MapLibreMap;
  private vector = true;
  private hovered: FeatureKey | null = null;
  private statsTimer = 0;
  private ready = false;
  private rightInset = 0;

  constructor(
    container: HTMLElement,
    private manifest: Manifest,
    private data: DataStore,
    private store: Store<AppState>,
    private events: MapEvents,
    private tooltip: Tooltip,
  ) {
    const customStyle = import.meta.env.VITE_BASEMAP_STYLE?.trim();
    this.map = new MapLibreMap({
      container,
      style: customStyle || buildBasemapStyle(),
      bounds: manifest.bounds as LngLatBoundsLike,
      fitBoundsOptions: { padding: { top: 48, bottom: 48, left: 48, right: 48 } },
      pitch: 38,
      bearing: -14,
      maxPitch: 78,
      hash: 'map',
      attributionControl: false,
      canvasContextAttributes: { antialias: true },
    });
    this.map.addControl(new NavigationControl({ visualizePitch: true }), 'top-right');
    this.map.addControl(new ScaleControl({ unit: 'imperial', maxWidth: 100 }), 'bottom-right');
    this.map.addControl(
      new AttributionControl({ compact: true, customAttribution: manifest.source.attribution }),
      'bottom-right',
    );
    // 'style.load' fires as soon as the style JSON is parsed; 'load' would wait for every
    // basemap tile in view, which delays the parcels on slow connections.
    this.map.once('style.load', () => {
      void this.onLoad().catch((err: unknown) => {
        console.error('Failed to add parcel layers', err);
      });
    });
    new ResizeObserver(() => this.map.resize()).observe(container);
  }

  private labelAnchor(): string | undefined {
    if (this.map.getLayer(BASEMAP_LABEL_ANCHOR)) return BASEMAP_LABEL_ANCHOR;
    return this.map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
  }

  private async onLoad(): Promise<void> {
    const t = this.manifest.tiles;
    if (t.format === 'pmtiles') {
      this.vector = true;
      this.map.addSource(SRC_POLY, { type: 'vector', url: `pmtiles://${this.data.url(t.polygons.url)}` });
      this.map.addSource(SRC_PTS, { type: 'vector', url: `pmtiles://${this.data.url(t.points.url)}` });
    } else {
      this.vector = false;
      const gj = await this.data.loadGeojson();
      this.map.addSource(SRC_POLY, { type: 'geojson', data: gj.polygons, attribution: this.manifest.source.attribution });
      this.map.addSource(SRC_PTS, { type: 'geojson', data: gj.points });
    }
    const before = this.labelAnchor();
    for (const layer of parcelLayers(this.manifest, this.store.get(), this.vector)) this.map.addLayer(layer, before);
    this.bindEvents();
    this.store.subscribe((s, prev) => this.apply(s, prev));
    this.ready = true;
    this.events.onReady();
  }

  get isReady(): boolean {
    return this.ready;
  }

  // ---------------------------------------------------------------------------
  // State -> style
  // ---------------------------------------------------------------------------

  private apply(s: AppState, prev: AppState): void {
    if (s.filters !== prev.filters) {
      const f = filterExpr(s.filters);
      for (const id of PARCEL_LAYERS) this.map.setFilter(id, f);
    }
    if (s.extrude !== prev.extrude) {
      const flat = s.extrude === 'flat';
      this.map.setLayoutProperty(L_FLAT, 'visibility', flat ? 'visible' : 'none');
      this.map.setLayoutProperty(L_3D, 'visibility', flat ? 'none' : 'visible');
      this.map.setPaintProperty(L_3D, 'fill-extrusion-height', heightExpr(s.extrude));
      const pitch = this.map.getPitch();
      if (flat && pitch > 0) this.map.easeTo({ pitch: 0, duration: 700 });
      if (!flat && pitch < 25) this.map.easeTo({ pitch: 55, duration: 900 });
    }
    if (s.shade !== prev.shade || s.selection !== prev.selection || s.focus !== prev.focus) this.applyColors(s);
    this.scheduleStats();
  }

  private applyColors(s: AppState): void {
    const color = colorExpr(this.manifest, s);
    this.map.setPaintProperty(L_FLAT, 'fill-color', color);
    this.map.setPaintProperty(L_3D, 'fill-extrusion-color', color);
    this.map.setPaintProperty(L_POINTS, 'circle-color', colorExpr(this.manifest, s, 'points'));
    this.map.setPaintProperty(L_POINTS, 'circle-radius', pointRadius(s));
    this.map.setPaintProperty(L_POINTS, 'circle-stroke-width', pointStrokeWidth(s));
    this.map.setPaintProperty(L_OUTLINE, 'line-color', outlineColor(s));
    this.map.setPaintProperty(L_OUTLINE, 'line-width', outlineWidth(s));
  }

  // ---------------------------------------------------------------------------
  // Interaction
  // ---------------------------------------------------------------------------

  private pickLayers(): string[] {
    return [this.store.get().extrude === 'flat' ? L_FLAT : L_3D, L_POINTS];
  }

  /** Polygons win over centroid dots; dots get a forgiving 12px hit box when nothing is under the cursor. */
  private pick(e: MapMouseEvent): MapGeoJSONFeature | undefined {
    const exact = this.map.queryRenderedFeatures(e.point, { layers: this.pickLayers() });
    const hit = exact.find((f) => f.layer.id !== L_POINTS) ?? exact[0];
    if (hit || this.map.getZoom() > this.manifest.tiles.polygons.minzoom + 1) return hit;
    const { x, y } = e.point;
    return this.map.queryRenderedFeatures(
      [
        [x - 6, y - 6],
        [x + 6, y + 6],
      ],
      { layers: [L_POINTS] },
    )[0];
  }

  private setHover(f: MapGeoJSONFeature | undefined): void {
    const next: FeatureKey | null =
      f && f.id !== undefined ? { source: f.source, sourceLayer: f.sourceLayer, id: f.id } : null;
    const same =
      next && this.hovered && next.source === this.hovered.source && next.id === this.hovered.id;
    if (same) return;
    if (this.hovered) this.map.setFeatureState(this.hovered, { hover: false });
    this.hovered = next;
    if (next) this.map.setFeatureState(next, { hover: true });
  }

  private bindEvents(): void {
    const canvas = this.map.getCanvas();
    this.map.on('mousemove', (e) => {
      const f = this.pick(e);
      this.setHover(f);
      if (f) {
        canvas.style.cursor = 'pointer';
        this.tooltip.show(f.properties as TileProps, e.originalEvent.clientX, e.originalEvent.clientY);
      } else {
        canvas.style.cursor = '';
        this.tooltip.hide();
      }
    });
    canvas.addEventListener('mouseleave', () => {
      this.setHover(undefined);
      this.tooltip.hide();
    });
    this.map.on('movestart', () => this.tooltip.hide());
    this.map.on('click', (e) => {
      const f = this.pick(e);
      if (f) this.events.onSelect(f.properties as TileProps);
      else this.events.onClear();
    });
    this.map.on('idle', () => this.scheduleStats());
  }

  // ---------------------------------------------------------------------------
  // In-view statistics (respect the active filters: only rendered parcels count)
  // ---------------------------------------------------------------------------

  private scheduleStats(): void {
    window.clearTimeout(this.statsTimer);
    this.statsTimer = window.setTimeout(() => this.computeStats(), 150);
  }

  private computeStats(): void {
    if (!this.ready) return;
    const zoom = this.map.getZoom();
    const polyMin = this.manifest.tiles.polygons.minzoom;
    const layers = zoom < polyMin + 0.5 ? [L_POINTS] : [this.store.get().extrude === 'flat' ? L_FLAT : L_3D];
    const feats = this.map.queryRenderedFeatures({ layers });
    const seen = new Set<string>();
    let jv = 0;
    let units = 0;
    let sf = 0;
    for (const f of feats) {
      const p = f.properties as TileProps;
      if (seen.has(p.pid)) continue;
      seen.add(p.pid);
      jv += p.jv ?? 0;
      units += p.u ?? 0;
      sf += p.sf ?? 0;
    }
    this.events.onStats({ parcels: seen.size, jv, units, sf });
  }

  // ---------------------------------------------------------------------------
  // Camera
  // ---------------------------------------------------------------------------

  /** Margins for fitting; the drawer inset lives in the map's global padding (see setRightInset). */
  private margins(): PaddingOptions {
    return { top: 56, bottom: 56, left: 56, right: 56 };
  }

  /**
   * Reserve `px` on the right for the property drawer. MapLibre camera padding is global
   * (and sticky when passed to flyTo), so it is set here once, re-centring so that what is
   * on screen does not jump when the drawer opens or closes.
   */
  setRightInset(px: number): void {
    if (px === this.rightInset) return;
    const cv = this.map.getCanvas();
    const { top = 0, bottom = 0, left = 0 } = this.map.getPadding();
    const x = left + (cv.clientWidth - left - px) / 2;
    const y = top + (cv.clientHeight - top - bottom) / 2;
    const center = this.map.unproject([x, y]);
    this.map.jumpTo({ center, padding: { top, bottom, left, right: px } });
    this.rightInset = px;
  }

  /** Pan just enough to bring a parcel out from under the drawer / screen edge. */
  ensureVisible(rec: Pick<ParcelRecord, 'lon' | 'lat'>): void {
    const p = this.map.project([rec.lon, rec.lat]);
    const cv = this.map.getCanvas();
    const m = 48;
    const visible = p.x > m && p.x < cv.clientWidth - this.rightInset - m && p.y > m && p.y < cv.clientHeight - m;
    if (!visible) this.map.easeTo({ center: [rec.lon, rec.lat], duration: 700, essential: true });
  }

  flyToParcel(rec: Pick<ParcelRecord, 'lon' | 'lat' | 'bbox'>): void {
    const flat = this.store.get().extrude === 'flat';
    const cam = this.map.cameraForBounds(rec.bbox as LngLatBoundsLike, { padding: this.margins() });
    const zoom = Math.min(Math.max(cam?.zoom ?? 16, 15.2), 16.6);
    this.map.flyTo({
      center: [rec.lon, rec.lat],
      zoom,
      pitch: flat ? 0 : Math.max(this.map.getPitch(), 52),
      bearing: this.map.getBearing(),
      duration: 1700,
      essential: true,
    });
  }

  fitBbox(b: Bbox, opts: { maxZoom?: number; pitch?: number } = {}): void {
    this.map.fitBounds(b as LngLatBoundsLike, {
      padding: this.margins(),
      maxZoom: opts.maxZoom ?? 15.5,
      pitch: opts.pitch ?? (this.store.get().extrude === 'flat' ? 0 : 50),
      bearing: this.map.getBearing(),
      duration: 1600,
      essential: true,
    });
  }

  fitItems(items: Pick<PortfolioItem, 'lon' | 'lat'>[]): void {
    if (!items.length) return;
    const xs = items.map((i) => i.lon);
    const ys = items.map((i) => i.lat);
    const pad = 0.004;
    this.fitBbox([Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad], {
      maxZoom: 15.5,
    });
  }

  waitIdle(timeoutMs = 5000): Promise<void> {
    return new Promise((resolve) => {
      const t = window.setTimeout(resolve, timeoutMs);
      this.map.once('idle', () => {
        window.clearTimeout(t);
        resolve();
      });
    });
  }

  /**
   * Snapshot with the parcel centred in the full canvas (drawer padding removed for the
   * capture, then restored). The brief overlay hides the map while this happens.
   */
  async captureParcel(rec: Pick<ParcelRecord, 'lon' | 'lat'>): Promise<string | null> {
    const inset = this.rightInset;
    this.map.jumpTo({ center: [rec.lon, rec.lat], padding: { top: 0, bottom: 0, left: 0, right: 0 } });
    this.map.triggerRepaint();
    await this.waitIdle(4000);
    const image = await this.snapshot();
    this.map.jumpTo({ center: [rec.lon, rec.lat], padding: { top: 0, bottom: 0, left: 0, right: inset } });
    return image;
  }

  /**
   * Grab the current frame (read inside the render callback, so no preserveDrawingBuffer needed).
   * Resolves null if no frame is drawn in time (e.g. the tab is in the background).
   */
  snapshot(timeoutMs = 3000): Promise<string | null> {
    return new Promise((resolve) => {
      const t = window.setTimeout(() => {
        this.map.off('render', grab);
        resolve(null);
      }, timeoutMs);
      const grab = () => {
        window.clearTimeout(t);
        try {
          resolve(this.map.getCanvas().toDataURL('image/jpeg', 0.9));
        } catch {
          resolve(null);
        }
      };
      this.map.once('render', grab);
      this.map.triggerRepaint();
    });
  }
}
