import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { mergeClass, parseAdvert } from "@core/classify";
import { isDistinctiveName } from "@core/recognise";
import type { BleEvent, WifiEvent } from "@core/events";
import { getMeta, setMeta } from "./db";
import { inferLink, refuted, HANDOVER_WINDOW_MS, type AliasFacts } from "@core/inference";
import { decidePlace, placeCode, type PlaceFingerprint } from "@core/places";
import { SILENCE_MIN_MS } from "@core/together";
import type { DeviceClass } from "@core/types";

// A distinctive name is strong evidence, but it's still a guess, so it reads as inferred.
const NAME_LINK_CONFIDENCE = 0.85;
const NAME_LINK_EVIDENCE = "Same distinctive broadcast name";

const RETENTION_MS = 30 * 24 * 3_600_000;
const BANDS: Record<number, string> = { 1: "2.4 GHz", 2: "5 GHz", 3: "6 GHz" };

interface HeardAlias {
  id: string;
  deviceId: number;
  firstSeen: number;
  lastSeen: number;
  adverts: number;
}

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
      .query(
        `SELECT id, device_id AS deviceId, first_seen AS firstSeen, last_seen AS lastSeen, rssi_n AS adverts
         FROM aliases WHERE id = ?`,
      )
      .get(event.id) as HeardAlias | null;
    if (known && event.ts - known.lastSeen >= SILENCE_MIN_MS) this.recordSilence(known, event.ts);
    const byKey = tagKey
      ? (this.db.query("SELECT id FROM devices WHERE tag_key = ?").get(tagKey) as { id: number } | null)
      : null;

    let deviceId: number;
    if (known) {
      deviceId = known.deviceId;
      if (byKey && byKey.id !== deviceId) {
        this.joinKeyedDevice(event.id, deviceId, byKey.id);
        deviceId = byKey.id;
      }
    } else {
      const distinctive = event.name ? isDistinctiveName(event.name) : false;
      const byName = !byKey && event.name
        ? (this.db
            .query("SELECT id FROM devices WHERE name = ? AND (paired = 1 OR ?) ORDER BY paired DESC, id LIMIT 1")
            .get(event.name, distinctive ? 1 : 0) as { id: number } | null)
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
        `UPDATE aliases SET last_seen = ?, signature = ?, find_my_type = COALESCE(?, find_my_type),
           rssi_sum = rssi_sum + ?, rssi_n = rssi_n + 1
         WHERE id = ?`,
      )
      .run(event.ts, facts.signature, facts.findMyType, event.rssi, event.id);

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

  /**
   * Gadgets that rotate their address but keep a serial in their name would otherwise
   * become a new device each time. This also works across places, which timing can't.
   */
  mergeByName(): number {
    const groups = this.db
      .query("SELECT name FROM devices WHERE name IS NOT NULL GROUP BY name HAVING COUNT(*) > 1")
      .all() as { name: string }[];
    let merged = 0;

    for (const { name } of groups) {
      if (!isDistinctiveName(name)) continue;
      const rows = this.db
        .query(
          `SELECT id, class, find_my AS findMy, tag_key AS tagKey, person_id AS personId, label,
                  trusted, watched, first_seen AS firstSeen, last_seen AS lastSeen
           FROM devices WHERE name = ?
           ORDER BY paired DESC, person_id IS NOT NULL DESC, id`,
        )
        .all(name) as {
        id: number;
        class: DeviceClass;
        findMy: string | null;
        tagKey: string | null;
        personId: number | null;
        label: string | null;
        trusted: number;
        watched: number;
        firstSeen: number;
        lastSeen: number;
      }[];
      const [keeper, ...others] = rows;
      if (!keeper) continue;

      this.db.transaction(() => {
        for (const other of others) {
          this.db
            .query(
              `UPDATE aliases SET device_id = ?,
                 link_confidence = COALESCE(link_confidence, ?),
                 link_evidence = COALESCE(link_evidence, ?)
               WHERE device_id = ?`,
            )
            .run(keeper.id, NAME_LINK_CONFIDENCE, NAME_LINK_EVIDENCE, other.id);
          this.db.query("DELETE FROM devices WHERE id = ?").run(other.id);
          merged += 1;
        }
        const pick = <T>(value: (row: (typeof rows)[number]) => T | null) =>
          rows.map(value).find((candidate) => candidate !== null) ?? null;
        this.db
          .query(
            `UPDATE devices SET class = ?, find_my = ?, tag_key = ?, person_id = ?, label = ?,
               trusted = ?, watched = ?, first_seen = ?, last_seen = ?
             WHERE id = ?`,
          )
          .run(
            rows.reduce((best, row) => mergeClass(best, row.class), keeper.class),
            rows.some((row) => row.findMy === "separated") ? "separated" : pick((row) => row.findMy),
            pick((row) => row.tagKey),
            pick((row) => row.personId),
            pick((row) => row.label),
            rows.some((row) => row.trusted === 1) ? 1 : 0,
            rows.some((row) => row.watched === 1) ? 1 : 0,
            Math.min(...rows.map((row) => row.firstSeen)),
            Math.max(...rows.map((row) => row.lastSeen)),
            keeper.id,
          );
      })();
    }
    return merged;
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

    const facts: AliasFacts[] = rows.map((row) => ({
      ...row,
      hasSuccessor: row.hasSuccessor === 1,
      firm: row.paired === 1 || row.tagKey !== null,
    }));
    const factsById = new Map(facts.map((fact) => [fact.id, fact]));
    let linked = 0;

    for (const [index, row] of rows.entries()) {
      // Tags and paired devices already have a firm identity, and a settled link stays.
      if (row.predecessorId || row.tagKey || row.paired) continue;
      // Wait until the alias has been heard enough to judge its signal strength.
      if (now - row.firstSeen < 20_000) continue;
      const alias = facts[index]!;
      const link = inferLink(alias, facts);
      if (!link) continue;
      const formerDevice = alias.deviceId;

      this.db.transaction(() => {
        // Anything already chained after this alias comes with it, or the chain would split.
        const tail = this.chain(link.aliasId, formerDevice);
        this.db
          .query(
            `UPDATE aliases SET predecessor_id = ?, link_confidence = ?, link_evidence = ?
             WHERE id = ?`,
          )
          .run(link.predecessorId, link.confidence, link.evidence, link.aliasId);
        for (const { id } of tail) {
          this.db.query("UPDATE aliases SET device_id = ? WHERE id = ?").run(link.deviceId, id);
          // Later links in this pass read these, so they have to follow the chain too.
          const moved = factsById.get(id);
          if (moved) moved.deviceId = link.deviceId;
        }
        const orphan = this.db
          .query("SELECT COUNT(*) AS n FROM aliases WHERE device_id = ?")
          .get(formerDevice) as { n: number };
        if (orphan.n === 0) this.db.query("DELETE FROM devices WHERE id = ?").run(formerDevice);
      })();

      const predecessor = factsById.get(link.predecessorId);
      if (predecessor) predecessor.hasSuccessor = true;
      linked += 1;
    }
    return linked;
  }

  /**
   * Each advert overwrites the last, so a signal coming back would erase when it stopped.
   * Everything's kept, because a tag that returned on the same address went quiet with you too.
   */
  private recordSilence(alias: HeardAlias, to: number): void {
    this.db
      .query(
        `INSERT OR IGNORE INTO silences (device_id, from_ts, to_ts, first_seen, best_rssi, adverts)
         VALUES (?, ?, ?, ?, (SELECT MAX(rssi_max) FROM sightings WHERE alias_id = ?), ?)`,
      )
      .run(alias.deviceId, alias.lastSeen, to, alias.firstSeen, alias.id, alias.adverts);
  }

  /** A key is firmer than any link, so an alias showing one belongs to the device that holds it. */
  private joinKeyedDevice(aliasId: string, fromDevice: number, toDevice: number): void {
    this.db.transaction(() => {
      this.db
        .query(
          `UPDATE aliases SET device_id = ?, predecessor_id = NULL, link_confidence = NULL, link_evidence = NULL
           WHERE id = ?`,
        )
        .run(toDevice, aliasId);
      this.db
        .query(
          `DELETE FROM devices WHERE id = ? AND paired = 0 AND person_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM aliases WHERE device_id = devices.id)`,
        )
        .run(fromDevice);
    })();
  }

  /** An alias and everything chained after it on the same device. */
  private chain(aliasId: string, deviceId: number): { id: string; firstSeen: number; lastSeen: number }[] {
    return this.db
      .query(
        `WITH RECURSIVE tail(id) AS (
           SELECT ? UNION SELECT a.id FROM aliases a JOIN tail t ON a.predecessor_id = t.id
         ) SELECT a.id, a.first_seen AS firstSeen, a.last_seen AS lastSeen
           FROM aliases a JOIN tail t ON t.id = a.id WHERE a.device_id = ?`,
      )
      .all(aliasId, deviceId) as { id: string; firstSeen: number; lastSeen: number }[];
  }

  /**
   * Takes back links that later evidence disproved. Contradictions surface minutes after a
   * link is made, so waiting longer can't prevent them. The alias and everything chained
   * after it become a separate device, because whatever you tagged must not stay on a stranger.
   */
  retractLinks(): number {
    const links = this.db
      .query(
        `SELECT a.id, a.first_seen AS aliasFirstSeen, p.first_seen AS firstSeen, p.last_seen AS lastSeen,
                d.paired = 1 OR d.tag_key IS NOT NULL AS firm
         FROM aliases a JOIN aliases p ON p.id = a.predecessor_id JOIN devices d ON d.id = p.device_id
         ORDER BY a.first_seen`,
      )
      .all() as { id: string; aliasFirstSeen: number; firstSeen: number; lastSeen: number; firm: number }[];
    const broken = links.filter((link) => refuted({ ...link, firm: link.firm === 1 }, link.aliasFirstSeen));
    if (broken.length === 0) return 0;

    const deviceOf = this.db.query("SELECT device_id AS id FROM aliases WHERE id = ?");
    const aliasCount = this.db.query("SELECT COUNT(*) AS n FROM aliases WHERE device_id = ?");
    const split = this.db.query(
      `INSERT INTO devices (class, vendor, find_my, first_seen, last_seen)
       SELECT class, vendor, find_my, ?, ? FROM devices WHERE id = ? RETURNING id`,
    );
    const move = this.db.query("UPDATE aliases SET device_id = ? WHERE id = ?");
    const unlink = this.db.query(
      "UPDATE aliases SET predecessor_id = NULL, link_confidence = NULL, link_evidence = NULL WHERE id = ?",
    );
    const refresh = this.db.query(
      `UPDATE devices SET
         first_seen = COALESCE((SELECT MIN(first_seen) FROM aliases WHERE device_id = devices.id), first_seen),
         last_seen = COALESCE((SELECT MAX(last_seen) FROM aliases WHERE device_id = devices.id), last_seen)
       WHERE id = ?`,
    );

    this.db.transaction(() => {
      for (const link of broken) {
        // Asked each time, because an earlier link in this list may have moved this alias.
        const { id: deviceId } = deviceOf.get(link.id) as { id: number };
        const tail = this.chain(link.id, deviceId);
        unlink.run(link.id);
        // A chain that's already alone on its device only needs the link removed.
        if (tail.length === (aliasCount.get(deviceId) as { n: number }).n) continue;
        const row = split.get(
          Math.min(...tail.map((alias) => alias.firstSeen)),
          Math.max(...tail.map((alias) => alias.lastSeen)),
          deviceId,
        ) as { id: number };
        for (const alias of tail) move.run(row.id, alias.id);
        refresh.run(deviceId);
      }
      setMeta(this.db, "links.retracted", String(Number(getMeta(this.db, "links.retracted") ?? 0) + broken.length));
    })();
    return broken.length;
  }

  /** Strangers' sightings expire. Devices you claimed, trust or watch are kept. */
  prune(now: number): void {
    const cutoff = Math.floor((now - RETENTION_MS) / 60_000);
    this.db.transaction(() => {
      this.db.query("DELETE FROM silences WHERE from_ts < ?").run(now - RETENTION_MS);
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
