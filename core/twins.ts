// Two signals that rise and fall together, at the same strength, are in the same spot. A
// rotating address can't hide that, so this finds what's moving with something you own: your
// own devices under other identities, and anything riding along with you.
//
// Only your own devices are ever the reference. Strangers are never compared with each
// other, because that would be working out which of their devices go together.
//
// On real data, 2 of 58 devices matched an iPhone at 0.94 or better, within 1 dB. The next
// best was 0.63 and 19 dB away, so these limits sit in a wide empty gap. That was at close
// range. Near the noise floor, around -85 dBm, a real pocket test only reached about 0.5.

import { MOVED_SHIFT_DB } from "./moved";

export const TWIN_WINDOW_MINUTES = 240;
export const TWIN_MIN_MINUTES = 30;
export const TWIN_MIN_CORRELATION = 0.9;
export const TWIN_MAX_GAP_DB = 3;
/** A device sitting still gives nothing to match, and noise can correlate with anything. */
export const TWIN_MIN_SPREAD_DB = 3;

/** Fewer than this can't tell the Mac moving from a few things moving. */
const MIN_FOR_COMMON_MOTION = 8;

export type Series = ReadonlyMap<number, number>;

export interface Twin {
  deviceId: number;
  ofDeviceId: number;
  correlation: number;
  /** Minutes both were heard, which is what the match rests on. */
  minutes: number;
}

interface Match {
  correlation: number;
  gap: number;
  spread: number;
  minutes: number;
}

/** Ties share their average rank. */
function ranks(values: number[]): number[] {
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const result = new Array<number>(values.length);
  for (let start = 0; start < order.length; ) {
    let end = start;
    while (end + 1 < order.length && order[end + 1]!.value === order[start]!.value) end += 1;
    for (let position = start; position <= end; position += 1) result[order[position]!.index] = (start + end) / 2;
    start = end + 1;
  }
  return result;
}

const meanOf = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

function correlation(a: number[], b: number[]): number | null {
  const meanA = meanOf(a);
  const meanB = meanOf(b);
  let both = 0;
  let onlyA = 0;
  let onlyB = 0;
  for (let index = 0; index < a.length; index += 1) {
    both += (a[index]! - meanA) * (b[index]! - meanB);
    onlyA += (a[index]! - meanA) ** 2;
    onlyB += (b[index]! - meanB) ** 2;
  }
  return onlyA === 0 || onlyB === 0 ? null : both / Math.sqrt(onlyA * onlyB);
}

/**
 * Compared by rank, so a match has to hold across the whole time together. With plain
 * correlation, one extreme minute scored 0.94 for a pair that ranks at 0.47. Real matches
 * kept their score either way.
 */
export function compare(reference: Series, other: Series): Match | null {
  const shared = [...reference.keys()].filter((minute) => other.has(minute));
  if (shared.length < TWIN_MIN_MINUTES) return null;
  const a = shared.map((minute) => reference.get(minute)!);
  const b = shared.map((minute) => other.get(minute)!);
  const matched = correlation(ranks(a), ranks(b));
  if (matched === null) return null;
  const meanA = meanOf(a);
  return {
    correlation: matched,
    gap: Math.abs(meanA - meanOf(b)),
    spread: Math.sqrt(meanOf(a.map((value) => (value - meanA) ** 2))),
    minutes: shared.length,
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/**
 * When the Mac moves, everything shifts at once, and any two signals look like twins. Close
 * devices shift far more than distant ones (36 dB against a median of 8 in one real move), so
 * the shift can't be subtracted. Those minutes say nothing, so they're left out altogether.
 * Without this a real move made two unrelated fixed signals match at 0.94.
 */
export function withoutMacMotion(series: ReadonlyMap<number, Series>): ReadonlyMap<number, Series> {
  const steady = [...series.values()].filter((signal) => signal.size >= TWIN_MIN_MINUTES);
  if (steady.length < MIN_FOR_COMMON_MOTION) return series;

  const offsets = new Map<number, number[]>();
  for (const signal of steady) {
    const usual = median([...signal.values()]);
    for (const [minute, rssi] of signal) {
      const list = offsets.get(minute) ?? [];
      list.push(Math.abs(rssi - usual));
      offsets.set(minute, list);
    }
  }
  const moving = new Set(
    [...offsets].filter(([, values]) => median(values) >= MOVED_SHIFT_DB).map(([minute]) => minute),
  );
  return new Map(
    [...series].map(([deviceId, signal]) => [
      deviceId,
      new Map([...signal].filter(([minute]) => !moving.has(minute))),
    ]),
  );
}

/** The best match for each device, if it has one. */
export function findTwins(raw: ReadonlyMap<number, Series>, ownIds: number[]): Twin[] {
  const series = withoutMacMotion(raw);
  const own = new Set(ownIds);
  const twins: Twin[] = [];
  for (const [deviceId, other] of series) {
    if (own.has(deviceId) || other.size < TWIN_MIN_MINUTES) continue;
    let best: Twin | null = null;
    for (const ofDeviceId of ownIds) {
      const reference = series.get(ofDeviceId);
      const match = reference && compare(reference, other);
      if (!match || match.spread < TWIN_MIN_SPREAD_DB) continue;
      if (match.correlation < TWIN_MIN_CORRELATION || match.gap > TWIN_MAX_GAP_DB) continue;
      if (!best || match.correlation > best.correlation) {
        best = { deviceId, ofDeviceId, correlation: match.correlation, minutes: match.minutes };
      }
    }
    if (best) twins.push(best);
  }
  return twins;
}
