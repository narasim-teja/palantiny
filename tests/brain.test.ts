import { describe, expect, test } from "bun:test";
import { readAir } from "../core/air";
import { whatGotCloser } from "../core/closer";
import { readExposure, routineOf, sleepPulse } from "../core/exposure";
import { deriveFindings } from "../core/findings";
import { tripsOf, tripsTogether } from "../core/moves";
import { readMoved } from "../core/moved";
import { MIN_HEARD_MINUTES, QUIET_FLOOR_MINUTES, quietLimit, readDevice, readPeople } from "../core/person";
import { isSteady, leftTogether, onTheQuarter } from "../core/together";
import { findTwins, TWIN_MIN_MINUTES } from "../core/twins";
import type { DeviceView, Visit } from "../core/types";
import { applyAction } from "../server/actions";
import { migrate, openDb } from "../server/db";
import { Ingest } from "../server/ingest";
import { buildSnapshot } from "../server/snapshot";

const device = (over: Partial<DeviceView>): DeviceView => ({
  id: 1,
  code: "Copper Heron",
  class: "wearable",
  classLabel: "Galaxy Watch",
  vendor: null,
  findMy: null,
  findMyType: null,
  name: null,
  hasName: false,
  label: null,
  owner: { code: "PERSON-1", label: "Roommate", self: false },
  stability: "stable",
  trusted: false,
  watched: false,
  watchedAt: null,
  back: null,
  cameAlong: null,
  twinOf: null,
  leftWith: null,
  paired: false,
  firstSeen: 0,
  lastSeen: 0,
  aliasCount: 1,
  identityConfidence: 1,
  presence: [],
  live: false,
  ...over,
});

const minutes = (count: number, from = 0) => Array.from({ length: count }, (_, index) => from + index);

describe("how long silence has to last", () => {
  test("needs enough history", () => {
    expect(quietLimit(minutes(MIN_HEARD_MINUTES - 1))).toBeNull();
    expect(quietLimit(minutes(MIN_HEARD_MINUTES))).toBe(QUIET_FLOOR_MINUTES);
  });

  test("stretches for a device that's quiet by nature", () => {
    const flickers = Array.from({ length: 200 }, (_, index) => index * 11);
    expect(quietLimit(flickers)).toBe(30);
  });
});

describe("reading a device", () => {
  const listening = minutes(200);

  test("counts silence in listening minutes, never on the clock", () => {
    const sleptThrough = [...minutes(100), ...minutes(100, 100_000)];
    const heard = minutes(100);
    expect(readDevice(device({}), heard, sleptThrough).silent).toBe(100);
    expect(readDevice(device({}), [...heard, 100_099], sleptThrough).silent).toBe(0);
  });

  test("tells normal quiet from a long silence", () => {
    expect(readDevice(device({}), minutes(190), listening).state).toBe("quiet");
    expect(readDevice(device({}), minutes(100), listening).state).toBe("silent");
  });

  test("a rotating device's silence proves nothing", () => {
    expect(readDevice(device({ stability: "rotating" }), minutes(100), listening).state).toBe("unknown");
    expect(readDevice(device({ stability: "new" }), minutes(100), listening).state).toBe("unknown");
  });

  test("makes no call without history", () => {
    expect(readDevice(device({}), minutes(5), listening).state).toBe("unknown");
  });

  test("anything heard just now is in range", () => {
    expect(readDevice(device({ live: true, stability: "rotating" }), [], listening).state).toBe("in-range");
  });
});

describe("reading a person", () => {
  const listening = minutes(200);
  const read = (devices: DeviceView[], heard: [number, number[]][], live = true) =>
    readPeople(devices, new Map(heard), listening, live);

  test("any carried device in range is enough, and says it's the device", () => {
    const [person] = read(
      [device({ id: 1, live: true }), device({ id: 2, class: "audio" })],
      [[1, minutes(200)], [2, minutes(100)]],
    );
    expect(person?.state).toBe("in-range");
    expect(person?.statement).toContain("not the person");
  });

  test("silence needs every recognisable device to agree", () => {
    const [split] = read([device({ id: 1 }), device({ id: 2 })], [[1, minutes(100)], [2, minutes(195)]]);
    expect(split?.state).toBe("quiet");
    const [both] = read([device({ id: 1 }), device({ id: 2 })], [[1, minutes(100)], [2, minutes(90)]]);
    expect(both?.state).toBe("silent");
    // It can't know why. A real watch on a charger read just like this.
    expect(both?.statement).toContain("may have left, or be off or charging");
  });

  test("a TV says nothing about its owner, even when it's on", () => {
    const [person] = read([device({ class: "media", live: true })], [[1, minutes(200)]]);
    expect(person?.state).toBe("unknown");
    expect(person?.reach).toBe("none");
  });

  test("only a device with a lasting identity reaches other places", () => {
    expect(read([device({ stability: "named" })], [])[0]?.reach).toBe("anywhere");
    expect(read([device({ stability: "rotating" })], [])[0]?.reach).toBe("local");
  });

  test("makes no call while this Mac isn't listening", () => {
    const [person] = read([device({ live: true })], [[1, minutes(200)]], false);
    expect(person?.state).toBe("unknown");
    expect(person?.statement).toContain("isn't listening");
  });

  test("leaves out you, strangers, and anyone without a name to show", () => {
    const people = read(
      [
        device({ id: 1, owner: { code: "YOU", label: "You", self: true } }),
        device({ id: 2, owner: null }),
        device({ id: 3, owner: { code: "PERSON-2", label: null, self: false } }),
      ],
      [],
    );
    expect(people).toEqual([]);
  });
});

describe("exposure", () => {
  const mine = { code: "YOU", label: "You", self: true };
  const listening = minutes(100);

  test("won't vouch for a paired device, because this Mac holds its key", () => {
    const report = readExposure(
      [device({ owner: mine, paired: true, stability: "stable" })],
      new Map([[1, minutes(100)]]),
      listening,
    );
    expect(report.items[0]?.visibility).toBe("unverified");
    expect(report.routine).toBeNull();
    expect(report.statement).toContain("unverified");
  });

  test("calls out what a stranger could pick out, and its routine", () => {
    const report = readExposure(
      [
        device({ id: 1, owner: mine, stability: "rotating" }),
        device({ id: 2, owner: mine, stability: "stable" }),
      ],
      new Map([[1, minutes(90)], [2, minutes(10)]]),
      listening,
    );
    expect(report.recognisable).toBe(1);
    expect(report.items[0]?.deviceId).toBe(2);
    expect(report.routine?.deviceId).toBe(2);
    expect(report.statement).toBe("1 of your 2 heard devices can be recognised by anyone listening.");
  });

  test("only ever covers your own devices", () => {
    const report = readExposure([device({})], new Map([[1, minutes(100)]]), listening);
    expect(report.items).toEqual([]);
    expect(report.routine).toBeNull();
  });

  test("leaves out hours this Mac wasn't listening", () => {
    const hours = routineOf(minutes(30), minutes(60));
    expect(hours.filter((share) => share !== null)).toHaveLength(new Set(minutes(60).map((m) => new Date(m * 60_000).getHours())).size);
    expect(hours.some((share) => share === null)).toBe(true);
  });
});

describe("a computer going to sleep", () => {
  const listening = minutes(300);
  const bursts = [240, 241, 256, 272, 288];

  test("spots a steady device that dropped to bursts, and how often", () => {
    expect(sleepPulse([...minutes(240), ...bursts], listening)).toBe(16);
  });

  test("leaves alone something that's still steady, or was never steady", () => {
    expect(sleepPulse(minutes(300), listening)).toBeNull();
    expect(sleepPulse(bursts, listening)).toBeNull();
  });

  test("clears as soon as it's steady again, not an hour later", () => {
    expect(sleepPulse([...minutes(240), ...bursts, 295, 296, 297, 298, 299], listening)).toBeNull();
  });

  test("needs repeated bursts, not one blip", () => {
    expect(sleepPulse([...minutes(240), 250], listening)).toBeNull();
  });

  test("needs enough listening to compare", () => {
    expect(sleepPulse(minutes(40), minutes(40))).toBeNull();
  });
});

describe("coming along", () => {
  const MIN = 60_000;
  const visit = (placeId: number, start: number, end: number): Visit => ({ placeId, start: start * MIN, end: end * MIN });
  const visits = [visit(1, 0, 100), visit(1, 200, 300), visit(2, 400, 500), visit(1, 600, 700)];

  test("a trip is a change of place", () => {
    expect(tripsOf(visits)).toHaveLength(2);
  });

  test("needs to leave and arrive with you", () => {
    const trips = tripsOf(visits);
    const leftAndArrived = [{ placeId: 1, minute: 290 }, { placeId: 2, minute: 410 }];
    expect(tripsTogether(leftAndArrived, trips)).toBe(1);
    const earlierThatDay = [{ placeId: 1, minute: 210 }, { placeId: 2, minute: 410 }];
    expect(tripsTogether(earlierThatDay, trips)).toBe(0);
    const alreadyThere = [{ placeId: 1, minute: 290 }, { placeId: 2, minute: 490 }];
    expect(tripsTogether(alreadyThere, trips)).toBe(0);
  });

  test("shows up in the finding", () => {
    const presence = [1, 2].map((placeId) => ({ placeId, firstSeen: 0, minutes: 30, bestRssi: -60, lastSeen: 0 }));
    const tag = (cameAlong: DeviceView["cameAlong"]) =>
      deriveFindings([device({ owner: null, class: "tag", presence, cameAlong })])[0]?.detail;
    expect(tag({ trips: 2, of: 3 })).toContain("It came along on 2 of 3 trips.");
    expect(tag({ trips: 0, of: 3 })).toContain("It never left or arrived");
    expect(tag(null)).not.toContain("came along");
  });
});

describe("taking back a link", () => {
  const scan = (ts: number) => ({
    t: "wifi" as const,
    ts,
    nets: [1, 2, 3].map((n) => ({ ssid: "Test", bssid: `aa:${n}`, rssi: -50, secured: true })),
  });

  function linked() {
    const db = openDb(":memory:");
    const ingest = new Ingest(db);
    ingest.wifi(scan(1_000));
    ingest.wifi(scan(2_000));
    const hear = (id: string, ts: number) => ingest.ble({ t: "ble", ts, id, rssi: -60, mfr: "4c0010020100" });
    for (const ts of [10_000, 40_000]) hear("old", ts);
    for (const ts of [45_000, 75_000]) hear("new", ts);
    ingest.linkAliases(80_000);
    for (const ts of [90_000, 120_000]) hear("newer", ts);
    const device = (id: string) =>
      (db.query("SELECT device_id AS id FROM aliases WHERE id = ?").get(id) as { id: number }).id;
    return { db, ingest, hear, device };
  }

  test("leaves a link alone while nothing contradicts it", () => {
    const { ingest, device } = linked();
    expect(device("new")).toBe(device("old"));
    expect(ingest.retractLinks()).toBe(0);
  });

  test("splits off the alias and whatever followed it, and leaves the tag behind", () => {
    const { db, ingest, hear, device } = linked();
    ingest.linkAliases(130_000);
    expect(device("newer")).toBe(device("old"));
    applyAction(db, { action: "assign", deviceId: device("old"), person: "Roommate" });

    hear("old", 200_000);
    expect(ingest.retractLinks()).toBe(1);

    expect(device("new")).not.toBe(device("old"));
    expect(device("newer")).toBe(device("new"));
    const row = (id: number) =>
      db.query("SELECT person_id AS personId, last_seen AS lastSeen FROM devices WHERE id = ?").get(id) as {
        personId: number | null;
        lastSeen: number;
      };
    expect(row(device("old")).personId).not.toBeNull();
    expect(row(device("new")).personId).toBeNull();
    expect(row(device("new")).lastSeen).toBe(120_000);
    expect(ingest.retractLinks()).toBe(0);
  });

  test("takes back a link from an address held too long to be rotating", () => {
    const { db, ingest, device } = linked();
    db.run("UPDATE aliases SET first_seen = 0, last_seen = 40000 WHERE id = 'old'");
    expect(ingest.retractLinks()).toBe(0);
    db.run("UPDATE aliases SET first_seen = -8000000 WHERE id = 'old'");
    expect(ingest.retractLinks()).toBe(1);
    expect(device("new")).not.toBe(device("old"));
  });

  test("two broken links in a row each get their own device, and no empty ones appear", () => {
    const { db, ingest, hear, device } = linked();
    ingest.linkAliases(130_000);
    hear("old", 200_000);
    hear("new", 200_000);
    expect(ingest.retractLinks()).toBe(2);

    expect(new Set([device("old"), device("new"), device("newer")]).size).toBe(3);
    const devices = db.query("SELECT id FROM devices").all() as { id: number }[];
    expect(devices).toHaveLength(3);
    const roots = db.query("SELECT COUNT(*) AS n FROM aliases WHERE predecessor_id IS NULL").get() as { n: number };
    expect(roots.n).toBe(3);
  });

  test("a late link brings along whatever already followed that alias", () => {
    const { db, ingest, device } = linked();
    db.run("UPDATE aliases SET predecessor_id = NULL, link_confidence = NULL, link_evidence = NULL WHERE id = 'new'");
    const fresh = db.query("INSERT INTO devices (first_seen, last_seen) VALUES (1, 1) RETURNING id").get() as { id: number };
    db.query("UPDATE aliases SET device_id = ? WHERE id IN ('new', 'newer')").run(fresh.id);
    db.run("UPDATE aliases SET predecessor_id = 'new' WHERE id = 'newer'");

    ingest.linkAliases(130_000);

    expect(device("new")).toBe(device("old"));
    expect(device("newer")).toBe(device("old"));
    expect(db.query("SELECT id FROM devices WHERE id = ?").get(fresh.id)).toBeNull();
  });

  test("a link in the same pass can follow a chain that just moved", () => {
    const { db, ingest, hear, device } = linked();
    db.run("UPDATE aliases SET predecessor_id = NULL, link_confidence = NULL, link_evidence = NULL WHERE id = 'new'");
    const fresh = db.query("INSERT INTO devices (first_seen, last_seen) VALUES (1, 1) RETURNING id").get() as { id: number };
    db.query("UPDATE aliases SET device_id = ? WHERE id IN ('new', 'newer')").run(fresh.id);
    db.run("UPDATE aliases SET predecessor_id = 'new' WHERE id = 'newer'");
    for (const ts of [125_000, 155_000]) hear("newest", ts);

    ingest.linkAliases(180_000);

    expect(device("newest")).toBe(device("old"));
  });

  test("a key beats an address: an alias that shows a known key joins that device", () => {
    const { db, ingest, device } = linked();
    const key = `4c001219 10${"ab".repeat(22)}0100`.replace(/ /g, "");
    const send = (id: string, ts: number, mfr: string) => ingest.ble({ t: "ble", ts, id, rssi: -60, mfr });
    send("tag", 200_000, key);
    send("other", 201_000, "4c0010020100");
    const stranded = device("other");

    send("other", 202_000, key);

    expect(device("other")).toBe(device("tag"));
    expect(db.query("SELECT id FROM devices WHERE id = ?").get(stranded)).toBeNull();
  });

  test("gives a stranger back the minutes it was credited with", () => {
    const { db, ingest, hear, device } = linked();
    hear("old", 200_000);
    ingest.retractLinks();
    const snapshot = buildSnapshot(db, false, 200_000);
    expect(snapshot.devices.find((entry) => entry.id === device("new"))?.aliasCount).toBe(1);
    expect(snapshot.devices.find((entry) => entry.id === device("old"))?.identityConfidence).toBe(1);
  });
});

describe("what's on the air", () => {
  test("keeps the type a sensor reports, and it reaches the device", () => {
    const db = openDb(":memory:");
    const ingest = new Ingest(db);
    const scan = (ts: number) => ({
      t: "wifi" as const,
      ts,
      nets: [1, 2, 3].map((n) => ({ ssid: "Test", bssid: `aa:${n}`, rssi: -50, secured: true })),
    });
    ingest.wifi(scan(1_000));
    ingest.wifi(scan(2_000));
    ingest.ble({ t: "ble", ts: 3_000, id: "tag", rssi: -60, mfr: "4c0012021001" });
    const found = buildSnapshot(db, false, 3_000).devices[0];
    expect(found?.findMyType).toBe(1);
    expect(found?.classLabel).toBe("AirTag-like device");
  });

  test("an older database gets the type back from its signatures", () => {
    const db = openDb(":memory:");
    db.run("ALTER TABLE aliases DROP COLUMN find_my_type");
    db.run("INSERT INTO devices (id, first_seen, last_seen) VALUES (1, 1, 1)");
    db.run("INSERT INTO aliases (id, device_id, signature, first_seen, last_seen) VALUES ('a', 1, '4c|12||t1', 1, 1), ('b', 1, '4c|10|', 1, 1)");
    migrate(db);
    const rows = db.query("SELECT find_my_type AS type FROM aliases ORDER BY id").all() as { type: number | null }[];
    expect(rows.map((row) => row.type)).toEqual([1, null]);
  });

  test("counts Find My addresses, and splits out what's AirTag-like", () => {
    const air = readAir([
      { findMyType: 0, findMy: "near-owner" },
      { findMyType: 1, findMy: "near-owner" },
      { findMyType: 1, findMy: "separated" },
      { findMyType: null, findMy: null },
    ]);
    expect(air).toEqual({ findMy: 3, airTagLike: { nearOwner: 1, separated: 1 } });
  });

  test("names a separated device by what it says it is", () => {
    const presence = [1, 2].map((placeId) => ({ placeId, firstSeen: 0, minutes: 30, bestRssi: -60, lastSeen: 0 }));
    const title = (findMyType: number | null) =>
      deriveFindings([device({ owner: null, class: "tag", findMy: "separated", findMyType, presence })])[0]?.title;
    expect(title(1)).toStartWith("AirTag-like device");
    expect(title(0)).toStartWith("Separated Apple device");
    expect(title(null)).toStartWith("Separated Find My device");
  });
});

describe("what just got closer", () => {
  const NOW = 1_000;
  const minute = (deviceId: number, ago: number, rssi: number) => ({ deviceId, minute: NOW - ago, rssi });

  test("finds a jump against its own recent signal", () => {
    const rows = [minute(1, 8, -75), minute(1, 5, -76), minute(1, 1, -42), minute(1, 0, -40)];
    expect(whatGotCloser(rows, NOW)).toEqual([{ deviceId: 1, rise: 35, rssi: -41 }]);
  });

  test("ignores ordinary drift, and anything that's stopped", () => {
    expect(whatGotCloser([minute(1, 5, -75), minute(1, 0, -68)], NOW)).toEqual([]);
    expect(whatGotCloser([minute(1, 8, -80), minute(1, 4, -40)], NOW)).toEqual([]);
  });

  test("keeps showing something held still, even after a rotation hid its earlier signal", () => {
    const held = [minute(1, 3, -63), minute(1, 2, -45), minute(1, 1, -42), minute(1, 0, -45)];
    expect(whatGotCloser(held, NOW)[0]?.deviceId).toBe(1);
  });

  test("a faint device that rises is still far away", () => {
    expect(whatGotCloser([minute(1, 6, -91), minute(1, 0, -74)], NOW)).toEqual([]);
  });

  test("a brand new signal only counts when it's almost touching", () => {
    expect(whatGotCloser([minute(1, 0, -52)], NOW)).toEqual([]);
    expect(whatGotCloser([minute(1, 0, -40)], NOW)).toEqual([{ deviceId: 1, rise: null, rssi: -40 }]);
  });

  test("puts the strongest first and keeps the list short", () => {
    const rows = [1, 2, 3, 4, 5, 6, 7].flatMap((id) => [minute(id, 6, -90), minute(id, 0, -40 - id)]);
    const found = whatGotCloser(rows, NOW);
    expect(found.map((entry) => entry.deviceId)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("moving with something of yours", () => {
  // A wandering signal, so there's something to match.
  const walk = Array.from({ length: 60 }, (_, index) => -55 + 12 * Math.sin(index / 5));
  const series = (values: number[]) => new Map(values.map((rssi, minute) => [minute, rssi]));
  const shifted = (by: number) => series(walk.map((rssi) => rssi + by));

  test("finds a signal tracing yours at the same strength", () => {
    const twins = findTwins(new Map([[1, series(walk)], [2, shifted(1)]]), [1]);
    expect(twins).toHaveLength(1);
    expect(twins[0]).toMatchObject({ deviceId: 2, ofDeviceId: 1, minutes: 60 });
  });

  test("the same shape from further away is something else", () => {
    expect(findTwins(new Map([[1, series(walk)], [2, shifted(-20)]]), [1])).toEqual([]);
  });

  test("a different shape at the same strength is something else", () => {
    const other = series(walk.map((_, index) => -55 + 12 * Math.cos(index / 2)));
    expect(findTwins(new Map([[1, series(walk)], [2, other]]), [1])).toEqual([]);
  });

  test("needs you to have moved, and enough time together", () => {
    const still = series(walk.map((_, index) => -55 + 0.5 * Math.sin(index)));
    expect(findTwins(new Map([[1, still], [2, still]]), [1])).toEqual([]);
    const brief = series(walk.slice(0, TWIN_MIN_MINUTES - 1));
    expect(findTwins(new Map([[1, brief], [2, brief]]), [1])).toEqual([]);
  });

  test("one extreme minute can't make a match", () => {
    const flat = (seed: number) => walk.map((_, minute) => -50 + Math.sin(minute * seed));
    const spike = (values: number[]) => series(values.map((rssi, minute) => (minute === 0 ? -72 : rssi)));
    expect(findTwins(new Map([[1, spike(flat(1.3))], [2, spike(flat(2.9))]]), [1])).toEqual([]);
  });

  test("the Mac moving doesn't make fixed signals look like twins", () => {
    // Close things shift far more than distant ones, so no single shift can be subtracted.
    const fixed = (seed: number, shift: number) =>
      series(walk.map((_, minute) => -70 + seed + 0.5 * Math.sin(minute * (seed + 1)) + (minute >= 20 && minute < 30 ? shift : 0)));
    const room = new Map(Array.from({ length: 12 }, (_, id) => [id + 10, fixed(id / 4, -8)]));
    room.set(1, fixed(0.1, -36));
    room.set(2, fixed(0.2, -36));
    expect(findTwins(room, [1])).toEqual([]);
  });

  test("still finds something moving with you while the room stays put", () => {
    const fixed = (seed: number) => series(walk.map((_, minute) => -70 + seed + Math.sin(minute * (seed + 1))));
    const room = new Map<number, ReturnType<typeof series>>(Array.from({ length: 12 }, (_, id) => [id + 10, fixed(id / 4)]));
    room.set(1, series(walk));
    room.set(2, shifted(1));
    expect(findTwins(room, [1]).map((twin) => twin.deviceId)).toEqual([2]);
  });

  test("strangers are never compared with each other", () => {
    expect(findTwins(new Map([[2, series(walk)], [3, series(walk)]]), [])).toEqual([]);
  });

  test("a tag riding along is a finding, at one place", () => {
    const twinOf = { deviceId: 9, title: "iPhone", minutes: 45 };
    const [finding] = deriveFindings([device({ owner: null, findMyType: 1, twinOf })]);
    expect(finding?.title).toBe("AirTag-like device moving with your iPhone");
    expect(finding?.severity).toBe("medium");
  });

  test("your phone's other identity isn't a finding, and shows up as exposure", () => {
    const twinOf = { deviceId: 9, title: "iPhone", minutes: 45 };
    const echo = device({ owner: null, findMyType: 0, aliasCount: 7, twinOf });
    expect(deriveFindings([echo])).toEqual([]);
    expect(readExposure([echo], new Map(), []).echoes).toEqual([{ title: "iPhone", identities: 1, addressChanges: 6 }]);
  });
});

describe("the Mac moving", () => {
  const listening = minutes(40);
  const signals = (shift: number, anchors = 10) =>
    Array.from({ length: anchors }, (_, deviceId) =>
      listening.map((minute) => ({ deviceId, minute, rssi: -70 + (minute >= 37 ? shift : 0) })),
    ).flat();

  test("spots every fixed signal shifting at once, up or down", () => {
    expect(readMoved(signals(-8), listening)).toEqual({ shift: 8, anchors: 10 });
    expect(readMoved(signals(9), listening)?.shift).toBe(9);
  });

  test("ignores ordinary drift", () => {
    expect(readMoved(signals(-3), listening)).toBeNull();
  });

  test("one device moving isn't the Mac moving", () => {
    const rows = [...signals(0, 9), ...signals(-30, 1).map((row) => ({ ...row, deviceId: 99 }))];
    expect(readMoved(rows, listening)).toBeNull();
  });

  test("needs enough anchors", () => {
    expect(readMoved(signals(-8, 7), listening)).toBeNull();
  });

  test("can't read across a sleep", () => {
    const slept = [...minutes(37), 500, 501, 502];
    const rows = signals(0).map((row) => ({ ...row, minute: row.minute >= 37 ? row.minute + 463 : row.minute, rssi: row.minute >= 37 ? -60 : -70 }));
    expect(readMoved(rows, slept)).toBeNull();
  });
});

describe("going silent together", () => {
  // Five minutes past a quarter hour, so nothing here is a rotation.
  const FROM = 900_000 * 2_000 + 300_000;
  const minute = Math.floor(FROM / 60_000);
  const listening = new Set([minute, minute + 1, minute + 2, minute + 3]);
  // Heard about every 10 seconds, like Find My.
  const signal = (over: object = {}) => ({
    deviceId: 2,
    firstSeen: FROM - 600_000,
    lastSeen: FROM + 1_000,
    bestRssi: -48,
    adverts: 60,
    ...over,
  });
  const you = [{ deviceId: 1, from: FROM }];

  test("finds a strong signal that stopped within seconds of you", () => {
    expect(leftTogether(you, [signal()], listening)).toEqual([{ deviceId: 2, ofDeviceId: 1, at: FROM }]);
  });

  test("a signal heard rarely gets a wider window, as a real bag test needed", () => {
    expect(leftTogether(you, [signal({ lastSeen: FROM - 21_000 })], listening)).toHaveLength(1);
  });

  test("a signal heard constantly has no such excuse", () => {
    const chatty = signal({ lastSeen: FROM - 21_000, firstSeen: FROM - 621_000, adverts: 600 });
    expect(leftTogether(you, [chatty], listening)).toEqual([]);
  });

  test("the window never stretches past 30 seconds", () => {
    const rare = signal({ lastSeen: FROM - 40_000, firstSeen: FROM - 640_000, adverts: 20 });
    expect(leftTogether(you, [rare], listening)).toEqual([]);
  });

  test("a signal stopping a minute off doesn't count, because that's often luck", () => {
    expect(leftTogether(you, [signal({ lastSeen: FROM + 60_000 })], listening)).toEqual([]);
  });

  test("ignores weak or barely heard signals", () => {
    expect(leftTogether(you, [signal({ bestRssi: -80 })], listening)).toEqual([]);
    expect(leftTogether(you, [signal({ adverts: 3 })], listening)).toEqual([]);
  });

  test("only something usually heard can say you left", () => {
    expect(isSteady(900, 1000)).toBe(true);
    // A WHOOP, which only broadcasts when its phone is out of reach.
    expect(isSteady(20, 1000)).toBe(false);
    expect(isSteady(0, 0)).toBe(false);
  });

  test("the Mac stopping isn't anyone leaving", () => {
    expect(leftTogether(you, [signal()], new Set([minute, minute + 1]))).toEqual([]);
  });

  test("on the quarter hour everything rotates, so nothing can be said", () => {
    const quarter = 900_000 * 2_000 + 5_000;
    expect(onTheQuarter(quarter)).toBe(true);
    const clock = Math.floor(quarter / 60_000);
    const heard = new Set([clock, clock + 1, clock + 2, clock + 3]);
    expect(leftTogether([{ deviceId: 1, from: quarter }], [signal({ lastSeen: quarter })], heard)).toEqual([]);
  });

  test("a tag that left with you is a finding, even at one place", () => {
    const leftWith = { deviceId: 1, title: "iPhone", at: FROM };
    const [finding] = deriveFindings([device({ owner: null, findMyType: 1, leftWith })]);
    expect(finding?.title).toBe("AirTag-like device went silent with your iPhone");
    expect(deriveFindings([device({ owner: null, findMyType: 0, class: "personal", leftWith })])).toEqual([]);
  });

  test("an older database keeps its silences through the change of column", () => {
    const db = openDb(":memory:");
    db.run("INSERT INTO devices (id, first_seen, last_seen) VALUES (1, 1, 1)");
    db.run("ALTER TABLE silences DROP COLUMN best_rssi");
    db.run("ALTER TABLE silences ADD COLUMN mean_rssi REAL");
    db.run("INSERT INTO silences (device_id, from_ts, to_ts, first_seen, mean_rssi, adverts) VALUES (1, 5, 6, 1, -48.5, 60)");
    migrate(db);
    expect(db.query("SELECT best_rssi AS best FROM silences").get()).toEqual({ best: -48 });
  });

  test("a stranger going quiet starts nothing, because only your devices are a reference", () => {
    const db = openDb(":memory:");
    db.run("INSERT INTO devices (id, first_seen, last_seen) VALUES (1, 1, 1), (2, 1, 1)");
    const row = "INSERT INTO silences (device_id, from_ts, to_ts, first_seen, best_rssi, adverts) VALUES (?, ?, ?, 1, -48, 60)";
    for (const id of [1, 2]) db.query(row).run(id, FROM, FROM + 400_000);
    expect(buildSnapshot(db, false, FROM + 410_000).devices.filter((entry) => entry.leftWith)).toEqual([]);
  });

  test("a phone's own Find My identity going silent with it isn't a tag on you", () => {
    const leftWith = { deviceId: 1, title: "iPhone", at: FROM };
    const phone = device({ owner: null, class: "tag", findMy: "separated", findMyType: 0, leftWith });
    expect(deriveFindings([phone]).filter((finding) => finding.id.startsWith("left"))).toEqual([]);
    const unknownTag = device({ owner: null, class: "tag", findMy: "separated", findMyType: null, leftWith });
    expect(deriveFindings([unknownTag])[0]?.title).toContain("went silent with your iPhone");
  });

  test("records when your device goes quiet, and reads it back end to end", () => {
    const db = openDb(":memory:");
    const ingest = new Ingest(db);
    const scan = (ts: number) => ({
      t: "wifi" as const,
      ts,
      nets: [1, 2, 3].map((n) => ({ ssid: "Test", bssid: `aa:${n}`, rssi: -50, secured: true })),
    });
    ingest.wifi(scan(FROM - 2_000_000));
    ingest.wifi(scan(FROM - 1_999_000));
    const hear = (id: string, ts: number) =>
      ingest.ble({ t: "ble", ts, id, rssi: -48, mfr: id === "tag" ? "4c0012021001" : "4c0010020100" });
    // Your phone is usually heard, which is what lets its silence mean something.
    for (let index = 30; index > 0; index -= 1) {
      hear("mine", FROM - index * 60_000);
      hear("tag", FROM - index * 60_000 + 1_000);
    }
    hear("mine", FROM);
    hear("tag", FROM + 1_000);
    const mine = (db.query("SELECT device_id AS id FROM aliases WHERE id = 'mine'").get() as { id: number }).id;
    applyAction(db, { action: "claim", deviceId: mine });
    for (let ts = FROM + 60_000; ts < FROM + 400_000; ts += 60_000) hear("stranger", ts);
    hear("mine", FROM + 400_000);
    // A real AirTag came back on the same address, which overwrites when it stopped.
    hear("tag", FROM + 401_000);

    const rows = db.query("SELECT from_ts AS fromTs, to_ts AS toTs FROM silences ORDER BY from_ts").all();
    expect(rows).toEqual([
      { fromTs: FROM, toTs: FROM + 400_000 },
      { fromTs: FROM + 1_000, toTs: FROM + 401_000 },
    ]);
    const tag = buildSnapshot(db, false, FROM + 410_000).devices.find((entry) => entry.findMyType === 1);
    expect(tag?.leftWith?.at).toBe(FROM);
    expect((db.query("SELECT best_rssi AS best FROM silences ORDER BY from_ts").all() as { best: number }[])[0]?.best).toBe(-48);
  });
});
