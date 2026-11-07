// The palantiny ontology, as the console sees it.
//
//   Person  -OWNS->      Device      only ever set by you, or by a paired device
//   Person  -NEAR->      Mac         read from their devices, see core/person.ts
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
  /** Type bits of its Find My status byte. 1 means AirTag-like. Null if never captured. */
  findMyType: number | null;
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
  /** Trips between places it made with this Mac. Null until it's been heard at two places. */
  cameAlong: { trips: number; of: number } | null;
  /** One of your devices whose signal this one is matching. See core/twins.ts. */
  twinOf: { deviceId: number; title: string; minutes: number } | null;
  /** One of your devices it fell silent with, to the second. See core/together.ts. */
  leftWith: { deviceId: number; title: string; at: number } | null;
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

/**
 * What a tagged person's devices say right now. All of it is relative to this Mac.
 * in-range  heard just now
 * quiet     not heard, but no longer than this device usually goes quiet
 * silent    quiet for far longer than usual. It may have left, or be off or charging
 * unknown   silence here means nothing, so no call is made
 */
export type PresenceState = "in-range" | "quiet" | "silent" | "unknown";

/**
 * Where this person could be recognised.
 * anywhere  a device they carry keeps an identity, so it works at any place
 * local     only rotating devices, so a break in the signal loses them
 * none      nothing they carry is tagged
 */
export type PersonReach = "anywhere" | "local" | "none";

export interface DeviceReading {
  deviceId: number;
  code: string;
  title: string;
  state: PresenceState;
  /** Whether it goes where they go. A TV says nothing about its owner. */
  carried: boolean;
  /** Minutes this Mac was listening since it was last heard. */
  silent: number;
  /** Silence past this many listening minutes counts as gone. Null without enough history. */
  quietLimit: number | null;
}

export interface PersonPresence {
  code: string;
  /** Their public name in screenshot mode. Anyone without one is left out entirely. */
  label: string;
  state: PresenceState;
  reach: PersonReach;
  statement: string;
  lastHeard: number | null;
  /** Every place one of their carried devices was heard for a few minutes. */
  placeIds: number[];
  devices: DeviceReading[];
}

/**
 * What a stranger listening nearby can do with one of your devices.
 * recognisable  it keeps an identity, so anyone can pick it out again
 * rotating      it changes identity, so a stranger loses it
 * unverified    paired with this Mac, which holds its key, so this Mac can't see what strangers see
 */
export type Visibility = "recognisable" | "rotating" | "unverified";

export interface ExposureItem {
  deviceId: number;
  code: string;
  title: string;
  visibility: Visibility;
  reason: string;
  /** Share of this Mac's listening minutes it was heard in. */
  heardShare: number;
  /** Minutes between bursts, if a usually steady computer has dropped to bursts. */
  sleepPulse: number | null;
}

/** What the air around you gives away, as worked out from your own devices. */
export interface Exposure {
  statement: string;
  recognisable: number;
  unverified: number;
  rotating: number;
  items: ExposureItem[];
  /** Your devices heard under rotating identities, which can be matched back to them. */
  echoes: { title: string; identities: number; addressChanges: number }[];
  /**
   * The routine a stranger could log from your most heard recognisable device: share of
   * listening minutes heard in each hour of the day, null where this Mac wasn't listening.
   */
  routine: { deviceId: number; hours: (number | null)[] } | null;
}

/** What's on the air this minute, counted so that rotation can't inflate it. */
export interface AirNow {
  /** Find My addresses live now, which is about one per device. */
  findMy: number;
  airTagLike: { nearOwner: number; separated: number };
}

/** A device whose signal just jumped. `rise` is null if it wasn't heard before. */
export interface Closer {
  deviceId: number;
  rise: number | null;
  rssi: number;
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
  presence: PersonPresence[];
  exposure: Exposure;
  air: AirNow;
  closer: Closer[];
  /** Set for a few minutes after the Mac itself moves. See core/moved.ts. */
  moved: { shift: number; anchors: number } | null;
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
