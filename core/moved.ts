import type { DeviceMinute } from "./closer";

// Fixed gadgets don't move, so if they all shift at once, it was the Mac. No GPS or Wi-Fi
// needed, and it sees moves far smaller than a change of place: one room over is enough.
//
// Carried to another room for real, signals shifted 8 dB within 3 minutes, against 1 to 2
// dB normally. Replayed over 46 hours, that was the only awake event past this limit.

export const MOVED_RECENT_MINUTES = 3;
export const MOVED_BASELINE_MINUTES = 30;
export const MOVED_SHIFT_DB = 6;
const MIN_BASELINE_MINUTES = 15;
const MIN_ANCHORS = 8;

export interface Moved {
  /** Median change across the anchors, in dB. */
  shift: number;
  anchors: number;
}

const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

/** `listening` is ascending minutes. A sleep inside the window can't be read either way. */
export function readMoved(rows: DeviceMinute[], listening: number[]): Moved | null {
  const recent = listening.slice(-MOVED_RECENT_MINUTES);
  const baseline = listening.slice(-MOVED_RECENT_MINUTES - MOVED_BASELINE_MINUTES, -MOVED_RECENT_MINUTES);
  if (recent.length < MOVED_RECENT_MINUTES || baseline.length < MOVED_BASELINE_MINUTES) return null;
  if (recent.at(-1)! - baseline.at(-1)! > MOVED_RECENT_MINUTES + 1) return null;

  const recentMinutes = new Set(recent);
  const baselineMinutes = new Set(baseline);
  const byDevice = new Map<number, { before: number[]; now: number[] }>();
  for (const row of rows) {
    const device = byDevice.get(row.deviceId) ?? { before: [], now: [] };
    if (recentMinutes.has(row.minute)) device.now.push(row.rssi);
    if (baselineMinutes.has(row.minute)) device.before.push(row.rssi);
    byDevice.set(row.deviceId, device);
  }

  const shifts = [...byDevice.values()]
    .filter(({ before, now }) => before.length >= MIN_BASELINE_MINUTES && now.length > 0)
    .map(({ before, now }) => Math.abs(mean(now) - mean(before)))
    .sort((a, b) => a - b);
  if (shifts.length < MIN_ANCHORS) return null;
  const shift = shifts[Math.floor(shifts.length / 2)]!;
  return shift >= MOVED_SHIFT_DB ? { shift: Math.round(shift), anchors: shifts.length } : null;
}
