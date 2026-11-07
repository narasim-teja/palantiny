// Builds data/fixture.db, a clearly labelled synthetic database for checking layouts
// that need more places than the Mac has visited. The console shows a "Test data"
// flag whenever it is loaded, so it can never pass for real sightings.

import { rmSync } from "node:fs";
import { Ingest } from "../server/ingest";
import { openDb, setMeta } from "../server/db";

const PATH = "data/fixture.db";
for (const suffix of ["", "-wal", "-shm"]) rmSync(PATH + suffix, { force: true });
process.env.PALANTINY_DB = PATH;
const db = openDb(PATH);
const ingest = new Ingest(db);
setMeta(db, "fixture", "1");

let seed = 42;
const random = () => (seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32;
const pick = <T,>(items: T[]) => items[Math.floor(random() * items.length)]!;

const MIN = 60_000;
const now = Date.now();
const LONG = (byte: string) => `4c00121910${byte.repeat(22)}0100`;
const NEARBY = "4c0010020100";
const AUDIO = "4c0007190100";
const FIND_MY_NEAR = "4c0012020001";

const visits = [
  { place: "aa", label: "Home", from: 300, to: 190 },
  { place: "bb", label: "Cafe", from: 170, to: 120 },
  { place: "cc", label: "Office", from: 100, to: 30 },
  { place: "aa", label: "Home", from: 18, to: 0 },
];

function scan(ts: number, place: string) {
  ingest.wifi({
    t: "wifi",
    ts,
    nets: [1, 2, 3, 4, 5, 6].map((n) => ({
      ssid: `Test network ${place}${n}`,
      bssid: `${place}:${n}`,
      rssi: -45 - n * 6,
      secured: true,
      band: 2,
    })),
  });
}

let strangers = 0;
for (const visit of visits) {
  const start = now - visit.from * MIN;
  const end = now - visit.to * MIN;
  scan(start - 2_000, visit.place);
  scan(start - 1_000, visit.place);

  const locals = Array.from({ length: 26 }, () => ({
    id: `local-${visit.place}-${(strangers += 1)}`,
    rssi: -55 - Math.floor(random() * 40),
    mfr: pick([NEARBY, NEARBY, FIND_MY_NEAR, AUDIO, "060001", undefined]),
  }));

  for (let ts = start; ts <= end; ts += MIN) {
    ingest.ble({ t: "ble", ts, id: "my-phone", rssi: -38, mfr: NEARBY });
    ingest.ble({ t: "ble", ts, id: "my-buds", rssi: -42, mfr: AUDIO });
    ingest.ble({ t: "ble", ts, id: `tag-${visit.label}`, rssi: -62, mfr: LONG("ab") });
    ingest.ble({ t: "ble", ts, id: "colleague", rssi: -58, mfr: NEARBY });
    if (visit.place === "aa") {
      ingest.ble({ t: "ble", ts, id: "neighbour-tag", rssi: -84, mfr: LONG("cd") });
    }
    for (const local of locals) {
      if (random() > 0.55) ingest.ble({ t: "ble", ts, ...local });
    }
  }
}

const mine = db.query("SELECT device_id AS id FROM aliases WHERE id IN ('my-phone','my-buds')").all() as { id: number }[];
const self = db.query("SELECT id FROM people WHERE self = 1").get() as { id: number };
for (const { id } of mine) db.query("UPDATE devices SET person_id = ? WHERE id = ?").run(self.id, id);

// Someone you know, so the people panel has a person on it. Invented, like everything here.
const roommate = db
  .query("INSERT INTO people (code, label, public_label, self) VALUES ('PERSON-test', 'Test Person', 'Roommate', 0) RETURNING id")
  .get() as { id: number };
db.query("UPDATE devices SET person_id = ? WHERE id = (SELECT device_id FROM aliases WHERE id = 'colleague')").run(roommate.id);

// A device identified by inference, so dashed links can be checked.
const inferred = db.query("SELECT device_id AS id FROM aliases WHERE id = 'colleague'").get() as { id: number };
db.query("UPDATE aliases SET link_confidence = 0.75, link_evidence = 'Test link' WHERE id = 'colleague'").run();
void inferred;

db.query("UPDATE places SET label = 'Home' WHERE code = 'PLACE-A'").run();
db.query("UPDATE places SET label = 'Cafe' WHERE code = 'PLACE-B'").run();
db.query("UPDATE places SET label = 'Office' WHERE code = 'PLACE-C'").run();
setMeta(db, "heartbeat", String(Date.now() + 86_400_000));
setMeta(db, "status.bluetooth", "on");
setMeta(db, "status.location", "allowed");
setMeta(db, "status.wifi", "on");
console.log("fixture: wrote", PATH);
