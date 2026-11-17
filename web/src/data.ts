import type { GeoJSONSourceSpecification } from '@maplibre/maplibre-gl-style-spec';
import { RESIDENTIAL_CLASSES } from './config';
import { decodeListings, type Listing, type ListingsIndex } from './listings';
import { buildIndex, type ParcelIndex, type RawIndex } from './parcelIndex';
import type { Manifest, ParcelRecord, Portfolio, PortfolioGroup, PortfolioItem } from './types';

/** 32-bit FNV-1a -> 8 hex chars. Must match pipeline/pa2/util.py fnv1a32 exactly. */
export function fnv1a32(s: string): string {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(s)) {
    h ^= b;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

interface DetailShard {
  fields: string[];
  rows: Record<string, unknown[]>;
}

interface OwnerShard {
  n: Record<string, PortfolioGroup>;
  a: Record<string, PortfolioGroup>;
}

type GeoJSONData = GeoJSONSourceSpecification['data'];

/** Data bundle location: VITE_DATA_URL (e.g. an R2/S3 bucket) or ./data/ next to index.html. */
export function dataBaseUrl(): URL {
  const configured = import.meta.env.VITE_DATA_URL?.trim();
  const u = new URL(configured || 'data/', document.baseURI);
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  return u;
}

export class DataStore {
  manifest!: Manifest;
  private detail = new Map<string, Promise<DetailShard>>();
  private owners = new Map<string, Promise<OwnerShard>>();

  constructor(readonly base: URL = dataBaseUrl()) {}

  url(rel: string): string {
    return new URL(rel, this.base).href;
  }

  private async json<T>(rel: string, init?: RequestInit): Promise<T> {
    const res = await fetch(this.url(rel), init);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${rel}`);
    return (await res.json()) as T;
  }

  private cached<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
    let p = cache.get(key);
    if (!p) {
      p = load();
      cache.set(key, p);
      p.catch(() => cache.delete(key));
    }
    return p;
  }

  async loadManifest(): Promise<Manifest> {
    this.manifest = await this.json<Manifest>('manifest.json', { cache: 'no-cache' });
    return this.manifest;
  }

  async parcel(pid: string): Promise<ParcelRecord | null> {
    const { url, shard_hex } = this.manifest.details;
    const shard = fnv1a32(pid).slice(0, shard_hex);
    const s = await this.cached(this.detail, shard, () => this.json<DetailShard>(url.replace('{shard}', shard)));
    const row = s.rows[pid];
    if (!row) return null;
    const rec: Record<string, unknown> = {};
    s.fields.forEach((f, i) => {
      rec[f] = row[i];
    });
    return rec as unknown as ParcelRecord;
  }

  private ownerShard(key: number): Promise<OwnerShard> {
    const { url, shard_hex } = this.manifest.owners;
    const shard = (key % 16 ** shard_hex).toString(16).padStart(shard_hex, '0');
    return this.cached(this.owners, shard, () => this.json<OwnerShard>(url.replace('{shard}', shard)));
  }

  private parcelIx: Promise<ParcelIndex> | null = null;
  /** The loaded parcel index, once available (null before the first load finishes). */
  loadedIndex: ParcelIndex | null = null;

  private ixListeners = new Set<(fraction: number) => void>();

  /** Follow the parcel index download: `fn(0..1)` as bytes arrive, then 1 when it is ready. Returns an unsubscribe. */
  onIndexProgress(fn: (fraction: number) => void): () => void {
    this.ixListeners.add(fn);
    return () => this.ixListeners.delete(fn);
  }

  /** The index is one large JSON file: read it as a stream so the wait can show progress. */
  private async indexJson(rel: string): Promise<RawIndex> {
    const res = await fetch(this.url(rel));
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${rel}`);
    const total = this.manifest.index?.bytes;
    if (!total || !res.body) return (await res.json()) as RawIndex;
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      // Stop just short of 1: parsing and indexing still follow the last byte.
      const fraction = Math.min(got / total, 0.97);
      for (const fn of this.ixListeners) fn(fraction);
    }
    return (await new Response(new Blob(chunks as BlobPart[])).json()) as RawIndex;
  }

  /** Every parcel in one table, fetched once on first use (search, results tables, exports). */
  parcelIndex(): Promise<ParcelIndex> {
    if (!this.parcelIx) {
      const url = this.manifest.index?.url;
      if (!url) return Promise.reject(new Error('This data bundle has no parcel index'));
      this.parcelIx = this.indexJson(url).then((raw) => {
        this.loadedIndex = buildIndex(raw, this.manifest.use_codes ?? {});
        for (const fn of this.ixListeners) fn(1);
        return this.loadedIndex;
      });
      this.parcelIx.catch(() => {
        this.parcelIx = null;
      });
    }
    return this.parcelIx;
  }

  private listingsIx: Promise<ListingsIndex | null> | null = null;
  private listingShards = new Map<string, Promise<Record<string, unknown[][]>>>();
  /** The listings index once it has loaded: null when no listing source is connected, undefined before. */
  loadedListings: ListingsIndex | null | undefined = undefined;

  /**
   * Which parcels have a for-sale or for-lease listing, and where the listings come from.
   * Resolves to null when no listing source is connected (or the bundle predates listings);
   * rejects when the file could not be fetched, so "not connected" is never a guess.
   */
  listingsIndex(): Promise<ListingsIndex | null> {
    if (!this.listingsIx) {
      this.listingsIx = (async () => {
        const res = await fetch(this.url('listings/index.json'), { cache: 'no-cache' });
        // A bundle without listings: a 404, or a dev server answering with its HTML fallback.
        const missing = res.status === 404 || (res.ok && !/json/i.test(res.headers.get('content-type') ?? 'json'));
        if (!missing && !res.ok) throw new Error(`${res.status} ${res.statusText}: listings/index.json`);
        const ix = missing ? null : ((await res.json()) as ListingsIndex);
        this.loadedListings = ix && String(ix.schema).startsWith('pa2-listings/') && ix.sources?.length ? ix : null;
        return this.loadedListings;
      })();
      this.listingsIx.catch(() => {
        this.listingsIx = null;
      });
    }
    return this.listingsIx;
  }

  /** The listings matched to one parcel (empty when it has none). */
  async parcelListings(pid: string): Promise<{ index: ListingsIndex | null; items: Listing[] }> {
    const index = await this.listingsIndex();
    if (!index || !index.parcels[pid]) return { index, items: [] };
    const shard = fnv1a32(pid).slice(0, index.shard_hex);
    const rows = await this.cached(this.listingShards, shard, () => this.json<Record<string, unknown[][]>>(index.url.replace('{shard}', shard)));
    return { index, items: decodeListings(index.fields, rows[pid]) };
  }

  /** One owner-name ('n') or mailing-address ('a') group from the owner index. */
  async ownerGroup(kind: 'n' | 'a', key: number): Promise<PortfolioGroup | null> {
    const shard = await this.ownerShard(key);
    return shard[kind][String(key)] ?? null;
  }

  /** Union of every parcel sharing the owner-name key and/or the mailing-address key. */
  async portfolio(nameKey: number | null, addrKey: number | null): Promise<Portfolio | null> {
    if (nameKey == null && addrKey == null) return null;
    const [byName, byAddr] = await Promise.all([
      nameKey != null ? this.ownerShard(nameKey).then((s) => s.n[String(nameKey)] ?? null) : null,
      addrKey != null ? this.ownerShard(addrKey).then((s) => s.a[String(addrKey)] ?? null) : null,
    ]);
    if (!byName && !byAddr) return null;

    const fields = this.manifest.owners.item_fields;
    const items = new Map<string, PortfolioItem>();
    const add = (g: PortfolioGroup | null, match: 'name' | 'addr') => {
      if (!g) return;
      for (const arr of g.items) {
        const it: Record<string, unknown> = {};
        fields.forEach((f, i) => {
          it[f] = arr[i];
        });
        const pid = String(it.parcel_id);
        const existing = items.get(pid);
        if (existing) {
          if (existing.match !== match) existing.match = 'both';
        } else {
          items.set(pid, { ...(it as unknown as PortfolioItem), match });
        }
      }
    };
    add(byName, 'name');
    add(byAddr, 'addr');
    const list = [...items.values()].sort((a, b) => (b.just_value ?? 0) - (a.just_value ?? 0));

    const exact = (!byName || byName.items.length >= byName.count) && (!byAddr || byAddr.items.length >= byAddr.count);
    if (exact) {
      const counties: Record<string, number> = {};
      for (const it of list) counties[String(it.county_code)] = (counties[String(it.county_code)] ?? 0) + 1;
      return {
        byName, byAddr, items: list, total: list.length, exact,
        jv: list.reduce((s, it) => s + (it.just_value ?? 0), 0),
        // Units only from multifamily / mixed-use parcels (the pipeline nulls them elsewhere).
        units: list.reduce((s, it) => s + (it.residential_units ?? 0), 0),
        allResidential: list.every((it) => RESIDENTIAL_CLASSES.has(it.asset_class) || it.residential_units != null),
        sf: list.reduce((s, it) => s + (it.tot_lvg_area ?? 0), 0),
        counties,
      };
    }
    // A list was capped (very large owner): report the larger group's exact totals as a floor.
    const big = (byName?.count ?? 0) >= (byAddr?.count ?? 0) ? byName! : byAddr!;
    return {
      byName, byAddr, items: list, total: Math.max(big.count, list.length), exact,
      jv: big.jv, units: big.units, allResidential: big.res != null && big.res >= big.count, sf: big.sf,
      counties: big.counties,
    };
  }

  /** Fallback when the pipeline ran without a tiler: parcels.geojson -> tile-shaped sources. */
  async loadGeojson(): Promise<{ polygons: GeoJSONData; points: GeoJSONData }> {
    interface RawFeature {
      properties: Record<string, unknown> | null;
      geometry: { type: string; coordinates: unknown };
    }
    const fc = await this.json<{ features: RawFeature[] }>(this.manifest.tiles.polygons.url);
    const alias = Object.entries(this.manifest.tiles.fields);
    const polys: unknown[] = [];
    const pts: unknown[] = [];
    for (const f of fc.features) {
      const p = f.properties ?? {};
      const props: Record<string, unknown> = {};
      for (const [std, short] of alias) {
        const v = p[std];
        if (v !== null && v !== undefined) props[short] = v;
      }
      const id = Number(p.fid);
      polys.push({ type: 'Feature', id, properties: props, geometry: f.geometry });
      pts.push({ type: 'Feature', id, properties: props, geometry: { type: 'Point', coordinates: [p.lon, p.lat] } });
    }
    return {
      polygons: { type: 'FeatureCollection', features: polys } as unknown as GeoJSONData,
      points: { type: 'FeatureCollection', features: pts } as unknown as GeoJSONData,
    };
  }
}
