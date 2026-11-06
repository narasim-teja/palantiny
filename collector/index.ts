import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { openDb, setMeta } from "../lib/db";
import { Ingest, type BleEvent, type WifiEvent } from "./ingest";
import { importPairedDevices } from "./paired";

const APP = resolve("sensor/build/palantiny-sensor.app");
const SOCKET = resolve("data/sensor.sock");

interface StatusEvent {
  t: "status";
  bluetooth?: string;
  location?: string;
  wifi?: string;
}
type SensorEvent = BleEvent | WifiEvent | StatusEvent | { t: "hello" };

if (!existsSync(APP)) {
  console.error("Sensor not built. Run: bun run sensor:build");
  process.exit(1);
}

const db = openDb();
const ingest = new Ingest(db);

function handle(event: SensorEvent): void {
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
      console.log("collector: sensor connected");
      break;
  }
}

if (existsSync(SOCKET)) unlinkSync(SOCKET);

const decoder = new TextDecoder();
let buffer = "";

const server = Bun.listen({
  unix: SOCKET,
  socket: {
    data(_socket, chunk) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line) continue;
        try {
          handle(JSON.parse(line) as SensorEvent);
        } catch (error) {
          console.error("collector: dropped a bad event", error);
        }
      }
    },
    close() {
      console.log("collector: sensor disconnected");
      setMeta(db, "status.bluetooth", "unknown");
    },
    error(_socket, error) {
      console.error("collector: socket error", error);
    },
  },
});

setMeta(db, "heartbeat", String(Date.now()));
const heartbeat = setInterval(() => setMeta(db, "heartbeat", String(Date.now())), 5_000);
const linker = setInterval(() => {
  const linked = ingest.linkAliases(Date.now());
  if (linked > 0) console.log(`collector: linked ${linked} rotated aliases`);
}, 30_000);
const pruner = setInterval(() => ingest.prune(Date.now()), 3_600_000);

importPairedDevices(db, Date.now())
  .then((count) => console.log(`collector: ${count} new paired devices`))
  .catch((error) => console.error("collector: paired device import failed", error));

// `open` gives the sensor its own app identity, which is what macOS grants
// Bluetooth and Location permission to. Launching the binary directly would not.
await Bun.spawn(["open", "-n", APP, "--args", "--socket", SOCKET]).exited;
console.log("collector: running. Ctrl-C to stop; the sensor stops with it.");

function shutdown(): void {
  clearInterval(heartbeat);
  clearInterval(linker);
  clearInterval(pruner);
  setMeta(db, "heartbeat", "0");
  server.stop(true);
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
