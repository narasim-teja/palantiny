import type { Database } from "bun:sqlite";
import type { ActionRequest } from "./types";

const MAX_LABEL = 40;

function selfId(db: Database): number {
  return (db.query("SELECT id FROM people WHERE self = 1").get() as { id: number }).id;
}

/** Actions are the only way the ontology changes by hand, and each one is logged. */
export function applyAction(db: Database, request: ActionRequest, now = Date.now()): void {
  if (request.action === "rename-place") {
    const label = request.label.trim().slice(0, MAX_LABEL);
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
      break;
    case "unclaim":
      db.query("UPDATE devices SET person_id = NULL WHERE id = ?").run(id);
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
  const deviceActions = ["claim", "unclaim", "trust", "untrust", "watch", "unwatch"] as const;
  const action = deviceActions.find((candidate) => candidate === input.action);
  if (!action || !Number.isInteger(input.deviceId)) return null;
  return { action, deviceId: input.deviceId as number };
}
