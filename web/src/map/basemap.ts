import type { ExpressionSpecification, StyleSpecification } from '@maplibre/maplibre-gl-style-spec';

/**
 * "Institutional mono" basemap: OpenFreeMap vector tiles (OpenMapTiles schema, no API key)
 * restyled in near-black greys, with 3D building extrusions. Parcel layers are inserted
 * just below `BASEMAP_LABEL_ANCHOR` so labels always stay on top.
 */
export const BASEMAP_LABEL_ANCHOR = 'road-label';
const SRC = 'openmaptiles';
const NAME: ExpressionSpecification = ['coalesce', ['get', 'name:en'], ['get', 'name']];

const roadWidth = (base: number, top: number): ExpressionSpecification => [
  'interpolate', ['exponential', 1.6], ['zoom'], 7, base, 18, top,
];

export function buildBasemapStyle(): StyleSpecification {
  return {
    version: 8,
    name: 'PA2 Institutional Mono',
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      [SRC]: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' },
    },
    light: { anchor: 'viewport', color: '#ffffff', intensity: 0.42, position: [1.25, 205, 35] },
    sky: {
      'sky-color': '#0a0a0a',
      'horizon-color': '#161616',
      'fog-color': '#0a0a0a',
      'sky-horizon-blend': 0.6,
      'horizon-fog-blend': 0.7,
      'fog-ground-blend': 0.75,
      'atmosphere-blend': 0,
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#0b0b0b' } },
      {
        id: 'landcover', type: 'fill', source: SRC, 'source-layer': 'landcover',
        filter: ['in', ['get', 'class'], ['literal', ['wood', 'grass', 'wetland', 'farmland', 'sand']]],
        paint: { 'fill-color': '#0e0e0e', 'fill-opacity': 0.8 },
      },
      { id: 'park', type: 'fill', source: SRC, 'source-layer': 'park', paint: { 'fill-color': '#0f0f0f' } },
      {
        id: 'water', type: 'fill', source: SRC, 'source-layer': 'water',
        filter: ['!=', ['get', 'brunnel'], 'tunnel'],
        paint: { 'fill-color': '#030303' },
      },
      {
        id: 'waterway', type: 'line', source: SRC, 'source-layer': 'waterway',
        paint: { 'line-color': '#030303', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.5, 16, 3] },
      },
      {
        id: 'aeroway', type: 'fill', source: SRC, 'source-layer': 'aeroway', minzoom: 11,
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: { 'fill-color': '#121212' },
      },
      {
        id: 'road-minor', type: 'line', source: SRC, 'source-layer': 'transportation', minzoom: 12,
        filter: ['in', ['get', 'class'], ['literal', ['minor', 'service', 'track']]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#191919', 'line-width': roadWidth(0.3, 9) },
      },
      {
        id: 'road-secondary', type: 'line', source: SRC, 'source-layer': 'transportation', minzoom: 9,
        filter: ['in', ['get', 'class'], ['literal', ['secondary', 'tertiary']]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#232323', 'line-width': roadWidth(0.4, 14) },
      },
      {
        id: 'road-primary', type: 'line', source: SRC, 'source-layer': 'transportation', minzoom: 7,
        filter: ['in', ['get', 'class'], ['literal', ['primary', 'trunk']]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#2b2b2b', 'line-width': roadWidth(0.5, 18) },
      },
      {
        id: 'road-motorway', type: 'line', source: SRC, 'source-layer': 'transportation', minzoom: 5,
        filter: ['==', ['get', 'class'], 'motorway'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#363636', 'line-width': roadWidth(0.7, 22) },
      },
      {
        id: 'rail', type: 'line', source: SRC, 'source-layer': 'transportation', minzoom: 11,
        filter: ['==', ['get', 'class'], 'rail'],
        paint: { 'line-color': '#262626', 'line-width': 1, 'line-dasharray': [3, 3] },
      },
      {
        id: 'boundary-county', type: 'line', source: SRC, 'source-layer': 'boundary',
        filter: ['all', ['in', ['get', 'admin_level'], ['literal', [4, 6]]], ['!=', ['get', 'maritime'], 1]],
        paint: {
          'line-color': '#5c5c5c',
          'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.6, 12, 1.4],
          'line-dasharray': [4, 3],
        },
      },
      {
        id: 'building-3d', type: 'fill-extrusion', source: SRC, 'source-layer': 'building', minzoom: 13,
        filter: ['!=', ['get', 'hide_3d'], true],
        paint: {
          'fill-extrusion-color': '#181818',
          'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 13, 0, 13.8, ['coalesce', ['get', 'render_height'], 4]],
          'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
          'fill-extrusion-opacity': 0.92,
        },
      },
      {
        id: BASEMAP_LABEL_ANCHOR, type: 'symbol', source: SRC, 'source-layer': 'transportation_name', minzoom: 14,
        filter: ['in', ['get', 'class'], ['literal', ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor']]],
        layout: {
          'symbol-placement': 'line',
          'text-field': NAME,
          'text-font': ['Noto Sans Regular'],
          'text-size': 10,
          'text-letter-spacing': 0.08,
          'text-transform': 'uppercase',
          'text-max-angle': 30,
        },
        paint: { 'text-color': '#6c6c6c', 'text-halo-color': '#0a0a0a', 'text-halo-width': 1.4 },
      },
      {
        id: 'water-label-line', type: 'symbol', source: SRC, 'source-layer': 'water_name', minzoom: 9,
        filter: ['==', ['geometry-type'], 'LineString'],
        layout: {
          'symbol-placement': 'line',
          'text-field': NAME,
          'text-font': ['Noto Sans Italic'],
          'text-size': 11,
          'text-letter-spacing': 0.12,
        },
        paint: { 'text-color': '#3e3e3e', 'text-halo-color': '#030303', 'text-halo-width': 1 },
      },
      {
        id: 'water-label-point', type: 'symbol', source: SRC, 'source-layer': 'water_name', minzoom: 7,
        filter: ['==', ['geometry-type'], 'Point'],
        layout: {
          'text-field': NAME,
          'text-font': ['Noto Sans Italic'],
          'text-size': 11,
          'text-letter-spacing': 0.12,
        },
        paint: { 'text-color': '#3e3e3e', 'text-halo-color': '#030303', 'text-halo-width': 1 },
      },
      {
        id: 'place-label', type: 'symbol', source: SRC, 'source-layer': 'place', minzoom: 7,
        filter: ['in', ['get', 'class'], ['literal', ['city', 'town', 'village']]],
        layout: {
          'text-field': NAME,
          'text-font': ['Noto Sans Bold'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 8, 10, 14, 13],
          'text-transform': 'uppercase',
          'text-letter-spacing': 0.18,
          'text-max-width': 10,
        },
        paint: { 'text-color': '#a4a4a4', 'text-halo-color': '#0a0a0a', 'text-halo-width': 1.6 },
      },
    ],
  };
}
