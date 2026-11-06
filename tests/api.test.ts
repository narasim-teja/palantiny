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
    expect((await app.request("/v1/snapshot", { headers: LOCAL })).status).toBe(200);
  });

  test("trusts a configured dev server, whose proxy changes the host", async () => {
    const proxied = { host: "127.0.0.1:4118", origin: "http://127.0.0.1:4117" };
    expect((await app.request("/v1/snapshot", { headers: proxied })).status).toBe(403);
    const dev = createApp(db, { webOrigin: "http://127.0.0.1:4117" });
    expect((await dev.request("/v1/snapshot", { headers: proxied })).status).toBe(200);
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
