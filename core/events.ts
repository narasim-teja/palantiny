// The sensor format. Anything that can write these as JSON lines to the server's Unix
// socket is a sensor, in any language and on any OS. `native/macos` is the first one.

export const PROTOCOL_VERSION = 1;

export interface HelloEvent {
  t: "hello";
  ts: number;
  v: number;
}

export interface StatusEvent {
  t: "status";
  ts: number;
  bluetooth?: string;
  location?: string;
  wifi?: string;
}

/** One Bluetooth advert. `mfr` is hex manufacturer data, `svc` is service UUIDs. */
export interface BleEvent {
  t: "ble";
  ts: number;
  /** Stable for as long as the sender keeps this address. */
  id: string;
  rssi: number;
  name?: string;
  mfr?: string;
  svc?: string[];
}

export interface WifiNet {
  ssid?: string;
  bssid?: string;
  rssi: number;
  secured: boolean;
  channel?: number;
  band?: number;
}

/** One completed Wi-Fi scan. Places are recognised from these. */
export interface WifiEvent {
  t: "wifi";
  ts: number;
  nets: WifiNet[];
}

export type SensorEvent = HelloEvent | StatusEvent | BleEvent | WifiEvent;

/** Sensors are separate programs, so nothing they send is trusted to be well formed. */
export function parseSensorEvent(line: string): SensorEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const event = value as Record<string, unknown>;
  if (typeof event.ts !== "number") return null;
  switch (event.t) {
    case "hello":
    case "status":
      return value as SensorEvent;
    case "ble":
      return typeof event.id === "string" && typeof event.rssi === "number" ? (value as BleEvent) : null;
    case "wifi":
      return Array.isArray(event.nets) ? (value as WifiEvent) : null;
    default:
      return null;
  }
}
