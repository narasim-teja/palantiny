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

/**
 * Whether this identity can be recognised again later, at another place.
 * stable    one fixed identity
 * named     rotates, but keeps a serial in its name
 * keyed     separated Find My device, whose key lasts up to a day
 * rotating  changes identity, so it's lost between places
 * new       too soon to tell
 */
export type Stability = "stable" | "named" | "keyed" | "rotating" | "new";

export interface SensorStatus {
  sensor: "live" | "stale" | "offline";
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
  firstSeen: number;
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
  /** Your own name for it. Someone else's device keeps this out of screenshot mode. */
  label: string | null;
  /** In screenshot mode someone else appears under their public name, or none at all. */
  owner: { code: string; label: string | null; self: boolean } | null;
  stability: Stability;
  trusted: boolean;
  watched: boolean;
  /** When you started watching. Places first seen after this count as new. */
  watchedAt: number | null;
  /** Set while a watched device has just come back from a long absence. */
  back: { after: number; at: number } | null;
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

export interface PersonView {
  id: number;
  /** Their real name, which never leaves this console in screenshot mode. */
  label: string;
  /** What recordings show instead. */
  publicLabel: string | null;
}

export interface Snapshot {
  generatedAt: number;
  reveal: boolean;
  fixture: boolean;
  status: SensorStatus;
  /** People you've added. Empty in screenshot mode, because it's a list of names. */
  people: PersonView[];
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

export interface DeviceSearch {
  /** Every match, which can be more than the devices returned. */
  total: number;
  devices: DeviceView[];
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
  | { action: "rename-place"; placeId: number; label: string }
  | { action: "assign"; deviceId: number; person: string; publicLabel?: string }
  | { action: "name-device"; deviceId: number; label: string };
