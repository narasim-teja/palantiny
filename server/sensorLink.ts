import type { Database } from "bun:sqlite";
import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { parseSensorEvent, type SensorEvent } from "@core/events";
import { startAlerts } from "./alerts";
import { setMeta } from "./db";
import { Ingest } from "./ingest";
import { importPairedDevices } from "./paired";

const MAC_APP = resolve("native/macos/build/palantiny-sensor.app");
const SOCKET = resolve(process.env.PALANTINY_SOCKET ?? "data/sensor.sock");
const HEARTBEAT_MS = 5_000;
const LINK_MS = 30_000;
const PRUNE_MS = 3_600_000;
const PAIRED_MS = 600_000;

/**
 * macos    launches the bundled sensor app
 * external listens for a sensor you start yourself, on any OS
 * off      no sensor, for browsing a database such as the test data
 */
export type SensorMode = "macos" | "external" | "off";

export function sensorMode(): SensorMode {
  const mode = process.env.PALANTINY_SENSOR;
  if (mode === "macos" || mode === "external" || mode === "off") return mode;
  return process.platform === "darwin" ? "macos" : "external";
}

interface Connection {
  buffer: string;
  decoder: TextDecoder;
}

/** Files sensor events into the ontology. Returns a function that shuts it down. */
export async function startSensorLink(db: Database, mode: SensorMode): Promise<() => void> {
  if (mode === "off") return () => {};
  if (mode === "macos" && !existsSync(MAC_APP)) {
    throw new Error("Sensor not built. Run: bun run sensor:build");
  }

  const ingest = new Ingest(db);
  ingest.retractLinks();
  ingest.mergeByName();
  let connected = 0;

  // The heartbeat means a sensor is really there, so "Listening" is only ever true.
  const beat = () => setMeta(db, "heartbeat", String(Date.now()));

  const handle = (event: SensorEvent) => {
    switch (event.t) {
      case "ble":
        ingest.ble(event);
        break;
      case "wifi":
        ingest.wifi(event);
        break;
      case "status":
        for (const key of ["bluetooth", "location", "wifi"] as const) {
          const value = event[key];
          if (value) setMeta(db, `status.${key}`, value);
        }
        break;
      case "hello":
        console.log(`server: sensor connected, protocol v${event.v}`);
        break;
    }
  };

  if (existsSync(SOCKET)) unlinkSync(SOCKET);

  const listener = Bun.listen<Connection>({
    unix: SOCKET,
    socket: {
      open(socket) {
        // Each sensor gets its own buffer, so two can't corrupt each other's lines.
        socket.data = { buffer: "", decoder: new TextDecoder() };
        connected += 1;
        beat();
      },
      data(socket, chunk) {
        const connection = socket.data;
        connection.buffer += connection.decoder.decode(chunk, { stream: true });
        let newline = connection.buffer.indexOf("\n");
        while (newline >= 0) {
          const line = connection.buffer.slice(0, newline);
          connection.buffer = connection.buffer.slice(newline + 1);
          newline = connection.buffer.indexOf("\n");
          if (!line) continue;
          const event = parseSensorEvent(line);
          if (event) handle(event);
          else console.error("server: dropped a bad sensor event");
        }
      },
      close() {
        connected -= 1;
        console.log("server: sensor disconnected");
        if (connected === 0) {
          setMeta(db, "status.bluetooth", "unknown");
          setMeta(db, "heartbeat", "0");
        }
      },
      error(_socket, error) {
        console.error("server: sensor socket error", error);
      },
    },
  });

  const timers = [
    setInterval(() => {
      if (connected > 0) beat();
    }, HEARTBEAT_MS),
    setInterval(() => {
      const retracted = ingest.retractLinks();
      const linked = ingest.linkAliases(Date.now()) + ingest.mergeByName();
      if (linked > 0) console.log(`server: linked ${linked} rotated aliases`);
      if (retracted > 0) console.log(`server: retracted ${retracted} disproved links`);
    }, LINK_MS),
    setInterval(() => ingest.prune(Date.now()), PRUNE_MS),
  ];

  let stopAlerts = () => {};
  if (mode === "macos") {
    stopAlerts = startAlerts(db);
    const importPaired = () =>
      importPairedDevices(db, Date.now())
        .then((count) => console.log(`server: ${count} new paired devices`))
        .catch((error) => console.error("server: paired device import failed", error));
    void importPaired();
    timers.push(setInterval(importPaired, PAIRED_MS));
    // `open` gives the sensor its own app identity, which is what macOS grants
    // Bluetooth and Location permission to. Launching the binary directly would not.
    await Bun.spawn(["open", "-n", MAC_APP, "--args", "--socket", SOCKET]).exited;
  } else {
    console.log(`server: waiting for a sensor on ${SOCKET}`);
  }

  return () => {
    for (const timer of timers) clearInterval(timer);
    stopAlerts();
    setMeta(db, "heartbeat", "0");
    // The macOS sensor exits when this socket closes, so nothing scans on in the background.
    listener.stop(true);
  };
}
