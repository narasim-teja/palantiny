// The palantiny ontology, as the console sees it.
//
//   Person  -OWNS->      Device      only ever set by you, or by a paired device
//   Device  -HAS_ALIAS-> Alias       one rotating Bluetooth identity
//   Device  -SEEN_AT->   Place       observed through Sightings
//   Network -SEEN_AT->   Place       Wi-Fi networks are what define a Place

export type DeviceClass =
  | "tag"
  | "personal"
  | "audio"
  | "wearable"
  | "media"
  | "home"
  | "beacon"
  | "unknown";

export type FindMyState = "separated" | "near-owner" | null;

export type Severity = "high" | "medium" | "note";

export interface SensorStatus {
  collector: "live" | "stale" | "offline";
  bluetooth: string;
  location: string;
  wifi: string;
  lastEventAt: number | null;
}

export interface PlaceView {
  id: number;
  code: string;
  label: string | null;
  firstSeen: number;
  lastSeen: number;
  networkCount: number;
  deviceCount: number;
  current: boolean;
}

export interface DevicePresence {
  placeId: number;
  minutes: number;
  bestRssi: number;
  lastSeen: number;
}

export interface DeviceView {
  id: number;
  code: string;
  class: DeviceClass;
  classLabel: string;
  vendor: string | null;
  findMy: FindMyState;
  /** Null in screenshot mode. */
  name: string | null;
  hasName: boolean;
  owner: { code: string; label: string | null; self: boolean } | null;
  trusted: boolean;
  watched: boolean;
  paired: boolean;
  firstSeen: number;
  lastSeen: number;
  aliasCount: number;
  /** Lowest confidence across inferred alias links. 1 means no inference was needed. */
  identityConfidence: number;
  presence: DevicePresence[];
  live: boolean;
}

export interface NetworkView {
  id: number;
  code: string;
  /** Null in screenshot mode, or when the network hides its name. */
  ssid: string | null;
  secured: boolean;
  band: string | null;
  bestRssi: number;
  placeIds: number[];
}

export interface Finding {
  id: string;
  severity: Severity;
  deviceId: number;
  deviceCode: string;
  title: string;
  detail: string;
  placeIds: number[];
  confidence: number;
  /** True when the identity holds without any inferred alias link. */
  observed: boolean;
}

export interface Visit {
  placeId: number;
  start: number;
  end: number;
}

export interface Snapshot {
  generatedAt: number;
  reveal: boolean;
  fixture: boolean;
  status: SensorStatus;
  places: PlaceView[];
  devices: DeviceView[];
  networks: NetworkView[];
  findings: Finding[];
  visits: Visit[];
  totals: {
    devices: number;
    aliases: number;
    sightings: number;
    networks: number;
    places: number;
    people: number;
  };
}

export interface AliasView {
  code: string;
  firstSeen: number;
  lastSeen: number;
  confidence: number | null;
  evidence: string | null;
}

export interface DeviceDetail {
  aliases: AliasView[];
  sightings: { placeId: number; minute: number; rssi: number }[];
  log: { ts: number; action: string }[];
}

export type ActionRequest =
  | { action: "claim" | "unclaim" | "trust" | "untrust" | "watch" | "unwatch"; deviceId: number }
  | { action: "rename-place"; placeId: number; label: string };
