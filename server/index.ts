import { createApp } from "./app";
import { openDb } from "./db";
import { sensorMode, startSensorLink } from "./sensorLink";

// Loopback only. Names and sightings must not be reachable from the network.
const HOST = "127.0.0.1";
const PORT = Number(process.env.PALANTINY_PORT ?? 4117);

const db = openDb();
const mode = sensorMode();
const stopSensorLink = await startSensorLink(db, mode).catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  fetch: createApp(db, { webRoot: "web/dist", webOrigins: process.env.PALANTINY_WEB_ORIGINS?.split(",") }).fetch,
  // The event stream stays open for as long as a client is watching.
  idleTimeout: 0,
});

console.log(`server: http://${HOST}:${server.port} (sensor: ${mode})`);

function shutdown(): void {
  stopSensorLink();
  void server.stop(true);
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
