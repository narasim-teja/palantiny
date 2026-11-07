import type { Closer } from "./types";

// Bring something up to the Mac and this finds which signal answered. It's how a device that
// rotates can be picked out on purpose: you make something happen, and match it in time.

/** Long enough to catch a device held still, short enough to answer while you're holding it. */
export const RECENT_MINUTES = 2;
export const BASELINE_MINUTES = 10;
/** Normal movement in a room stays well inside this. Fixed gadgets drift about 1 dB. */
export const MIN_RISE_DB = 15;
/** A jump only means something if it ended up near. A faint device can rise 17 dB and still be far off. */
export const NEAR_RSSI = -60;
/**
 * This close counts on its own, because a rotation can wipe out the earlier signal mid-test.
 * A real AirTag held to the Mac sat at about -44, wobbling a few dB, so this leaves it room.
 */
export const TOUCHING_RSSI = -50;
const MAX_RESULTS = 5;

export interface DeviceMinute {
  deviceId: number;
  minute: number;
  rssi: number;
}

const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

/** Best first. `rise` is null for something that wasn't heard at all before. */
export function whatGotCloser(rows: DeviceMinute[], nowMinute: number): Closer[] {
  const byDevice = new Map<number, DeviceMinute[]>();
  for (const row of rows) byDevice.set(row.deviceId, [...(byDevice.get(row.deviceId) ?? []), row]);

  const found: Closer[] = [];
  for (const [deviceId, minutes] of byDevice) {
    const recent = minutes.filter((row) => nowMinute - row.minute < RECENT_MINUTES).map((row) => row.rssi);
    const before = minutes
      .filter((row) => {
        const age = nowMinute - row.minute;
        return age >= RECENT_MINUTES && age < RECENT_MINUTES + BASELINE_MINUTES;
      })
      .map((row) => row.rssi);
    if (recent.length === 0) continue;
    const rssi = Math.round(mean(recent));
    const rise = before.length > 0 ? Math.round(mean(recent) - mean(before)) : null;
    const jumped = rise !== null && rise >= MIN_RISE_DB && rssi >= NEAR_RSSI;
    if (jumped || rssi >= TOUCHING_RSSI) found.push({ deviceId, rise, rssi });
  }
  return found.sort((a, b) => b.rssi - a.rssi).slice(0, MAX_RESULTS);
}
