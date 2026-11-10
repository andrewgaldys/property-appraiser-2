import { Map as MapLibreMap, type LngLatBoundsLike } from 'maplibre-gl';
import type { DataStore } from '../data';
import { h } from '../dom';
import { satelliteStyle, selectedFilter } from '../map/satellite';
import type { Bbox, Manifest } from '../types';

const FIT = { padding: 36, maxZoom: 19.2 };

/** Live satellite thumbnail framed on one parcel, its boundary outlined in white. */
export class AerialCard {
  readonly el: HTMLElement;
  private mapEl: HTMLElement;
  private map: MapLibreMap | null = null;
  private pid: string | null = null;

  constructor(
    private manifest: Manifest,
    private data: DataStore,
  ) {
    this.mapEl = h('div', { class: 'aerial-map', role: 'img', 'aria-label': 'Satellite view of the selected parcel' });
    this.el = h('figure', { class: 'aerial' }, this.mapEl, h('figcaption', null, 'Imagery © Esri, Maxar, Earthstar Geographics'));
    this.el.hidden = true;
  }

  show(pid: string, bbox: Bbox): void {
    this.el.hidden = false;
    this.pid = pid;
    if (!this.map) {
      this.map = new MapLibreMap({
        container: this.mapEl,
        style: satelliteStyle(this.manifest, this.data, { selected: pid, neighbours: 0.35 }),
        bounds: bbox as LngLatBoundsLike,
        fitBoundsOptions: FIT,
        interactive: false,
        attributionControl: false,
        fadeDuration: 0,
      });
      return;
    }
    const m = this.map;
    m.resize();
    const apply = () => {
      if (m.getLayer('selected')) m.setFilter('selected', selectedFilter(this.pid));
      m.fitBounds(bbox as LngLatBoundsLike, { ...FIT, duration: 0 });
    };
    if (m.isStyleLoaded()) apply();
    else m.once('load', apply);
  }

  hide(): void {
    this.el.hidden = true;
  }

  /** Frame for the property brief (null if nothing is drawn within the timeout). */
  snapshot(timeoutMs = 3000): Promise<string | null> {
    const m = this.map;
    if (!m || this.el.hidden) return Promise.resolve(null);
    return new Promise((resolve) => {
      const done = (v: string | null) => {
        window.clearTimeout(t);
        resolve(v);
      };
      const t = window.setTimeout(() => {
        m.off('render', grab);
        resolve(null);
      }, timeoutMs);
      const grab = () => {
        try {
          done(m.getCanvas().toDataURL('image/jpeg', 0.9));
        } catch {
          done(null);
        }
      };
      m.once('render', grab);
      m.triggerRepaint();
    });
  }
}
