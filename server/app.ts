import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { streamSSE } from "hono/streaming";
import { applyAction, parseAction } from "./actions";
import { buildDeviceDetail, buildSnapshot } from "./snapshot";

const STREAM_INTERVAL_MS = 3_000;
// Building a snapshot blocks this process, which is also reading the sensor, so clients share one.
const SNAPSHOT_TTL_MS = 1_000;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

function hostname(host: string): string {
  return host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : (host.split(":")[0] ?? "");
}

function sameHost(origin: string, host: string): boolean {
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

interface Options {
  /** Built console to serve alongside the API. */
  webRoot?: string;
  /** Separate origins allowed to call the API, such as a dev server proxying to it. */
  webOrigins?: string[];
}

/** The whole API. Every client, the web console included, goes through these routes. */
export function createApp(db: Database, { webRoot, webOrigins = [] }: Options = {}) {
  const app = new Hono();
  const cache = new Map<boolean, { at: number; json: string }>();

  const snapshotJson = (reveal: boolean): string => {
    const now = Date.now();
    const cached = cache.get(reveal);
    if (cached && now - cached.at < SNAPSHOT_TTL_MS) return cached.json;
    const json = JSON.stringify(buildSnapshot(db, reveal, now));
    cache.set(reveal, { at: now, json });
    return json;
  };

  // A web page you visit must not reach this API, even by pointing its own domain at
  // 127.0.0.1. Native clients send no Origin, so they pass.
  app.use("/v1/*", async (c, next) => {
    const host = c.req.header("host") ?? "";
    const origin = c.req.header("origin");
    const trusted = !origin || webOrigins.includes(origin) || sameHost(origin, host);
    if (!LOOPBACK.has(hostname(host)) || !trusted) {
      return c.json({ error: "Only local clients may use this API" }, 403);
    }
    await next();
  });

  app.get("/v1/snapshot", (c) => {
    c.header("Content-Type", "application/json");
    return c.body(snapshotJson(c.req.query("reveal") === "1"));
  });

  app.get("/v1/stream", (c) => {
    const reveal = c.req.query("reveal") === "1";
    return streamSSE(c, async (stream) => {
      while (!stream.aborted) {
        await stream.writeSSE({ data: snapshotJson(reveal) });
        await stream.sleep(STREAM_INTERVAL_MS);
      }
    });
  });

  app.get("/v1/devices/:id", (c) => {
    const deviceId = Number(c.req.param("id"));
    if (!Number.isInteger(deviceId)) return c.json({ error: "Bad device id" }, 400);
    return c.json(buildDeviceDetail(db, deviceId));
  });

  app.post("/v1/actions", async (c) => {
    const action = parseAction(await c.req.json().catch(() => null));
    if (!action) return c.json({ error: "Unknown action" }, 400);
    applyAction(db, action);
    cache.clear();
    return c.json({ ok: true });
  });

  if (webRoot) app.use("/*", serveStatic({ root: webRoot }));

  return app;
}
