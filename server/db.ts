import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function dbPath(): string {
  return resolve(process.env.PALANTINY_DB ?? "data/palantiny.db");
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS people (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  label TEXT,
  self INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS places (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  label TEXT,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY,
  code TEXT UNIQUE,
  class TEXT NOT NULL DEFAULT 'unknown',
  vendor TEXT,
  find_my TEXT,
  tag_key TEXT UNIQUE,
  name TEXT,
  person_id INTEGER REFERENCES people(id),
  trusted INTEGER NOT NULL DEFAULT 0,
  watched INTEGER NOT NULL DEFAULT 0,
  paired INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS aliases (
  id TEXT PRIMARY KEY,
  device_id INTEGER NOT NULL REFERENCES devices(id),
  place_id INTEGER REFERENCES places(id),
  signature TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  rssi_sum INTEGER NOT NULL DEFAULT 0,
  rssi_n INTEGER NOT NULL DEFAULT 0,
  predecessor_id TEXT,
  link_confidence REAL,
  link_evidence TEXT
);
CREATE INDEX IF NOT EXISTS aliases_device ON aliases(device_id);
CREATE INDEX IF NOT EXISTS aliases_recent ON aliases(last_seen);
CREATE INDEX IF NOT EXISTS aliases_predecessor ON aliases(predecessor_id);

CREATE TABLE IF NOT EXISTS sightings (
  alias_id TEXT NOT NULL REFERENCES aliases(id),
  place_id INTEGER NOT NULL REFERENCES places(id),
  minute INTEGER NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  rssi_sum INTEGER NOT NULL DEFAULT 0,
  rssi_max INTEGER NOT NULL DEFAULT -127,
  PRIMARY KEY (alias_id, place_id, minute)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS sightings_minute ON sightings(minute);

CREATE TABLE IF NOT EXISTS silences (
  device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  from_ts INTEGER NOT NULL,
  to_ts INTEGER NOT NULL,
  first_seen INTEGER,
  best_rssi INTEGER,
  adverts INTEGER,
  PRIMARY KEY (device_id, from_ts)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS networks (
  id INTEGER PRIMARY KEY,
  code TEXT UNIQUE,
  bssid_hash TEXT NOT NULL UNIQUE,
  ssid TEXT,
  band TEXT,
  secured INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS network_sightings (
  network_id INTEGER NOT NULL REFERENCES networks(id),
  place_id INTEGER NOT NULL REFERENCES places(id),
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  best_rssi INTEGER NOT NULL,
  PRIMARY KEY (network_id, place_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS action_log (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  action TEXT NOT NULL,
  device_id INTEGER,
  place_id INTEGER
);
`;

/** Columns added after the first release, so existing databases keep working. */
export function migrate(db: Database): void {
  const columns = db.query("PRAGMA table_info(devices)").all() as { name: string }[];
  if (!columns.some((column) => column.name === "label")) {
    db.run("ALTER TABLE devices ADD COLUMN label TEXT");
  }
  if (!columns.some((column) => column.name === "watched_at")) {
    db.run("ALTER TABLE devices ADD COLUMN watched_at INTEGER");
  }
  const aliasColumns = db.query("PRAGMA table_info(aliases)").all() as { name: string }[];
  if (!aliasColumns.some((column) => column.name === "find_my_type")) {
    db.run("ALTER TABLE aliases ADD COLUMN find_my_type INTEGER");
    // Before this column the type only lived at the end of the advert signature.
    db.run("UPDATE aliases SET find_my_type = CAST(substr(signature, -1) AS INTEGER) WHERE signature GLOB '*|t[0-9]'");
  }
  const silenceColumns = db.query("PRAGMA table_info(silences)").all() as { name: string }[];
  if (!silenceColumns.some((column) => column.name === "first_seen")) {
    db.run("ALTER TABLE silences ADD COLUMN first_seen INTEGER");
    db.run("ALTER TABLE silences ADD COLUMN adverts INTEGER");
  }
  if (!silenceColumns.some((column) => column.name === "best_rssi")) {
    db.run("ALTER TABLE silences ADD COLUMN best_rssi INTEGER");
  }
  if (silenceColumns.some((column) => column.name === "mean_rssi")) {
    // The best signal wasn't kept before, and the average is the closest thing there is.
    db.run("UPDATE silences SET best_rssi = CAST(mean_rssi AS INTEGER) WHERE best_rssi IS NULL");
    db.run("ALTER TABLE silences DROP COLUMN mean_rssi");
  }
  const personColumns = db.query("PRAGMA table_info(people)").all() as { name: string }[];
  if (!personColumns.some((column) => column.name === "public_label")) {
    db.run("ALTER TABLE people ADD COLUMN public_label TEXT");
  }
}

export function openDb(path = dbPath()): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  db.run("PRAGMA busy_timeout = 4000");
  db.run("PRAGMA foreign_keys = ON");
  db.run(SCHEMA);
  migrate(db);
  db.run("INSERT OR IGNORE INTO people (code, label, self) VALUES ('YOU', 'You', 1)");
  return db;
}

export function getMeta(db: Database, key: string): string | null {
  const row = db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null;
  return row?.value ?? null;
}

export function setMeta(db: Database, key: string, value: string): void {
  db.query(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}
