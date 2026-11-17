/**
 * Deal signals per parcel (pipeline/build_signals.py): one bit per signal in each flagged parcel's
 * mask (signals/flags.json, loaded once), and per parcel the chips with their record date and
 * confidence (signals/detail/<shard>.json, loaded on demand).
 *
 * The map, the lists and the exports share this registry: a signal preset keeps the parcels whose
 * mask has any of its bits.
 */

import { PRESETS, SIGNAL_PRESETS } from './config';
import type { Manifest, PresetId, SignalDef } from './types';

let flags: Map<string, number> | null = null;
let defs: SignalDef[] = [];
const pidCache = new Map<number, string[]>();

export function initSignals(m: Manifest): void {
  defs = m.signals?.defs ?? [];
}

export function setSignalFlags(rows: Record<string, number> | null): void {
  flags = rows ? new Map(Object.entries(rows)) : null;
  pidCache.clear();
}

export const signalsReady = (): boolean => flags !== null;
export const hasSignalData = (m: Manifest): boolean => !!m.signals;

/** The bits a set of signal codes stands for. */
export function maskOf(codes: string[]): number {
  let m = 0;
  for (const d of defs) if (codes.includes(d.code)) m |= 1 << d.bit;
  return m;
}

export const isSignalPreset = (id: PresetId): boolean => id in SIGNAL_PRESETS;
export const presetMask = (id: PresetId): number => maskOf(SIGNAL_PRESETS[id] ?? []);

export function flagsOf(pid: string): number {
  return flags?.get(pid) ?? 0;
}

/** Every parcel with any of these bits (for the map's filter), cached per mask. */
export function signalPids(mask: number): string[] {
  if (!flags || !mask) return [];
  let list = pidCache.get(mask);
  if (!list) {
    list = [];
    for (const [pid, m] of flags) if (m & mask) list.push(pid);
    pidCache.set(mask, list);
  }
  return list;
}

/** Signal labels for a mask, in definition order ("Flood zone; Taxes rising"). */
export function signalLabels(mask: number): string[] {
  return defs.filter((d) => mask & (1 << d.bit)).map((d) => d.label);
}

/** Labels of the signal presets this mask satisfies (short chips). */
export function presetChips(mask: number): string[] {
  return PRESETS.filter((p) => isSignalPreset(p.id) && mask & presetMask(p.id)).map((p) => p.chip);
}

export interface SignalHit {
  code: string;
  chip: string;
  date: string | null;
  conf: number;
  facts: Record<string, unknown> | null;
}

export function defOf(code: string): SignalDef | undefined {
  return defs.find((d) => d.code === code);
}
