import type {
  FilterSpecification,
  LayerSpecification,
  SourceSpecification,
  StyleSpecification,
} from '@maplibre/maplibre-gl-style-spec';
import { Map as MapLibreMap } from 'maplibre-gl';
import { LENS_MIN_ZOOM, LENS_RADIUS, SATELLITE_ATTRIBUTION, SATELLITE_TILES } from '../config';
import type { DataStore } from '../data';
import { h } from '../dom';
import type { Manifest } from '../types';
import { NOT_RIM } from './layers';

/** The one parcel drawn heavier on imagery (never its roof-rim twin). */
export const selectedFilter = (pid: string | null): FilterSpecification =>
  ['all', NOT_RIM, ['==', ['get', 'pid'], pid ?? '']] as FilterSpecification;

/** Esri imagery + white parcel outlines (from the same PMTiles), with one parcel emphasized. */
export function satelliteStyle(
  manifest: Manifest,
  data: DataStore,
  opts: { selected?: string | null; neighbours?: number } = {},
): StyleSpecification {
  const sources: Record<string, SourceSpecification> = {
    sat: { type: 'raster', tiles: [SATELLITE_TILES], tileSize: 256, maxzoom: 19, attribution: SATELLITE_ATTRIBUTION },
  };
  const layers: LayerSpecification[] = [
    { id: 'sat', type: 'raster', source: 'sat', paint: { 'raster-fade-duration': 0 } },
  ];
  const t = manifest.tiles;
  if (t.format === 'pmtiles') {
    sources.parcels = { type: 'vector', url: `pmtiles://${data.url(t.polygons.url)}` };
    layers.push(
      {
        id: 'outline', type: 'line', source: 'parcels', 'source-layer': t.polygons.layer, minzoom: t.polygons.minzoom,
        filter: NOT_RIM,
        paint: {
          'line-color': '#ffffff',
          'line-opacity': opts.neighbours ?? 0.5,
          'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.5, 16, 1.4, 19, 2],
        },
      },
      {
        id: 'selected', type: 'line', source: 'parcels', 'source-layer': t.polygons.layer,
        filter: selectedFilter(opts.selected ?? null),
        paint: { 'line-color': '#ffffff', 'line-width': 3 },
      },
    );
  }
  return { version: 8, sources, layers };
}

export type OverlayMode = 'off' | 'lens' | 'split';

/**
 * A second map, camera-locked to the main one, that shows imagery through a clip path:
 * a circle around the cursor (spyglass lens) or everything right of a divider (split view).
 * It never receives pointer events, so hover / click keep working on the main map.
 */
export class SatelliteOverlay {
  private el: HTMLDivElement;
  private ring: HTMLDivElement;
  private divider: HTMLDivElement;
  private map: MapLibreMap | null = null;
  private mode: OverlayMode = 'off';
  private cursor: { x: number; y: number } | null = null;
  private splitX = 0.5;
  private padRight = 0;
  private selected: string | null = null;
  /** Fires when the lens appears/disappears (the tooltip moves out of its way). */
  onLensChange?: (visible: boolean) => void;
  private lensVisible = false;

  constructor(
    private main: MapLibreMap,
    private container: HTMLElement,
    private manifest: Manifest,
    private data: DataStore,
  ) {
    this.el = h('div', { class: 'sat-overlay', 'aria-hidden': 'true' });
    this.ring = h('div', { class: 'lens-ring', 'aria-hidden': 'true' });
    this.divider = h(
      'div',
      {
        class: 'split-divider',
        role: 'separator',
        tabindex: 0,
        'aria-orientation': 'vertical',
        'aria-label': 'Drag to compare the dark map with satellite imagery',
      },
      h('span', { class: 'split-handle' }),
    );
    this.ring.hidden = true;
    this.ring.style.width = this.ring.style.height = `${LENS_RADIUS * 2}px`;
    this.divider.hidden = true;
    // Above the map canvas, below the map controls and panels.
    const controls = container.querySelector('.maplibregl-control-container');
    container.insertBefore(this.el, controls);
    container.insertBefore(this.ring, controls);
    container.insertBefore(this.divider, controls);

    main.on('move', () => {
      this.sync();
      // The drawer's inset arrives as camera padding: keep the divider within the visible map.
      const right = main.getPadding().right ?? 0;
      if (this.mode === 'split' && right !== this.padRight) this.applyClip();
    });
    main.on('resize', () => {
      this.map?.resize();
      this.sync();
      this.applyClip();
    });
    main.on('mousemove', (e) => {
      this.cursor = { x: e.point.x, y: e.point.y };
      if (this.mode === 'lens') this.applyClip();
    });
    // Show / hide the lens as the zoom crosses LENS_MIN_ZOOM, not only once the gesture ends.
    main.on('zoom', () => {
      if (this.mode === 'lens') this.applyClip();
    });
    main.getCanvas().addEventListener('mouseleave', () => {
      this.cursor = null;
      if (this.mode === 'lens') this.applyClip();
    });
    this.bindDivider();
  }

  /** Width of the map not covered by the property drawer (which sets the right camera padding). */
  private visibleWidth(): number {
    return Math.max(this.container.clientWidth - (this.main.getPadding().right ?? 0), 1);
  }

  private bindDivider(): void {
    const move = (clientX: number) => {
      const r = this.container.getBoundingClientRect();
      this.splitX = Math.min(0.95, Math.max(0.05, (clientX - r.left) / this.visibleWidth()));
      this.applyClip();
    };
    this.divider.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      this.divider.setPointerCapture(ev.pointerId);
      this.divider.classList.add('dragging');
    });
    this.divider.addEventListener('pointermove', (ev) => {
      if (this.divider.hasPointerCapture(ev.pointerId)) move(ev.clientX);
    });
    const end = (ev: PointerEvent) => {
      if (this.divider.hasPointerCapture(ev.pointerId)) this.divider.releasePointerCapture(ev.pointerId);
      this.divider.classList.remove('dragging');
    };
    this.divider.addEventListener('pointerup', end);
    this.divider.addEventListener('pointercancel', end);
    this.divider.addEventListener('keydown', (ev) => {
      if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
      ev.preventDefault();
      this.splitX = Math.min(0.95, Math.max(0.05, this.splitX + (ev.key === 'ArrowLeft' ? -0.04 : 0.04)));
      this.applyClip();
    });
  }

  private ensureMap(): MapLibreMap {
    if (this.map) return this.map;
    const m = this.main;
    this.map = new MapLibreMap({
      container: this.el,
      style: satelliteStyle(this.manifest, this.data, { selected: this.selected }),
      interactive: false,
      attributionControl: false,
      fadeDuration: 0,
      maxPitch: 85,
      center: m.getCenter(),
      zoom: m.getZoom(),
      bearing: m.getBearing(),
      pitch: m.getPitch(),
    });
    return this.map;
  }

  setMode(mode: OverlayMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode !== 'off') {
      this.ensureMap().resize();
      this.sync();
    }
    this.divider.hidden = mode !== 'split';
    this.applyClip();
  }

  setSelected(pid: string | null): void {
    this.selected = pid;
    if (this.map?.getLayer('selected')) this.map.setFilter('selected', selectedFilter(pid));
  }

  private sync(): void {
    if (!this.map || this.mode === 'off') return;
    const m = this.main;
    this.map.jumpTo({
      center: m.getCenter(),
      zoom: m.getZoom(),
      bearing: m.getBearing(),
      pitch: m.getPitch(),
      padding: m.getPadding(),
    });
  }

  private applyClip(): void {
    let lens = false;
    this.padRight = this.main.getPadding().right ?? 0;
    if (this.mode === 'split') {
      const x = Math.round(this.splitX * this.visibleWidth());
      this.el.style.clipPath = `inset(0 0 0 ${x}px)`;
      this.el.style.visibility = 'visible';
      this.divider.style.left = `${x}px`;
    } else if (this.mode === 'lens' && this.cursor && this.main.getZoom() >= LENS_MIN_ZOOM) {
      const { x, y } = this.cursor;
      this.el.style.clipPath = `circle(${LENS_RADIUS}px at ${x}px ${y}px)`;
      this.el.style.visibility = 'visible';
      this.ring.style.transform = `translate(${x - LENS_RADIUS}px, ${y - LENS_RADIUS}px)`;
      lens = true;
    } else {
      this.el.style.visibility = 'hidden';
    }
    this.ring.hidden = !lens;
    if (lens !== this.lensVisible) {
      this.lensVisible = lens;
      this.onLensChange?.(lens);
    }
  }
}
