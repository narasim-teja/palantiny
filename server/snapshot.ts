import type { Database } from "bun:sqlite";
import { callsign } from "@core/callsign";
import { classLabel } from "@core/classify";
import { getMeta } from "./db";
import { deriveFindings } from "@core/findings";
import { lastReturn } from "@core/presence";
import { isDistinctiveName, recognise } from "@core/recognise";
import { matches } from "@core/search";
import type {
  DeviceClass,
  DeviceDetail,
  DeviceSearch,
  DeviceView,
  FindMyState,
  NetworkView,
  PersonView,
  PlaceView,
  SensorStatus,
  Snapshot,
  Stability,
  Visit,
} from "@core/types";

const LIVE_WINDOW_MS = 90_000;
const STALE_AFTER_MS = 20_000;
const OFFLINE_AFTER_MS = 120_000;
const VISIT_GAP_MINUTES = 10;
const MAX_DEVICES = 160;
const MAX_NETWORKS = 60;
const MAX_SEARCH_RESULTS = 200;
// A single address held this long has stopped being a rotation that hasn't happened yet.
const STABLE_AFTER_MS = 2 * 3_600_000;

interface DeviceRow {
  id: number;
  code: string | null;
  class: DeviceClass;
  vendor: string | null;
  find_my: FindMyState;
  name: string | null;
  label: string | null;
  trusted: number;
  watched: number;
  watched_at: number | null;
  paired: number;
  first_seen: number;
  last_seen: number;
  person_code: string | null;
  person_label: string | null;
  person_public: string | null;
  person_self: number | null;
  alias_count: number;
  min_confidence: number | null;
  longest_alias: number | null;
}

function stabilityOf(row: DeviceRow): Stability {
  if (row.paired === 1) return "stable";
  if (row.find_my === "separated") return "keyed";
  if (row.alias_count > 1) return row.name && isDistinctiveName(row.name) ? "named" : "rotating";
  return (row.longest_alias ?? 0) >= STABLE_AFTER_MS ? "stable" : "new";
}

function readStatus(db: Database, now: number): SensorStatus {
  const heartbeat = Number(getMeta(db, "heartbeat") ?? 0);
  const age = now - heartbeat;
  const sensor =
    heartbeat === 0 || age > OFFLINE_AFTER_MS ? "offline" : age > STALE_AFTER_MS ? "stale" : "live";
  return {
    sensor,
    bluetooth: getMeta(db, "status.bluetooth") ?? "unknown",
    location: getMeta(db, "status.location") ?? "unknown",
    wifi: getMeta(db, "status.wifi") ?? "unknown",
    lastEventAt: heartbeat || null,
  };
}

function readPresence(db: Database) {
  const rows = db
    .query(
      `SELECT a.device_id AS deviceId, s.place_id AS placeId,
              COUNT(DISTINCT s.minute) AS minutes,
              MAX(s.rssi_max) AS bestRssi,
              MIN(s.minute) AS firstMinute,
              MAX(s.minute) AS lastMinute
       FROM sightings s JOIN aliases a ON a.id = s.alias_id
       GROUP BY a.device_id, s.place_id`,
    )
    .all() as {
    deviceId: number;
    placeId: number;
    minutes: number;
    bestRssi: number;
    firstMinute: number;
    lastMinute: number;
  }[];
  const byDevice = new Map<number, DeviceView["presence"]>();
  for (const row of rows) {
    const list = byDevice.get(row.deviceId) ?? [];
    list.push({
      placeId: row.placeId,
      firstSeen: row.firstMinute * 60_000,
      minutes: row.minutes,
      bestRssi: row.bestRssi,
      lastSeen: row.lastMinute * 60_000,
    });
    byDevice.set(row.deviceId, list);
  }
  return byDevice;
}

function readVisits(db: Database): Visit[] {
  const rows = db
    .query("SELECT DISTINCT place_id AS placeId, minute FROM sightings ORDER BY minute")
    .all() as { placeId: number; minute: number }[];
  const visits: Visit[] = [];
  let open: { placeId: number; first: number; last: number } | null = null;
  for (const row of rows) {
    if (open && open.placeId === row.placeId && row.minute - open.last <= VISIT_GAP_MINUTES) {
      open.last = row.minute;
      continue;
    }
    if (open) {
      visits.push({ placeId: open.placeId, start: open.first * 60_000, end: (open.last + 1) * 60_000 });
    }
    open = { placeId: row.placeId, first: row.minute, last: row.minute };
  }
  if (open) {
    visits.push({ placeId: open.placeId, start: open.first * 60_000, end: (open.last + 1) * 60_000 });
  }
  return visits;
}

/** Only watched devices need this, so the cost stays tiny however much data there is. */
function readReturns(db: Database, deviceIds: number[], now: number) {
  const returns = new Map<number, DeviceView["back"]>();
  if (deviceIds.length === 0) return returns;
  const listening = (
    db.query("SELECT DISTINCT minute FROM sightings ORDER BY minute").all() as { minute: number }[]
  ).map((row) => row.minute);
  const heard = db.query(
    `SELECT DISTINCT s.minute FROM sightings s JOIN aliases a ON a.id = s.alias_id
     WHERE a.device_id = ? ORDER BY s.minute`,
  );
  for (const id of deviceIds) {
    const minutes = (heard.all(id) as { minute: number }[]).map((row) => row.minute);
    const back = lastReturn(minutes, listening, Math.floor(now / 60_000));
    if (back) returns.set(id, { after: back.after, at: back.at * 60_000 });
  }
  return returns;
}

function relevance(device: DeviceView, flagged: Set<number>, now: number): number {
  let score = 0;
  if (flagged.has(device.id)) score += 1000;
  if (device.watched) score += 800;
  if (device.owner) score += 400;
  if (device.live) score += 200;
  score += device.presence.length * 50;
  score += Math.max(0, 100 - (now - device.lastSeen) / 3_600_000);
  return score;
}

// Screenshot mode is enforced here, on the server, so a hidden name is never sent to
// the browser and cannot leak through the page source or a stray tooltip.
function readDevices(db: Database, reveal: boolean, now: number): DeviceView[] {
  const presence = readPresence(db);

  const rows = db
    .query(
      `SELECT d.*, p.code AS person_code, p.label AS person_label, p.public_label AS person_public,
              p.self AS person_self,
              COUNT(a.id) AS alias_count, MIN(a.link_confidence) AS min_confidence,
              MAX(a.last_seen - a.first_seen) AS longest_alias
       FROM devices d
       LEFT JOIN people p ON p.id = d.person_id
       LEFT JOIN aliases a ON a.device_id = d.id
       GROUP BY d.id`,
    )
    .all() as DeviceRow[];

  const returns = readReturns(
    db,
    rows.filter((row) => row.watched === 1).map((row) => row.id),
    now,
  );

  return rows.map((row) => {
    const self = row.person_self === 1;
    // What a broadcast says it is beats what we could guess from its advert. A separated
    // Find My device keeps that label, because that's the more useful thing to know.
    const known = row.find_my === "separated" ? null : recognise(row.name);
    const deviceClass = known?.class ?? row.class;
    return {
      id: row.id,
      code: callsign(row.id),
      class: deviceClass,
      classLabel: known?.kind ?? classLabel(deviceClass, row.find_my),
      vendor: row.vendor,
      findMy: row.find_my,
      // Your own devices may show their name. Nobody else's does in screenshot mode.
      name: reveal ? row.name : null,
      hasName: row.name !== null,
      // Your own names are yours to show. Someone else never agreed to be on a recording.
      label: self || reveal ? row.label : null,
      owner: row.person_code
        ? { code: row.person_code, label: self || reveal ? row.person_label : row.person_public, self }
        : null,
      stability: stabilityOf(row),
      trusted: row.trusted === 1,
      watched: row.watched === 1,
      watchedAt: row.watched_at,
      back: returns.get(row.id) ?? null,
      paired: row.paired === 1,
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      aliasCount: row.alias_count,
      identityConfidence: row.min_confidence ?? 1,
      presence: presence.get(row.id) ?? [],
      live: now - row.last_seen < LIVE_WINDOW_MS,
    };
  });
}

/** Searches every device, not just the ones a snapshot carries. */
export function searchDevices(db: Database, query: string, reveal: boolean, now = Date.now()): DeviceSearch {
  const found = readDevices(db, reveal, now)
    .filter((device) => matches(device, query))
    .sort((a, b) => Number(b.live) - Number(a.live) || b.lastSeen - a.lastSeen);
  return { total: found.length, devices: found.slice(0, MAX_SEARCH_RESULTS) };
}

export function buildSnapshot(db: Database, reveal: boolean, now = Date.now()): Snapshot {
  const currentPlaceId = Number(getMeta(db, "current_place") ?? 0);
  const all = readDevices(db, reveal, now);
  const findings = deriveFindings(all);
  const flagged = new Set(findings.map((finding) => finding.deviceId));
  const devices = [...all]
    .sort((a, b) => relevance(b, flagged, now) - relevance(a, flagged, now))
    .slice(0, MAX_DEVICES);

  const placeRows = db
    .query(
      `SELECT pl.*,
         (SELECT COUNT(*) FROM network_sightings ns WHERE ns.place_id = pl.id) AS network_count,
         (SELECT COUNT(DISTINCT a.device_id) FROM sightings s JOIN aliases a ON a.id = s.alias_id
           WHERE s.place_id = pl.id) AS device_count
       FROM places pl ORDER BY pl.last_seen DESC`,
    )
    .all() as {
    id: number;
    code: string;
    label: string | null;
    first_seen: number;
    last_seen: number;
    network_count: number;
    device_count: number;
  }[];

  const places: PlaceView[] = placeRows.map((row) => ({
    id: row.id,
    code: row.code,
    label: row.label,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    networkCount: row.network_count,
    deviceCount: row.device_count,
    current: row.id === currentPlaceId,
  }));

  const networkRows = db
    .query(
      `SELECT n.id, n.code, n.ssid, n.secured, n.band,
              MAX(ns.best_rssi) AS best_rssi, GROUP_CONCAT(ns.place_id) AS place_ids
       FROM networks n JOIN network_sightings ns ON ns.network_id = n.id
       GROUP BY n.id ORDER BY best_rssi DESC LIMIT ?`,
    )
    .all(MAX_NETWORKS) as {
    id: number;
    code: string | null;
    ssid: string | null;
    secured: number;
    band: string | null;
    best_rssi: number;
    place_ids: string;
  }[];

  const networks: NetworkView[] = networkRows.map((row) => ({
    id: row.id,
    code: row.code ?? `NET-${String(row.id).padStart(4, "0")}`,
    ssid: reveal ? row.ssid : null,
    secured: row.secured === 1,
    band: row.band,
    bestRssi: row.best_rssi,
    placeIds: row.place_ids.split(",").map(Number),
  }));

  const people: PersonView[] = reveal
    ? (db
        .query("SELECT id, label, public_label AS publicLabel FROM people WHERE self = 0 ORDER BY label")
        .all() as PersonView[])
    : [];

  const count = (sql: string) => (db.query(sql).get() as { n: number }).n;

  return {
    generatedAt: now,
    reveal,
    fixture: getMeta(db, "fixture") === "1",
    status: readStatus(db, now),
    people,
    places,
    devices,
    networks,
    findings,
    visits: readVisits(db),
    totals: {
      devices: all.length,
      aliases: count("SELECT COUNT(*) AS n FROM aliases"),
      sightings: count("SELECT COUNT(*) AS n FROM sightings"),
      networks: count("SELECT COUNT(*) AS n FROM networks"),
      places: places.length,
      people: count("SELECT COUNT(*) AS n FROM people"),
    },
  };
}

export function buildDeviceDetail(db: Database, deviceId: number): DeviceDetail {
  const aliases = db
    .query(
      `SELECT rowid AS seq, first_seen, last_seen, link_confidence, link_evidence
       FROM aliases WHERE device_id = ? ORDER BY first_seen`,
    )
    .all(deviceId) as {
    seq: number;
    first_seen: number;
    last_seen: number;
    link_confidence: number | null;
    link_evidence: string | null;
  }[];

  const sightings = db
    .query(
      `SELECT s.place_id AS placeId, s.minute AS minute, MAX(s.rssi_max) AS rssi
       FROM sightings s JOIN aliases a ON a.id = s.alias_id
       WHERE a.device_id = ? GROUP BY s.place_id, s.minute ORDER BY s.minute`,
    )
    .all(deviceId) as DeviceDetail["sightings"];

  const log = db
    .query("SELECT ts, action FROM action_log WHERE device_id = ? ORDER BY ts DESC LIMIT 12")
    .all(deviceId) as DeviceDetail["log"];

  return {
    // The real identifier is never shown. It stays in the database.
    aliases: aliases.map((alias, index) => ({
      code: `ALIAS-${index + 1}`,
      firstSeen: alias.first_seen,
      lastSeen: alias.last_seen,
      confidence: alias.link_confidence,
      evidence: alias.link_evidence,
    })),
    sightings,
    log,
  };
}
