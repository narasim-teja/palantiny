import { describe, expect, test } from "bun:test";
import { applyAction, parseAction } from "../server/actions";
import { classLabel, parseAdvert, parseAppleMessages } from "../core/classify";
import { openDb, setMeta } from "../server/db";
import { deriveFindings } from "../core/findings";
import { inferLink, type AliasFacts } from "../core/inference";
import { decidePlace, placeCode } from "../core/places";
import { buildSnapshot } from "../server/snapshot";
import type { DeviceView, Finding } from "../core/types";
import { filmCaption } from "../web/src/lib/view";
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
    owner: null,
    trusted: false,
    watched: false,
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
    ids.map((placeId) => ({ placeId, minutes: 5, bestRssi: -50, lastSeen: 0 }));

  test("a separated tag at two places is the top finding", () => {
    const [first] = deriveFindings([
      device({ id: 1, presence: at(1, 2, 3) }),
      device({ id: 2, class: "tag", findMy: "separated", presence: at(1, 2) }),
    ]);
    expect(first?.severity).toBe("high");
    expect(first?.deviceId).toBe(2);
  });

  test("a tag at one place is a note, not an alarm", () => {
    const [only] = deriveFindings([device({ class: "tag", findMy: "separated", presence: at(1) })]);
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
    const presence = [...at(1), { placeId: 2, minutes: 1, bestRssi: -80, lastSeen: 0 }];
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
