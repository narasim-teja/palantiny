import type { Database } from "bun:sqlite";
import type { ActionRequest } from "@core/types";

const MAX_LABEL = 40;

function cleanLabel(value: string): string {
  return value.trim().slice(0, MAX_LABEL);
}

function selfId(db: Database): number {
  return (db.query("SELECT id FROM people WHERE self = 1").get() as { id: number }).id;
}

/** Reuses a person with the same name, whatever the capitalisation. */
function personId(db: Database, label: string): number {
  const existing = db
    .query("SELECT id FROM people WHERE self = 0 AND label = ? COLLATE NOCASE")
    .get(label) as { id: number } | null;
  if (existing) return existing.id;
  const code = `PERSON-${crypto.randomUUID().slice(0, 8)}`;
  return (
    db.query("INSERT INTO people (code, label, self) VALUES (?, ?, 0) RETURNING id").get(code, label) as {
      id: number;
    }
  ).id;
}

/** Someone with no devices left shouldn't linger as a name in the database. */
function forgetUnusedPeople(db: Database): void {
  db.run(
    "DELETE FROM people WHERE self = 0 AND NOT EXISTS (SELECT 1 FROM devices d WHERE d.person_id = people.id)",
  );
}

/** Actions are the only way the ontology changes by hand, and each one is logged. */
export function applyAction(db: Database, request: ActionRequest, now = Date.now()): void {
  if (request.action === "rename-place") {
    const label = cleanLabel(request.label);
    db.query("UPDATE places SET label = ? WHERE id = ?").run(label || null, request.placeId);
    db.query("INSERT INTO action_log (ts, action, place_id) VALUES (?, ?, ?)").run(
      now,
      request.action,
      request.placeId,
    );
    return;
  }

  const id = request.deviceId;
  switch (request.action) {
    case "claim":
      db.query("UPDATE devices SET person_id = ? WHERE id = ?").run(selfId(db), id);
      forgetUnusedPeople(db);
      break;
    case "unclaim":
      // A name only makes sense on a device you've tied to someone.
      db.query("UPDATE devices SET person_id = NULL, label = NULL WHERE id = ?").run(id);
      forgetUnusedPeople(db);
      break;
    case "assign": {
      const person = cleanLabel(request.person);
      if (!person) return;
      const owner = personId(db, person);
      db.query("UPDATE devices SET person_id = ? WHERE id = ?").run(owner, id);
      if (request.publicLabel !== undefined) {
        db.query("UPDATE people SET public_label = ? WHERE id = ?").run(cleanLabel(request.publicLabel) || null, owner);
      }
      forgetUnusedPeople(db);
      break;
    }
    case "name-device":
      // Only a device you've tied to someone can be named, so strangers stay callsigns.
      db.query("UPDATE devices SET label = ? WHERE id = ? AND person_id IS NOT NULL").run(
        cleanLabel(request.label) || null,
        id,
      );
      break;
    case "trust":
    case "untrust":
      db.query("UPDATE devices SET trusted = ? WHERE id = ?").run(request.action === "trust" ? 1 : 0, id);
      break;
    case "watch":
    case "unwatch":
      db.query("UPDATE devices SET watched = ? WHERE id = ?").run(request.action === "watch" ? 1 : 0, id);
      break;
  }
  db.query("INSERT INTO action_log (ts, action, device_id) VALUES (?, ?, ?)").run(now, request.action, id);
}

export function parseAction(body: unknown): ActionRequest | null {
  if (typeof body !== "object" || body === null) return null;
  const input = body as Record<string, unknown>;
  if (input.action === "rename-place") {
    if (!Number.isInteger(input.placeId) || typeof input.label !== "string") return null;
    return { action: "rename-place", placeId: input.placeId as number, label: input.label };
  }
  if (input.action === "assign") {
    if (!Number.isInteger(input.deviceId) || typeof input.person !== "string") return null;
    const publicLabel = typeof input.publicLabel === "string" ? input.publicLabel : undefined;
    return { action: "assign", deviceId: input.deviceId as number, person: input.person, publicLabel };
  }
  if (input.action === "name-device") {
    if (!Number.isInteger(input.deviceId) || typeof input.label !== "string") return null;
    return { action: "name-device", deviceId: input.deviceId as number, label: input.label };
  }
  const deviceActions = ["claim", "unclaim", "trust", "untrust", "watch", "unwatch"] as const;
  const action = deviceActions.find((candidate) => candidate === input.action);
  if (!action || !Number.isInteger(input.deviceId)) return null;
  return { action, deviceId: input.deviceId as number };
}
