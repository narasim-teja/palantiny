import type { Database } from "bun:sqlite";
import { classLabel } from "@core/classify";
import { getMeta } from "./db";
import { deriveFindings } from "@core/findings";
import type {
  DeviceClass,
  DeviceDetail,
  DeviceView,
  FindMyState,
  NetworkView,
  PlaceView,
  SensorStatus,
  Snapshot,
  Visit,
} from "@core/types";

const LIVE_WINDOW_MS = 90_000;
const STALE_AFTER_MS = 20_000;
const OFFLINE_AFTER_MS = 120_000;
const VISIT_GAP_MINUTES = 10;
const MAX_DEVICES = 160;
const MAX_NETWORKS = 60;

interface DeviceRow {
  id: number;
  code: string | null;
  class: DeviceClass;
  vendor: string | null;
  find_my: FindMyState;
  name: string | null;
  trusted: number;
  watched: number;
  paired: number;
  first_seen: number;
  last_seen: number;
  person_code: string | null;
  person_label: string | null;
  person_self: number | null;
  alias_count: number;
  min_confidence: number | null;
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
              MAX(s.minute) AS lastMinute
       FROM sightings s JOIN aliases a ON a.id = s.alias_id
       GROUP BY a.device_id, s.place_id`,
    )
    .all() as {
    deviceId: number;
    placeId: number;
    minutes: number;
    bestRssi: number;
    lastMinute: number;
  }[];
  const byDevice = new Map<number, DeviceView["presence"]>();
  for (const row of rows) {
    const list = byDevice.get(row.deviceId) ?? [];
    list.push({
      placeId: row.placeId,
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
export function buildSnapshot(db: Database, reveal: boolean, now = Date.now()): Snapshot {
  const currentPlaceId = Number(getMeta(db, "current_place") ?? 0);
  const presence = readPresence(db);

  const rows = db
    .query(
      `SELECT d.*, p.code AS person_code, p.label AS person_label, p.self AS person_self,
              COUNT(a.id) AS alias_count, MIN(a.link_confidence) AS min_confidence
       FROM devices d
       LEFT JOIN people p ON p.id = d.person_id
       LEFT JOIN aliases a ON a.device_id = d.id
       GROUP BY d.id`,
    )
    .all() as DeviceRow[];

  const all: DeviceView[] = rows.map((row) => {
    const self = row.person_self === 1;
    return {
      id: row.id,
      code: row.code ?? `DEV-${String(row.id).padStart(4, "0")}`,
      class: row.class,
      classLabel: classLabel(row.class, row.find_my),
      vendor: row.vendor,
      findMy: row.find_my,
      // Your own devices may show their name. Nobody else's does in screenshot mode.
      name: reveal ? row.name : null,
      hasName: row.name !== null,
      owner: row.person_code
        ? { code: row.person_code, label: row.person_label, self }
        : null,
      trusted: row.trusted === 1,
      watched: row.watched === 1,
      paired: row.paired === 1,
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      aliasCount: row.alias_count,
      identityConfidence: row.min_confidence ?? 1,
      presence: presence.get(row.id) ?? [],
      live: now - row.last_seen < LIVE_WINDOW_MS,
    };
  });

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

  const count = (sql: string) => (db.query(sql).get() as { n: number }).n;

  return {
    generatedAt: now,
    reveal,
    fixture: getMeta(db, "fixture") === "1",
    status: readStatus(db, now),
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
