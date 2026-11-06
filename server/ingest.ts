import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { mergeClass, parseAdvert } from "@core/classify";
import type { BleEvent, WifiEvent } from "@core/events";
import { getMeta, setMeta } from "./db";
import { inferLink, HANDOVER_WINDOW_MS, type AliasFacts } from "@core/inference";
import { decidePlace, placeCode, type PlaceFingerprint } from "@core/places";
import type { DeviceClass } from "@core/types";

const RETENTION_MS = 30 * 24 * 3_600_000;
const BANDS: Record<number, string> = { 1: "2.4 GHz", 2: "5 GHz", 3: "6 GHz" };

export class Ingest {
  private salt: string;
  private placeId: number | null;
  private pending: Set<string> | null = null;

  constructor(private db: Database) {
    let salt = getMeta(db, "salt");
    if (!salt) {
      salt = randomBytes(16).toString("hex");
      setMeta(db, "salt", salt);
    }
    this.salt = salt;
    // Start unplaced: the Mac may have moved while the server was off.
    this.placeId = null;
    setMeta(db, "current_place", "0");
  }

  /** BSSIDs can be geolocated, so only a salted hash is ever stored. */
  private hash(value: string): string {
    return createHash("sha256").update(this.salt).update(value).digest("hex").slice(0, 24);
  }

  private fingerprints(): PlaceFingerprint[] {
    const rows = this.db
      .query(
        `SELECT ns.place_id AS placeId, n.bssid_hash AS hash
         FROM network_sightings ns JOIN networks n ON n.id = ns.network_id`,
      )
      .all() as { placeId: number; hash: string }[];
    const byPlace = new Map<number, Set<string>>();
    for (const row of rows) {
      const set = byPlace.get(row.placeId) ?? new Set<string>();
      set.add(row.hash);
      byPlace.set(row.placeId, set);
    }
    return [...byPlace].map(([id, networks]) => ({ id, networks }));
  }

  private createPlace(ts: number): number {
    const count = (this.db.query("SELECT COUNT(*) AS n FROM places").get() as { n: number }).n;
    const row = this.db
      .query("INSERT INTO places (code, first_seen, last_seen) VALUES (?, ?, ?) RETURNING id")
      .get(placeCode(count), ts, ts) as { id: number };
    return row.id;
  }

  wifi(event: WifiEvent): void {
    const nets = event.nets.filter((net) => net.bssid);
    const hashed = nets.map((net) => ({ net, hash: this.hash(net.bssid!) }));
    const scan = new Set(hashed.map((entry) => entry.hash));
    const decision = decidePlace(scan, this.fingerprints(), this.pending);

    if (decision.kind === "hold") return;
    if (decision.kind === "pending") {
      this.pending = decision.pending;
      // With no known place yet there is nothing to hold on to, so wait for scan two.
      return;
    }

    this.pending = null;
    const placeId = decision.kind === "known" ? decision.placeId : this.createPlace(event.ts);
    this.placeId = placeId;
    setMeta(this.db, "current_place", String(placeId));
    this.db.query("UPDATE places SET last_seen = ? WHERE id = ?").run(event.ts, placeId);

    const insertNetwork = this.db.query(
      `INSERT INTO networks (bssid_hash, ssid, band, secured) VALUES (?, ?, ?, ?)
       ON CONFLICT(bssid_hash) DO UPDATE SET ssid = COALESCE(excluded.ssid, ssid)
       RETURNING id`,
    );
    const recordNetwork = this.db.query(
      `INSERT INTO network_sightings (network_id, place_id, first_seen, last_seen, best_rssi)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(network_id, place_id) DO UPDATE SET
         last_seen = excluded.last_seen,
         best_rssi = MAX(best_rssi, excluded.best_rssi)`,
    );
    this.db.transaction(() => {
      for (const { net, hash } of hashed) {
        const band = net.band === undefined ? null : (BANDS[net.band] ?? null);
        const row = insertNetwork.get(hash, net.ssid ?? null, band, net.secured ? 1 : 0) as { id: number };
        recordNetwork.run(row.id, placeId, event.ts, event.ts, net.rssi);
      }
    })();
  }

  ble(event: BleEvent): void {
    // Until the first place is recognised there is nowhere to file a sighting.
    if (this.placeId === null) return;

    const facts = parseAdvert({ mfr: event.mfr, svc: event.svc });
    const tagKey = facts.findMyKey ? this.hash(facts.findMyKey) : null;
    const known = this.db
      .query("SELECT device_id AS deviceId FROM aliases WHERE id = ?")
      .get(event.id) as { deviceId: number } | null;

    let deviceId: number;
    if (known) {
      deviceId = known.deviceId;
    } else {
      const byKey = tagKey
        ? (this.db.query("SELECT id FROM devices WHERE tag_key = ?").get(tagKey) as { id: number } | null)
        : null;
      const byName = !byKey && event.name
        ? (this.db
            .query("SELECT id FROM devices WHERE paired = 1 AND name = ?")
            .get(event.name) as { id: number } | null)
        : null;
      deviceId =
        byKey?.id ??
        byName?.id ??
        (
          this.db
            .query("INSERT INTO devices (class, first_seen, last_seen) VALUES ('unknown', ?, ?) RETURNING id")
            .get(event.ts, event.ts) as { id: number }
        ).id;
      this.db
        .query(
          `INSERT INTO aliases (id, device_id, place_id, signature, first_seen, last_seen)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(event.id, deviceId, this.placeId, facts.signature, event.ts, event.ts);
    }

    const current = this.db
      .query("SELECT class, find_my AS findMy FROM devices WHERE id = ?")
      .get(deviceId) as { class: DeviceClass; findMy: string | null };
    const nextClass = mergeClass(current.class, facts.class);
    const findMy = current.findMy === "separated" ? "separated" : (facts.findMy ?? current.findMy);

    this.db
      .query(
        `UPDATE devices SET class = ?, find_my = ?, vendor = COALESCE(vendor, ?),
           name = COALESCE(?, name), tag_key = COALESCE(tag_key, ?), last_seen = ?
         WHERE id = ?`,
      )
      .run(nextClass, findMy, facts.vendor, event.name ?? null, tagKey, event.ts, deviceId);

    this.db
      .query(
        `UPDATE aliases SET last_seen = ?, signature = ?, rssi_sum = rssi_sum + ?, rssi_n = rssi_n + 1
         WHERE id = ?`,
      )
      .run(event.ts, facts.signature, event.rssi, event.id);

    this.db
      .query(
        `INSERT INTO sightings (alias_id, place_id, minute, n, rssi_sum, rssi_max)
         VALUES (?, ?, ?, 1, ?, ?)
         ON CONFLICT(alias_id, place_id, minute) DO UPDATE SET
           n = n + 1, rssi_sum = rssi_sum + excluded.rssi_sum,
           rssi_max = MAX(rssi_max, excluded.rssi_max)`,
      )
      .run(event.id, this.placeId, Math.floor(event.ts / 60_000), event.rssi, event.rssi);
  }

  /** Links new aliases to the alias they most likely rotated from. */
  linkAliases(now: number): number {
    const rows = this.db
      .query(
        `SELECT a.id, a.device_id AS deviceId, a.place_id AS placeId, a.signature,
                a.first_seen AS firstSeen, a.last_seen AS lastSeen,
                CASE WHEN a.rssi_n > 0 THEN a.rssi_sum * 1.0 / a.rssi_n ELSE -100 END AS meanRssi,
                a.predecessor_id AS predecessorId,
                EXISTS (SELECT 1 FROM aliases b WHERE b.predecessor_id = a.id) AS hasSuccessor,
                d.tag_key AS tagKey, d.paired AS paired
         FROM aliases a JOIN devices d ON d.id = a.device_id
         WHERE a.last_seen > ?`,
      )
      .all(now - 3 * HANDOVER_WINDOW_MS - 3_600_000) as (Omit<AliasFacts, "hasSuccessor"> & {
      hasSuccessor: number;
      predecessorId: string | null;
      tagKey: string | null;
      paired: number;
    })[];

    const facts: AliasFacts[] = rows.map((row) => ({ ...row, hasSuccessor: row.hasSuccessor === 1 }));
    let linked = 0;

    for (const [index, row] of rows.entries()) {
      // Tags and paired devices already have a firm identity, and a settled link stays.
      if (row.predecessorId || row.tagKey || row.paired) continue;
      // Wait until the alias has been heard enough to judge its signal strength.
      if (now - row.firstSeen < 20_000) continue;
      const alias = facts[index]!;
      const link = inferLink(alias, facts);
      if (!link) continue;

      this.db.transaction(() => {
        this.db
          .query(
            `UPDATE aliases SET device_id = ?, predecessor_id = ?, link_confidence = ?, link_evidence = ?
             WHERE id = ?`,
          )
          .run(link.deviceId, link.predecessorId, link.confidence, link.evidence, link.aliasId);
        const orphan = this.db
          .query("SELECT COUNT(*) AS n FROM aliases WHERE device_id = ?")
          .get(alias.deviceId) as { n: number };
        if (orphan.n === 0) this.db.query("DELETE FROM devices WHERE id = ?").run(alias.deviceId);
      })();

      const predecessor = facts.find((candidate) => candidate.id === link.predecessorId);
      if (predecessor) predecessor.hasSuccessor = true;
      alias.deviceId = link.deviceId;
      linked += 1;
    }
    return linked;
  }

  /** Strangers' sightings expire. Devices you claimed, trust or watch are kept. */
  prune(now: number): void {
    const cutoff = Math.floor((now - RETENTION_MS) / 60_000);
    this.db.transaction(() => {
      this.db
        .query(
          `DELETE FROM sightings WHERE minute < ? AND alias_id IN (
             SELECT a.id FROM aliases a JOIN devices d ON d.id = a.device_id
             WHERE d.person_id IS NULL AND d.trusted = 0 AND d.watched = 0)`,
        )
        .run(cutoff);
      this.db.run(
        `DELETE FROM aliases WHERE NOT EXISTS (SELECT 1 FROM sightings s WHERE s.alias_id = aliases.id)
         AND device_id IN (SELECT id FROM devices WHERE person_id IS NULL AND trusted = 0 AND watched = 0)`,
      );
      this.db.run(
        `DELETE FROM devices WHERE person_id IS NULL AND trusted = 0 AND watched = 0 AND paired = 0
         AND NOT EXISTS (SELECT 1 FROM aliases a WHERE a.device_id = devices.id)`,
      );
    })();
  }
}
