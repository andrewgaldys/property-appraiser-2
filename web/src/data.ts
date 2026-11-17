import type { GeoJSONSourceSpecification } from '@maplibre/maplibre-gl-style-spec';
import { RESIDENTIAL_CLASSES } from './config';
import { toEntity, type EntityLink, type EntityMatch, type EntityRecord, type PrincipalGroup } from './entities';
import { buildIndex, type ParcelIndex, type RawIndex } from './parcelIndex';
import type { SignalHit } from './signals';
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

type RawGroup = { label: string; kind: 'P' | 'C'; statewide: number | null; members: [string, string, string, number, string[]][] };

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
  private entityShards = new Map<string, Promise<DetailShard>>();
  private peopleShards = new Map<string, Promise<Record<string, RawGroup>>>();

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

  // ---- Deal signals (manifest.signals) ------------------------------------------------------------

  private signalShards = new Map<string, Promise<DetailShard>>();
  private flagsPromise: Promise<Record<string, number> | null> | null = null;

  /** Every flagged parcel's signal mask, fetched once (lists, filters, exports). */
  signalFlags(): Promise<Record<string, number> | null> {
    const spec = this.manifest.signals?.flags;
    if (!spec) return Promise.resolve(null);
    if (!this.flagsPromise) {
      this.flagsPromise = this.json<{ fields: string[]; rows: Record<string, number> }>(spec.url).then((s) => s.rows);
      this.flagsPromise.catch(() => {
        this.flagsPromise = null;
      });
    }
    return this.flagsPromise;
  }

  /** One parcel's signals: chip, record date, confidence and facts. */
  async signalDetail(pid: string): Promise<SignalHit[]> {
    const spec = this.manifest.signals?.detail;
    if (!spec) return [];
    const shard = fnv1a32(pid).slice(0, spec.shard_hex);
    const s = await this.cached(this.signalShards, shard, () => this.json<DetailShard>(spec.url.replace('{shard}', shard)));
    const rows = (s.rows[pid] as unknown[][] | undefined) ?? [];
    const at = (f: string) => s.fields.indexOf(f);
    return rows.map((r) => ({
      code: String(r[at('code')]),
      chip: String(r[at('chip')]),
      date: (r[at('date')] as string | null) ?? null,
      conf: Number(r[at('conf')] ?? 0),
      facts: (r[at('facts')] as Record<string, unknown> | null) ?? null,
    }));
  }

  // ---- Sunbiz records (manifest.entities) ------------------------------------------------------

  private entityShard(kind: 'links' | 'docs', key: string): Promise<DetailShard> {
    const spec = this.manifest.entities![kind];
    const shard = fnv1a32(key).slice(0, spec.shard_hex);
    return this.cached(this.entityShards, `${kind}/${shard}`, () => this.json<DetailShard>(spec.url.replace('{shard}', shard)));
  }

  /** The state business record matched to this parcel's owner, if any. */
  async entityLink(pid: string): Promise<EntityLink | null> {
    if (!this.manifest.entities) return null;
    const row = (await this.entityShard('links', pid)).rows[pid];
    return row ? { doc: String(row[0]), conf: Number(row[1]), how: String(row[2]) } : null;
  }

  async entity(doc: string): Promise<EntityRecord | null> {
    if (!this.manifest.entities) return null;
    const s = await this.entityShard('docs', doc);
    const row = s.rows[doc];
    return row ? toEntity(doc, s.fields, row) : null;
  }

  async entityFor(pid: string): Promise<EntityMatch | null> {
    const link = await this.entityLink(pid);
    const rec = link ? await this.entity(link.doc) : null;
    return link && rec ? { link, rec } : null;
  }

  /** Records for many parcels at once (exports): one fetch per shard. */
  async entitiesFor(pids: string[]): Promise<Map<string, EntityMatch>> {
    const out = new Map<string, EntityMatch>();
    if (!this.manifest.entities) return out;
    const links = await Promise.all(pids.map(async (pid) => [pid, await this.entityLink(pid)] as const));
    const docs = new Map<string, EntityRecord | null>();
    await Promise.all(
      [...new Set(links.flatMap(([, l]) => (l ? [l.doc] : [])))].map(async (doc) => docs.set(doc, await this.entity(doc))),
    );
    for (const [pid, link] of links) {
      const rec = link ? docs.get(link.doc) : null;
      if (link && rec) out.set(pid, { link, rec });
    }
    return out;
  }

  /** Owners linked through one officer, manager or registered agent. */
  async principalGroup(id: number): Promise<PrincipalGroup | null> {
    const spec = this.manifest.entities?.people;
    if (!spec || !id) return null;
    const shard = (id % 16 ** spec.shard_hex).toString(16).padStart(spec.shard_hex, '0');
    const s = await this.cached(this.peopleShards, shard, () => this.json<Record<string, RawGroup>>(spec.url.replace('{shard}', shard)));
    const g = s[String(id)];
    if (!g) return null;
    return {
      id,
      label: g.label,
      kind: g.kind,
      statewide: g.statewide,
      members: g.members.map(([doc, name, roles, shared, pids]) => ({ doc, name, roles, shared: shared === 1, pids })),
    };
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
