import { describe, expect, test } from "bun:test";
import { applyAction, parseAction } from "../server/actions";
import { classLabel, parseAdvert, parseAppleMessages } from "../core/classify";
import { openDb, setMeta } from "../server/db";
import { deriveFindings } from "../core/findings";
import { inferLink, type AliasFacts } from "../core/inference";
import { decidePlace, placeCode } from "../core/places";
import { buildSnapshot } from "../server/snapshot";
import type { DeviceView, Finding } from "../core/types";
import { callsign } from "../core/callsign";
import { lastReturn } from "../core/presence";
import { unseen } from "../server/alerts";
import { isDistinctiveName, recognise } from "../core/recognise";
import { applyOptimistic } from "../web/src/lib/optimistic";
import { filmCaption, placeSummary } from "../web/src/lib/view";
import { Ingest } from "../server/ingest";

const LONG = `4c0012 19 10${"ab".repeat(22)}0100`.replace(/ /g, "");

describe("advert parsing", () => {
  test("walks Apple message runs", () => {
    expect(parseAppleMessages([0x10, 1, 9, 0x0c, 2, 1, 2]).map((m) => m.type)).toEqual([0x10, 0x0c]);
  });

  test("survives truncated payloads", () => {
    expect(() => parseAppleMessages([0x10, 200, 1])).not.toThrow();
    expect(parseAdvert({ mfr: "4c" }).company).toBeNull();
    expect(parseAdvert({ mfr: "zz00" }).company).toBeNull();
  });

  test("reads the long Find My form as separated, with key material", () => {
    const facts = parseAdvert({ mfr: LONG });
    expect(facts.findMy).toBe("separated");
    expect(facts.class).toBe("tag");
    expect(facts.findMyKey).toBe("ab".repeat(22));
  });

  test("reads the short Find My form as near owner, and not as a tracker", () => {
    const facts = parseAdvert({ mfr: "4c0012020001" });
    expect(facts.findMy).toBe("near-owner");
    expect(facts.class).toBe("personal");
    expect(classLabel(facts.class, facts.findMy)).toBe("Find My device, near owner");
  });

  test("uses service hints for other trackers", () => {
    expect(parseAdvert({ svc: ["fd5a"] }).class).toBe("tag");
    expect(parseAdvert({ svc: ["fd5a"] }).vendor).toBe("Samsung");
  });
});

describe("places", () => {
  const home = { id: 1, networks: new Set(["a", "b", "c", "d"]) };

  test("recognises a known place from a partial scan", () => {
    expect(decidePlace(new Set(["a", "b", "z"]), [home], null)).toEqual({ kind: "known", placeId: 1 });
  });

  test("needs two agreeing scans before creating a place", () => {
    const first = decidePlace(new Set(["x", "y"]), [home], null);
    expect(first.kind).toBe("pending");
    const pending = first.kind === "pending" ? first.pending : null;
    expect(decidePlace(new Set(["x", "y"]), [home], pending).kind).toBe("new");
  });

  test("a passing network does not confirm a pending place", () => {
    expect(decidePlace(new Set(["q"]), [home], new Set(["x", "y"])).kind).toBe("pending");
  });

  test("an empty scan changes nothing", () => {
    expect(decidePlace(new Set(), [home], null).kind).toBe("hold");
  });

  test("codes keep going past the alphabet", () => {
    expect(placeCode(0)).toBe("PLACE-A");
    expect(placeCode(26)).toBe("PLACE-A2");
  });
});

describe("alias linking", () => {
  const alias = (over: Partial<AliasFacts>): AliasFacts => ({
    id: "new",
    deviceId: 2,
    placeId: 1,
    signature: "4c|10|",
    firstSeen: 100_000,
    lastSeen: 160_000,
    meanRssi: -60,
    hasSuccessor: false,
    ...over,
  });
  const old = (over: Partial<AliasFacts> = {}) =>
    alias({ id: "old", deviceId: 1, firstSeen: 0, lastSeen: 95_000, ...over });

  test("links a clean handover and records evidence", () => {
    const link = inferLink(alias({}), [old()]);
    expect(link?.deviceId).toBe(1);
    expect(link?.confidence).toBeCloseTo(0.9);
    expect(link?.evidence).toContain("5s");
  });

  test("refuses to guess between two candidates", () => {
    expect(inferLink(alias({}), [old(), old({ id: "old2", deviceId: 3 })])).toBeNull();
  });

  test("refuses overlapping aliases, since one device uses one address at a time", () => {
    expect(inferLink(alias({}), [old({ lastSeen: 150_000 })])).toBeNull();
  });

  test("refuses other places, signatures and distant signals", () => {
    expect(inferLink(alias({}), [old({ placeId: 2 })])).toBeNull();
    expect(inferLink(alias({}), [old({ signature: "4c|7|" })])).toBeNull();
    expect(inferLink(alias({}), [old({ meanRssi: -80 })])).toBeNull();
  });

  test("never gives a predecessor two successors", () => {
    expect(inferLink(alias({}), [old({ hasSuccessor: true })])).toBeNull();
  });

  test("a weak match keeps low confidence", () => {
    const link = inferLink(alias({}), [old({ lastSeen: 70_000, meanRssi: -66 })]);
    expect(link?.confidence).toBeCloseTo(0.55);
  });
});

describe("findings", () => {
  const device = (over: Partial<DeviceView>): DeviceView => ({
    id: 1,
    code: "DEV-0001",
    class: "personal",
    classLabel: "Phone, tablet or computer",
    vendor: "Apple",
    findMy: null,
    name: null,
    hasName: false,
    label: null,
    owner: null,
    stability: "new",
    trusted: false,
    watched: false,
    watchedAt: null,
    back: null,
    paired: false,
    firstSeen: 0,
    lastSeen: 0,
    aliasCount: 1,
    identityConfidence: 1,
    presence: [],
    live: false,
    ...over,
  });
  const at = (...ids: number[]) =>
    ids.map((placeId) => ({ placeId, firstSeen: 0, minutes: 5, bestRssi: -50, lastSeen: 0 }));

  test("a separated tag at two places is the top finding", () => {
    const [first] = deriveFindings([
      device({ id: 1, presence: at(1, 2, 3) }),
      device({ id: 2, class: "tag", findMy: "separated", presence: at(1, 2) }),
    ]);
    expect(first?.severity).toBe("high");
    expect(first?.deviceId).toBe(2);
  });

  test("a tag at one place is a note, not an alarm", () => {
    const [only] = deriveFindings([device({ class: "tag", findMy: "separated", live: true, presence: at(1) })]);
    expect(only?.severity).toBe("note");
    expect(only?.detail).toContain("not evidence");
  });

  test("your own and trusted devices never raise findings", () => {
    const presence = at(1, 2);
    expect(
      deriveFindings([
        device({ presence, owner: { code: "YOU", label: "You", self: true } }),
        device({ id: 2, presence, trusted: true }),
      ]),
    ).toEqual([]);
  });

  test("a brief pass does not count as being at a place", () => {
    const presence = [...at(1), { placeId: 2, firstSeen: 0, minutes: 1, bestRssi: -80, lastSeen: 0 }];
    expect(deriveFindings([device({ presence })])).toEqual([]);
  });

  test("inferred identity is reported as inferred", () => {
    const [only] = deriveFindings([
      device({ presence: at(1, 2), identityConfidence: 0.6, aliasCount: 4 }),
    ]);
    expect(only?.observed).toBe(false);
    expect(only?.detail).toContain("inferred");
  });
});

describe("ingest and snapshot", () => {
  const scan = (ts: number, prefix: string) => ({
    t: "wifi" as const,
    ts,
    nets: [1, 2, 3].map((n) => ({
      ssid: `${prefix} Family Wifi`,
      bssid: `${prefix}:${n}`,
      rssi: -50,
      secured: true,
    })),
  });

  function seeded() {
    const db = openDb(":memory:");
    const ingest = new Ingest(db);
    ingest.wifi(scan(1_000, "aa"));
    ingest.wifi(scan(2_000, "aa"));
    return { db, ingest };
  }

  test("drops Bluetooth events until a place is known", () => {
    const db = openDb(":memory:");
    new Ingest(db).ble({ t: "ble", ts: 1, id: "X", rssi: -40 });
    expect(buildSnapshot(db, false).totals.aliases).toBe(0);
  });

  test("stores BSSIDs only as hashes", () => {
    const { db } = seeded();
    const rows = db.query("SELECT bssid_hash AS h FROM networks").all() as { h: string }[];
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => !row.h.includes(":"))).toBe(true);
  });

  test("screenshot mode keeps names out of the payload entirely", () => {
    const { db, ingest } = seeded();
    ingest.ble({ t: "ble", ts: 3_000, id: "X", rssi: -40, name: "Priya's iPhone", mfr: "4c0010020100" });
    const safe = JSON.stringify(buildSnapshot(db, false));
    expect(safe).not.toContain("Priya");
    expect(safe).not.toContain("Family Wifi");
    const revealed = JSON.stringify(buildSnapshot(db, true));
    expect(revealed).toContain("Priya");
    expect(revealed).toContain("Family Wifi");
  });

  test("a separated tag keeps one identity across aliases and places", () => {
    const { db, ingest } = seeded();
    ingest.ble({ t: "ble", ts: 3_000, id: "A", rssi: -40, mfr: LONG });
    ingest.wifi(scan(4_000, "bb"));
    ingest.wifi(scan(5_000, "bb"));
    ingest.ble({ t: "ble", ts: 6_000, id: "B", rssi: -40, mfr: LONG });
    const snapshot = buildSnapshot(db, false);
    expect(snapshot.devices).toHaveLength(1);
    expect(snapshot.devices[0]?.aliasCount).toBe(2);
    expect(snapshot.devices[0]?.presence).toHaveLength(2);
    expect(snapshot.places).toHaveLength(2);
  });

  test("linking merges rotated aliases and removes the empty device", () => {
    const { db, ingest } = seeded();
    const mfr = "4c0010020100";
    ingest.ble({ t: "ble", ts: 10_000, id: "A", rssi: -50, mfr });
    ingest.ble({ t: "ble", ts: 100_000, id: "A", rssi: -50, mfr });
    ingest.ble({ t: "ble", ts: 104_000, id: "B", rssi: -51, mfr });
    ingest.ble({ t: "ble", ts: 130_000, id: "B", rssi: -51, mfr });
    expect(ingest.linkAliases(140_000)).toBe(1);
    const { devices } = buildSnapshot(db, false, 140_000);
    expect(devices).toHaveLength(1);
    expect(devices[0]?.aliasCount).toBe(2);
    expect(devices[0]?.identityConfidence).toBeCloseTo(0.9);
  });

  test("retention removes strangers but keeps claimed devices", () => {
    const { db, ingest } = seeded();
    ingest.ble({ t: "ble", ts: 3_000, id: "S", rssi: -40, mfr: "4c0010020100" });
    ingest.ble({ t: "ble", ts: 3_000, id: "M", rssi: -40, mfr: "4c00070100" });
    const mine = db.query("SELECT device_id AS id FROM aliases WHERE id = 'M'").get() as { id: number };
    applyAction(db, { action: "claim", deviceId: mine.id });
    ingest.prune(3_000 + 31 * 24 * 3_600_000);
    const left = db.query("SELECT id FROM aliases").all() as { id: string }[];
    expect(left.map((row) => row.id)).toEqual(["M"]);
  });

  test("reports the sensor as offline without a heartbeat", () => {
    const { db } = seeded();
    expect(buildSnapshot(db, false).status.sensor).toBe("offline");
    setMeta(db, "heartbeat", String(Date.now()));
    expect(buildSnapshot(db, false).status.sensor).toBe("live");
  });
});

describe("actions", () => {
  test("rejects malformed requests", () => {
    expect(parseAction(null)).toBeNull();
    expect(parseAction({ action: "drop-tables", deviceId: 1 })).toBeNull();
    expect(parseAction({ action: "claim", deviceId: "1" })).toBeNull();
    expect(parseAction({ action: "rename-place", placeId: 1 })).toBeNull();
  });

  test("accepts valid requests", () => {
    expect(parseAction({ action: "watch", deviceId: 3 })).toEqual({ action: "watch", deviceId: 3 });
  });
});

describe("console copy", () => {
  const place = { id: 1, code: "PLACE-A", label: null, firstSeen: 0, lastSeen: 0, networkCount: 3, deviceCount: 92, current: true };

  test("the film caption states only what was observed", () => {
    const urgent: Finding = { id: "f", severity: "high", deviceId: 1, deviceCode: "DEV-0001", title: "Tag seen at 2 places", detail: "", placeIds: [1], confidence: 1, observed: true };
    const tag = { findMy: "separated", live: true } as DeviceView;
    const gone = { findMy: "separated", live: false } as DeviceView;
    expect(filmCaption(place, [], [])).toEqual(["0 devices in range at PLACE-A."]);
    expect(filmCaption({ ...place, label: "Home" }, [], [tag, gone])).toEqual([
      "1 device in range at Home.",
      "1 Find My device separated from its owner.",
    ]);
    expect(filmCaption(place, [], [tag, tag])[1]).toBe("2 Find My devices separated from their owners.");
    expect(filmCaption(place, [urgent], [tag])[1]).toBe("Tag seen at 2 places.");
    expect(filmCaption(undefined, [urgent], [tag])).toEqual([]);
  });
});

describe("separated devices at one place", () => {
  const tag = (minutes: number, live: boolean) =>
    ({
      id: 1,
      code: "DEV-0001",
      class: "tag",
      classLabel: "Find My device, separated from owner",
      findMy: "separated",
      owner: null,
      trusted: false,
      aliasCount: 1,
      identityConfidence: 1,
      live,
      presence: [{ placeId: 1, firstSeen: 0, minutes, bestRssi: -80, lastSeen: 0 }],
    }) as unknown as DeviceView;

  test("earn a note while in range", () => {
    expect(deriveFindings([tag(5, true)])[0]?.severity).toBe("note");
  });

  test("earn a note if they lingered, even after leaving", () => {
    expect(deriveFindings([tag(60, false)])[0]?.severity).toBe("note");
  });

  test("are forgotten if they only passed by", () => {
    expect(deriveFindings([tag(59, false)])).toEqual([]);
  });
});

describe("place summary", () => {
  const place = { id: 1, code: "PLACE-A", label: null, firstSeen: 0, lastSeen: 0, networkCount: 3, deviceCount: 4901, current: true };

  test("leads with what's in range, never the running total", () => {
    expect(placeSummary(place, 60)).toBe("60 in range, 3 networks");
    expect(placeSummary({ ...place, current: false, networkCount: 1 }, 60)).toBe("1 network");
  });
});

describe("callsigns", () => {
  test("are fixed and don't repeat within a cycle", () => {
    expect(callsign(42)).toBe(callsign(42));
    const seen = new Set(Array.from({ length: 16_384 }, (_, id) => callsign(id)));
    expect(seen.size).toBe(16_384);
  });

  test("stay unique after the word pairs run out", () => {
    expect(callsign(16_384)).not.toBe(callsign(0));
  });
});

describe("recognising broadcast names", () => {
  test("keeps the type and drops the serial", () => {
    expect(recognise("WHOOP 5A00000000")).toEqual({ kind: "WHOOP band", class: "wearable" });
    expect(recognise("Galaxy Watch Ultra (ABCD)")?.kind).toBe("Galaxy Watch");
    expect(recognise('55" Crystal UHD')?.kind).toBe("TV");
    expect(recognise("mystery")).toBeNull();
    expect(recognise(null)).toBeNull();
  });

  test("only trusts names that point at one physical device", () => {
    expect(isDistinctiveName("Galaxy Watch Ultra (ABCD)")).toBe(true);
    expect(isDistinctiveName("WHOOP 5A00000000")).toBe(true);
    expect(isDistinctiveName("LE-Bose QC35 II")).toBe(false);
    expect(isDistinctiveName("Google Fitbit Air")).toBe(false);
    expect(isDistinctiveName("4")).toBe(false);
  });
});

describe("merging by name", () => {
  test("joins a rotating gadget's records and keeps your claim", () => {
    const db = openDb(":memory:");
    const ingest = new Ingest(db);
    db.run("INSERT INTO places (id, code, first_seen, last_seen) VALUES (1, 'PLACE-A', 1, 1)");
    const name = "Galaxy Watch Ultra (ABCD)";
    db.query("INSERT INTO devices (id, class, name, first_seen, last_seen) VALUES (1, 'unknown', ?, 10, 20)").run(name);
    db.query("INSERT INTO devices (id, class, name, person_id, first_seen, last_seen) VALUES (2, 'unknown', ?, 1, 5, 30)").run(name);
    db.run("INSERT INTO devices (id, class, name, first_seen, last_seen) VALUES (3, 'unknown', 'LE-Bose QC35 II', 1, 1)");
    db.run("INSERT INTO devices (id, class, name, first_seen, last_seen) VALUES (4, 'unknown', 'LE-Bose QC35 II', 1, 1)");
    for (const [alias, device] of [["a", 1], ["b", 2]] as const) {
      db.query("INSERT INTO aliases (id, device_id, place_id, signature, first_seen, last_seen) VALUES (?, ?, 1, 's', 1, 1)").run(alias, device);
    }

    expect(ingest.mergeByName()).toBe(1);
    const rows = db.query("SELECT id, person_id AS personId, first_seen AS firstSeen, last_seen AS lastSeen FROM devices WHERE name = ?").all(name);
    expect(rows).toEqual([{ id: 2, personId: 1, firstSeen: 5, lastSeen: 30 }]);
    expect(db.query("SELECT COUNT(*) AS n FROM aliases WHERE device_id = 2").get()).toEqual({ n: 2 });
    expect(db.query("SELECT COUNT(*) AS n FROM devices WHERE name = 'LE-Bose QC35 II'").get()).toEqual({ n: 2 });
  });
});

describe("optimistic updates", () => {
  const snapshot = {
    places: [],
    devices: [{ id: 1, owner: null, label: null, trusted: false, watched: false }],
  } as unknown as Parameters<typeof applyOptimistic>[0];

  test("show the result of an action straight away", () => {
    expect(applyOptimistic(snapshot, { action: "claim", deviceId: 1 }).devices[0]?.owner?.self).toBe(true);
    expect(applyOptimistic(snapshot, { action: "assign", deviceId: 1, person: " Sam " }).devices[0]?.owner?.label).toBe("Sam");
    expect(applyOptimistic(snapshot, { action: "trust", deviceId: 1 }).devices[0]?.trusted).toBe(true);
  });

  test("leave other devices alone", () => {
    expect(applyOptimistic(snapshot, { action: "claim", deviceId: 2 }).devices[0]?.owner).toBeNull();
  });
});

describe("watching a device", () => {
  const watched = (over: Partial<DeviceView>) =>
    ({
      id: 7,
      code: "Copper Heron",
      class: "wearable",
      classLabel: "WHOOP band",
      label: null,
      owner: null,
      trusted: false,
      watched: true,
      watchedAt: 1_000,
      back: null,
      aliasCount: 1,
      identityConfidence: 1,
      live: true,
      presence: [],
      ...over,
    }) as unknown as DeviceView;
  const at = (placeId: number, firstSeen: number, minutes = 5) => ({ placeId, firstSeen, minutes, bestRssi: -70, lastSeen: 0 });

  test("is serious when a stranger turns up somewhere new", () => {
    const [finding] = deriveFindings([watched({ presence: [at(1, 0), at(2, 2_000)] })]);
    expect(finding?.id).toBe("watch-place-7-2");
    expect(finding?.severity).toBe("high");
    expect(finding?.title).toBe("Copper Heron turned up at a new place");
  });

  test("is only worth a review for someone you know", () => {
    const owner = { code: "P", label: "Roommate", self: false };
    const [finding] = deriveFindings([watched({ owner, presence: [at(1, 2_000)] })]);
    expect(finding?.severity).toBe("medium");
  });

  test("ignores places it was already at, and passing blips", () => {
    expect(deriveFindings([watched({ presence: [at(1, 0)] })])).toEqual([]);
    expect(deriveFindings([watched({ presence: [at(2, 2_000, 1)] })])).toEqual([]);
  });

  test("mentions a long absence ending", () => {
    const [finding] = deriveFindings([watched({ back: { after: 180, at: 5_000 } })]);
    expect(finding?.severity).toBe("note");
    expect(finding?.title).toBe("Copper Heron is back after 3 hours");
  });

  test("stays quiet for your own and trusted devices", () => {
    const owner = { code: "YOU", label: "You", self: true };
    expect(deriveFindings([watched({ owner, presence: [at(2, 2_000)] })])).toEqual([]);
    expect(deriveFindings([watched({ trusted: true, presence: [at(2, 2_000)] })])).toEqual([]);
  });
});

describe("absence", () => {
  const listening = Array.from({ length: 400 }, (_, minute) => minute);

  test("is measured in minutes the Mac was listening", () => {
    expect(lastReturn([0, 300], listening, 305)).toEqual({ after: 299, at: 300 });
  });

  test("doesn't count the Mac being asleep", () => {
    // Heard either side of a night with the lid closed, with no listening in between.
    expect(lastReturn([10, 900], [8, 9, 10, 900, 901], 901)).toBeNull();
  });

  test("ignores short gaps and old returns", () => {
    expect(lastReturn([0, 60], listening, 60)).toBeNull();
    expect(lastReturn([0, 300], listening, 399)).toBeNull();
  });
});

describe("alerts", () => {
  const finding = (id: string, severity: Finding["severity"]) =>
    ({ id, severity, deviceId: 1, deviceCode: "C", title: "t", detail: "", placeIds: [], confidence: 1, observed: true }) as Finding;

  test("interrupt only for serious or watched findings, once each", () => {
    const list = [finding("tag-multi-1", "high"), finding("watch-back-2-9", "note"), finding("tag-single-3", "note")];
    expect(unseen(list, new Set()).map((f) => f.id)).toEqual(["tag-multi-1", "watch-back-2-9"]);
    expect(unseen(list, new Set(["tag-multi-1"])).map((f) => f.id)).toEqual(["watch-back-2-9"]);
  });
});
