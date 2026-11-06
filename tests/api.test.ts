import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { parseSensorEvent } from "../core/events";
import type { Snapshot } from "../core/types";
import { createApp } from "../server/app";
import { openDb } from "../server/db";

const LOCAL = { host: "127.0.0.1:4117" };

describe("api", () => {
  let db: Database;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = openDb(":memory:");
    app = createApp(db);
    db.run(
      `INSERT INTO devices (id, class, name, first_seen, last_seen)
       VALUES (1, 'audio', 'Private Name', 1, 2)`,
    );
  });

  const snapshot = async (path: string) =>
    (await (await app.request(path, { headers: LOCAL })).json()) as Snapshot;

  test("keeps names out of the response unless asked", async () => {
    expect(JSON.stringify(await snapshot("/v1/snapshot"))).not.toContain("Private Name");
    expect(JSON.stringify(await snapshot("/v1/snapshot?reveal=1"))).toContain("Private Name");
  });

  test("refuses a site that points its own domain at this machine", async () => {
    const response = await app.request("/v1/snapshot", { headers: { host: "evil.example:4117" } });
    expect(response.status).toBe(403);
  });

  test("refuses another origin, and an unreadable one", async () => {
    for (const origin of ["https://evil.example", "null"]) {
      const response = await app.request("/v1/snapshot", { headers: { ...LOCAL, origin } });
      expect(response.status).toBe(403);
    }
  });

  test("accepts the console, and native clients that send no origin", async () => {
    const console = { ...LOCAL, origin: "http://127.0.0.1:4117" };
    expect((await app.request("/v1/snapshot", { headers: console })).status).toBe(200);
    const named = { host: "localhost:4117", origin: "http://localhost:4117" };
    expect((await app.request("/v1/snapshot", { headers: named })).status).toBe(200);
    expect((await app.request("/v1/snapshot", { headers: LOCAL })).status).toBe(200);
  });

  test("trusts a configured dev server, whose proxy changes the host", async () => {
    const proxied = { host: "127.0.0.1:4118", origin: "http://127.0.0.1:4117" };
    expect((await app.request("/v1/snapshot", { headers: proxied })).status).toBe(403);
    const dev = createApp(db, { webOrigins: ["http://127.0.0.1:4117", "http://localhost:4117"] });
    expect((await dev.request("/v1/snapshot", { headers: proxied })).status).toBe(200);
    const spelledOut = { ...proxied, origin: "http://localhost:4117" };
    expect((await dev.request("/v1/snapshot", { headers: spelledOut })).status).toBe(200);
    const other = { ...proxied, origin: "http://127.0.0.1:3000" };
    expect((await dev.request("/v1/snapshot", { headers: other })).status).toBe(403);
  });

  test("applies a valid action and rejects anything else", async () => {
    const post = (body: unknown) =>
      app.request("/v1/actions", {
        method: "POST",
        headers: { ...LOCAL, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await snapshot("/v1/snapshot")).devices[0]?.owner).toBeNull();
    expect((await post({ action: "claim", deviceId: 1 })).status).toBe(200);
    // The result shows straight away, even though snapshots are shared for a moment.
    expect((await snapshot("/v1/snapshot")).devices[0]?.owner?.self).toBe(true);
    expect((await post({ action: "delete-everything" })).status).toBe(400);
  });

  test("rejects a device id that isn't a number", async () => {
    expect((await app.request("/v1/devices/abc", { headers: LOCAL })).status).toBe(400);
  });

  test("streams snapshots", async () => {
    const response = await app.request("/v1/stream", { headers: LOCAL });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const { value } = await reader.read();
    await reader.cancel();
    expect(new TextDecoder().decode(value)).toStartWith("data: {");
  });
});

describe("sensor format", () => {
  test("accepts well-formed events", () => {
    expect(parseSensorEvent('{"t":"hello","ts":1,"v":1}')?.t).toBe("hello");
    expect(parseSensorEvent('{"t":"ble","ts":1,"id":"A","rssi":-60}')?.t).toBe("ble");
    expect(parseSensorEvent('{"t":"wifi","ts":1,"nets":[]}')?.t).toBe("wifi");
  });

  test("drops anything malformed", () => {
    for (const line of [
      "not json",
      "null",
      '{"t":"ble","ts":1,"rssi":-60}',
      '{"t":"ble","ts":1,"id":"A"}',
      '{"t":"wifi","ts":1}',
      '{"t":"wifi","nets":[]}',
      '{"t":"mystery","ts":1}',
    ]) {
      expect(parseSensorEvent(line)).toBeNull();
    }
  });
});

describe("people and names", () => {
  let db: Database;
  let app: ReturnType<typeof createApp>;
  const post = (body: unknown) =>
    app.request("/v1/actions", {
      method: "POST",
      headers: { ...LOCAL, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const read = async (reveal: boolean) =>
    (await (await app.request(`/v1/snapshot${reveal ? "?reveal=1" : ""}`, { headers: LOCAL })).json()) as Snapshot;

  beforeEach(() => {
    db = openDb(":memory:");
    app = createApp(db);
    db.run("INSERT INTO devices (id, class, first_seen, last_seen) VALUES (1, 'wearable', 1, 2)");
  });

  test("a stranger's device can't be named", async () => {
    await post({ action: "name-device", deviceId: 1, label: "Their watch" });
    expect((await read(true)).devices[0]?.label).toBeNull();
  });

  test("your own names always show", async () => {
    await post({ action: "claim", deviceId: 1 });
    await post({ action: "name-device", deviceId: 1, label: "My WHOOP" });
    expect((await read(false)).devices[0]?.label).toBe("My WHOOP");
  });

  test("a recording only ever gets someone's public name", async () => {
    await post({ action: "assign", deviceId: 1, person: "Priya Sharma", publicLabel: "Roommate" });
    await post({ action: "name-device", deviceId: 1, label: "Priya's WHOOP" });
    const safe = await read(false);
    expect(JSON.stringify(safe)).not.toContain("Priya");
    expect(safe.devices[0]?.owner?.label).toBe("Roommate");
    expect(safe.people).toEqual([]);
    const full = await read(true);
    expect(full.devices[0]?.owner?.label).toBe("Priya Sharma");
    expect(full.people[0]?.publicLabel).toBe("Roommate");
  });

  test("without a public name, a recording shows no name at all", async () => {
    await post({ action: "assign", deviceId: 1, person: "Priya Sharma" });
    expect((await read(false)).devices[0]?.owner?.label).toBeNull();
  });

  test("a person with no devices left is forgotten", async () => {
    await post({ action: "assign", deviceId: 1, person: "Priya Sharma" });
    await post({ action: "unclaim", deviceId: 1 });
    expect((await read(true)).people).toEqual([]);
    expect(db.query("SELECT COUNT(*) AS n FROM people").get()).toEqual({ n: 1 });
  });
});

describe("watching end to end", () => {
  test("a watched device heard at a new place raises a high finding", async () => {
    const db = openDb(":memory:");
    const app = createApp(db);
    const now = Date.now();
    const minute = Math.floor(now / 60_000);
    db.run("INSERT INTO places (id, code, first_seen, last_seen) VALUES (1, 'PLACE-A', 1, 1), (2, 'PLACE-B', 1, 1)");
    db.query("INSERT INTO devices (id, class, first_seen, last_seen) VALUES (1, 'wearable', ?, ?)").run(now - 600_000, now);
    db.query("INSERT INTO aliases (id, device_id, place_id, signature, first_seen, last_seen) VALUES ('a', 1, 1, 's', ?, ?)").run(now - 600_000, now);
    const sight = db.query("INSERT INTO sightings (alias_id, place_id, minute, n) VALUES ('a', ?, ?, 1)");
    for (let i = 10; i > 6; i -= 1) sight.run(1, minute - i);

    await app.request("/v1/actions", {
      method: "POST",
      headers: { ...LOCAL, "content-type": "application/json" },
      body: JSON.stringify({ action: "watch", deviceId: 1 }),
    });
    const read = async () =>
      (await (await app.request("/v1/snapshot", { headers: LOCAL })).json()) as Snapshot;
    expect((await read()).findings).toEqual([]);

    for (let i = 0; i < 3; i += 1) sight.run(2, minute + 1 + i);
    await Bun.sleep(1_050); // Outlast the shared snapshot.
    const [finding] = (await read()).findings;
    expect(finding?.severity).toBe("high");
    expect(finding?.id).toBe("watch-place-1-2");
  });
});

describe("search", () => {
  let db: Database;
  let app: ReturnType<typeof createApp>;
  const find = async (query: string, reveal = false) =>
    (await (
      await app.request(`/v1/devices?q=${encodeURIComponent(query)}${reveal ? "&reveal=1" : ""}`, { headers: LOCAL })
    ).json()) as { total: number; devices: { id: number }[] };

  beforeEach(() => {
    db = openDb(":memory:");
    app = createApp(db);
    db.run("INSERT INTO people (id, code, label, public_label, self) VALUES (2, 'P', 'Priya Sharma', 'Roommate', 0)");
    db.run(`INSERT INTO devices (id, class, name, label, person_id, first_seen, last_seen)
            VALUES (1, 'wearable', 'WHOOP 5A00000000', 'Priya band', 2, 1, 2)`);
    db.run("INSERT INTO devices (id, class, vendor, first_seen, last_seen) VALUES (2, 'unknown', 'Samsung', 1, 2)");
  });

  test("finds by type, vendor, public name and identity", async () => {
    expect((await find("whoop")).devices.map((d) => d.id)).toEqual([1]);
    expect((await find("samsung")).devices.map((d) => d.id)).toEqual([2]);
    expect((await find("roommate")).devices.map((d) => d.id)).toEqual([1]);
  });

  test("needs every word to match", async () => {
    expect((await find("whoop roommate")).total).toBe(1);
    expect((await find("whoop samsung")).total).toBe(0);
  });

  test("can't discover a hidden name in screenshot mode", async () => {
    expect((await find("priya")).total).toBe(0);
    expect((await find("5A00000000")).total).toBe(0);
    expect((await find("priya", true)).total).toBe(1);
    expect((await find("5A00000000", true)).total).toBe(1);
  });

  test("reaches past what a snapshot carries", async () => {
    const insert = db.query("INSERT INTO devices (class, first_seen, last_seen) VALUES ('unknown', 1, 2)");
    for (let i = 0; i < 300; i += 1) insert.run();
    const { total, devices } = await find("unidentified");
    expect(total).toBeGreaterThan(200);
    expect(devices.length).toBe(200);
  });

  test("an empty search returns nothing", async () => {
    expect(await find("   ")).toEqual({ total: 0, devices: [] });
  });
});
