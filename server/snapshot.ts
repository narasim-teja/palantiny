import type { Database } from "bun:sqlite";
import { isAirTagLike, readAir } from "@core/air";
import { callsign } from "@core/callsign";
import { classLabel } from "@core/classify";
import { BASELINE_MINUTES, RECENT_MINUTES, whatGotCloser, type DeviceMinute } from "@core/closer";
import { getMeta } from "./db";
import { readExposure } from "@core/exposure";
import { deriveFindings } from "@core/findings";
import { tripsOf, tripsTogether, type Heard } from "@core/moves";
import { readPeople } from "@core/person";
import { MOVED_BASELINE_MINUTES, MOVED_RECENT_MINUTES, readMoved } from "@core/moved";
import { lastReturn } from "@core/presence";
import { isDistinctiveName, recognise } from "@core/recognise";
import { matches } from "@core/search";
import { isSteady, leftTogether, LEFT_MAX_WINDOW_MS, LEFT_MIN_ADVERTS, LEFT_NEAR_RSSI, SILENCE_MIN_MS, type Ended, type Left, type Silence } from "@core/together";
import { findTwins, TWIN_WINDOW_MINUTES, type Twin } from "@core/twins";
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
// Tighter than "in range", so a rotation counts one device twice for as short a time as possible.
const AIR_WINDOW_MS = 60_000;
const STALE_AFTER_MS = 20_000;
const OFFLINE_AFTER_MS = 120_000;
const VISIT_GAP_MINUTES = 10;
const MAX_DEVICES = 160;
const MAX_NETWORKS = 60;
const MAX_SEARCH_RESULTS = 200;
const LEFT_LOOKBACK_MS = 24 * 3_600_000;
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

function readListening(db: Database): number[] {
  return (db.query("SELECT DISTINCT minute FROM sightings ORDER BY minute").all() as { minute: number }[]).map(
    (row) => row.minute,
  );
}

/** Per device, so only ask for the few that need it and the cost stays tiny however much data there is. */
function readHistory(db: Database, deviceIds: number[]): Map<number, Heard[]> {
  const query = db.query(
    `SELECT DISTINCT s.place_id AS placeId, s.minute FROM sightings s JOIN aliases a ON a.id = s.alias_id
     WHERE a.device_id = ? ORDER BY s.minute`,
  );
  return new Map(deviceIds.map((id) => [id, query.all(id) as Heard[]]));
}

const minutesOf = (heard: Heard[]) => [...new Set(heard.map((entry) => entry.minute))];

function readReturns(db: Database, deviceIds: number[], now: number) {
  const returns = new Map<number, DeviceView["back"]>();
  if (deviceIds.length === 0) return returns;
  const listening = readListening(db);
  for (const [id, heard] of readHistory(db, deviceIds)) {
    const back = lastReturn(minutesOf(heard), listening, Math.floor(now / 60_000));
    if (back) returns.set(id, { after: back.after, at: back.at * 60_000 });
  }
  return returns;
}

/** Only something heard at two places can have travelled, and few devices ever are. */
function readCameAlong(db: Database, presence: Map<number, DeviceView["presence"]>) {
  const counts = new Map<number, DeviceView["cameAlong"]>();
  const travelled = [...presence].filter(([, places]) => places.length >= 2).map(([id]) => id);
  if (travelled.length === 0) return counts;
  const trips = tripsOf(readVisits(db));
  for (const [id, heard] of readHistory(db, travelled)) {
    counts.set(id, { trips: tripsTogether(heard, trips), of: trips.length });
  }
  return counts;
}

/** SQLite takes the other column from the row holding the MAX, so this is each device's latest. */
function readFindMyTypes(db: Database) {
  const rows = db
    .query(
      `SELECT device_id AS id, find_my_type AS findMyType, MAX(last_seen) FROM aliases
       WHERE find_my_type IS NOT NULL GROUP BY device_id`,
    )
    .all() as { id: number; findMyType: number }[];
  return new Map(rows.map((row) => [row.id, row.findMyType]));
}

/** Each device's mean signal per minute. Everything that reads signal shape starts here. */
function readSignals(db: Database, sinceMinute: number): DeviceMinute[] {
  return db
    .query(
      `SELECT a.device_id AS deviceId, s.minute, SUM(s.rssi_sum) * 1.0 / SUM(s.n) AS rssi
       FROM sightings s JOIN aliases a ON a.id = s.alias_id
       WHERE s.minute >= ? GROUP BY a.device_id, s.minute`,
    )
    .all(sinceMinute) as DeviceMinute[];
}

/** Your departures from the last day: past silences, plus any that's still going on. */
function readSilences(db: Database, ownIds: number[], now: number): Silence[] {
  if (ownIds.length === 0) return [];
  const since = now - LEFT_LOOKBACK_MS;
  const ids = JSON.stringify(ownIds);
  const past = db
    .query(
      `SELECT device_id AS deviceId, from_ts AS "from" FROM silences
       WHERE from_ts >= ? AND device_id IN (SELECT value FROM json_each(?))`,
    )
    .all(since, ids) as Silence[];
  const open = db
    .query(
      `SELECT device_id AS deviceId, MAX(last_seen) AS "from" FROM aliases
       WHERE device_id IN (SELECT value FROM json_each(?))
       GROUP BY device_id HAVING MAX(last_seen) BETWEEN ? AND ?`,
    )
    .all(ids, since, now - SILENCE_MIN_MS) as Silence[];
  return [...past, ...open];
}

function readLeftWith(
  db: Database,
  ownIds: number[],
  presence: Map<number, DeviceView["presence"]>,
  now: number,
): Map<number, Left> {
  const listening = readListening(db);
  const heardMinutes = (id: number) => (presence.get(id) ?? []).reduce((sum, place) => sum + place.minutes, 0);
  const steady = ownIds.filter((id) => isSteady(heardMinutes(id), listening.length));
  const silences = readSilences(db, steady, now);
  if (silences.length === 0) return new Map();
  // A signal either stopped and stayed gone, or stopped and came back, which is a silence.
  const stayedGone = db.query(
    `SELECT a.device_id AS deviceId, a.first_seen AS firstSeen, a.last_seen AS lastSeen, a.rssi_n AS adverts,
            (SELECT MAX(s.rssi_max) FROM sightings s WHERE s.alias_id = a.id) AS bestRssi
     FROM aliases a WHERE a.last_seen BETWEEN ? AND ? AND a.rssi_n >= ? AND bestRssi >= ?`,
  );
  const cameBack = db.query(
    `SELECT device_id AS deviceId, first_seen AS firstSeen, from_ts AS lastSeen, best_rssi AS bestRssi, adverts
     FROM silences WHERE from_ts BETWEEN ? AND ? AND adverts >= ? AND best_rssi >= ?`,
  );
  const own = new Set(ownIds);
  const ended = silences
    .flatMap((silence) => {
      const near = [silence.from - LEFT_MAX_WINDOW_MS, silence.from + LEFT_MAX_WINDOW_MS, LEFT_MIN_ADVERTS, LEFT_NEAR_RSSI];
      return [...stayedGone.all(...near), ...cameBack.all(...near)] as Ended[];
    })
    .filter((signal) => !own.has(signal.deviceId));
  return new Map(leftTogether(silences, ended, new Set(listening)).map((left) => [left.deviceId, left]));
}

const twinCache = new WeakMap<Database, { key: string; twins: Map<number, Twin> }>();

/** Signals only change by the minute, so one reading serves every snapshot in that minute. */
function readTwins(db: Database, ownIds: number[], now: number) {
  const minute = Math.floor(now / 60_000);
  const key = `${minute}:${ownIds.join()}`;
  const cached = twinCache.get(db);
  if (cached?.key === key) return cached.twins;

  const series = new Map<number, Map<number, number>>();
  for (const row of readSignals(db, minute - TWIN_WINDOW_MINUTES)) {
    const device = series.get(row.deviceId) ?? new Map<number, number>();
    device.set(row.minute, row.rssi);
    series.set(row.deviceId, device);
  }
  const twins = new Map(findTwins(series, ownIds).map((twin) => [twin.deviceId, twin]));
  twinCache.set(db, { key, twins });
  return twins;
}

function readAirNow(db: Database, now: number) {
  return readAir(
    db
      .query(
        `SELECT a.find_my_type AS findMyType, d.find_my AS findMy FROM aliases a JOIN devices d ON d.id = a.device_id
         WHERE a.last_seen > ?`,
      )
      .all(now - AIR_WINDOW_MS) as { findMyType: number | null; findMy: FindMyState }[],
  );
}

function readMacMoved(db: Database, listening: number[]) {
  const since = listening.at(-MOVED_RECENT_MINUTES - MOVED_BASELINE_MINUTES);
  return since === undefined ? null : readMoved(readSignals(db, since), listening);
}

function readCloser(db: Database, mine: Set<number>, now: number) {
  const nowMinute = Math.floor(now / 60_000);
  const rows = readSignals(db, nowMinute - RECENT_MINUTES - BASELINE_MINUTES + 1);
  // Your own devices move with you all day, so they'd only drown out what you're looking for.
  return whatGotCloser(rows.filter((row) => !mine.has(row.deviceId)), nowMinute);
}

function twinFor(twin: Twin | undefined, titleOf: (id: number) => string): DeviceView["twinOf"] {
  return twin ? { deviceId: twin.ofDeviceId, title: titleOf(twin.ofDeviceId), minutes: twin.minutes } : null;
}

function leftFor(left: Left | undefined, titleOf: (id: number) => string): DeviceView["leftWith"] {
  return left ? { deviceId: left.ofDeviceId, title: titleOf(left.ofDeviceId), at: left.at } : null;
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
  const cameAlong = readCameAlong(db, presence);
  const findMyTypes = readFindMyTypes(db);
  const yours = rows.filter((row) => row.person_self === 1);
  const ownIds = yours.map((row) => row.id);
  const twins = readTwins(db, ownIds, now);
  const leftWith = readLeftWith(db, ownIds, presence, now);
  const titleOf = (id: number) => {
    const row = yours.find((candidate) => candidate.id === id);
    return row?.label ?? recognise(row?.name ?? null)?.kind ?? classLabel(row?.class ?? "unknown", null);
  };

  return rows.map((row) => {
    const self = row.person_self === 1;
    // What a broadcast says it is beats what we could guess from its advert. A separated
    // Find My device keeps that label, because that's the more useful thing to know.
    const known = row.find_my === "separated" ? null : recognise(row.name);
    const deviceClass = known?.class ?? row.class;
    const findMyType = findMyTypes.get(row.id) ?? null;
    return {
      id: row.id,
      code: callsign(row.id),
      class: deviceClass,
      classLabel: known?.kind ?? (isAirTagLike(findMyType) ? "AirTag-like device" : classLabel(deviceClass, row.find_my)),
      vendor: row.vendor,
      findMy: row.find_my,
      findMyType,
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
      cameAlong: cameAlong.get(row.id) ?? null,
      twinOf: twinFor(twins.get(row.id), titleOf),
      leftWith: leftFor(leftWith.get(row.id), titleOf),
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
  // Your phone's other identities are you too. Something riding along stays on the list.
  const yours = all.filter((device) => device.owner?.self || (device.twinOf && !isAirTagLike(device.findMyType)));
  const listening = readListening(db);
  const moved = readMacMoved(db, listening);
  // When the Mac moves every signal jumps, so nothing can be said about what got closer.
  const closer = moved ? [] : readCloser(db, new Set(yours.map((device) => device.id)), now);
  // Anything the console points at has to be in the snapshot, or it can't be opened.
  const flagged = new Set([...findings.map((finding) => finding.deviceId), ...closer.map((entry) => entry.deviceId)]);
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

  const status = readStatus(db, now);
  const tagged = all.filter((device) => device.owner).map((device) => device.id);
  const heard = new Map([...readHistory(db, tagged)].map(([id, entries]) => [id, minutesOf(entries)]));

  return {
    generatedAt: now,
    reveal,
    fixture: getMeta(db, "fixture") === "1",
    status,
    people,
    places,
    devices,
    networks,
    findings,
    visits: readVisits(db),
    presence: readPeople(all, heard, listening, status.sensor === "live"),
    exposure: readExposure(all, heard, listening),
    air: readAirNow(db, now),
    closer,
    moved,
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
