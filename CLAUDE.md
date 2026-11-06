# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`AGENTS.md` is a symlink to this file, so edit this one.

palantiny listens to public Bluetooth and Wi-Fi broadcasts on a Mac, models them as an ontology, and answers one question: is anything following me? See [HOW_IT_WORKS.md](HOW_IT_WORKS.md) for the full reasoning, measurements and sources.

## Commands

```sh
bun run dev                     # sensor, server (4118) and Vite (4117) together
bun test                        # everything
bun test tests/api.test.ts      # one file
bun test -t "public name"       # tests matching a name
bun run typecheck
bun run build                   # console into web/dist
bun run start                   # sensor and server on 4117, serving web/dist

# Test data, with no sensor or permissions
bun run fixture && bun run build
PALANTINY_DB=data/fixture.db PALANTINY_SENSOR=off bun run server
```

There's no linter. To catch dead code, run `bunx tsc --noEmit --noUnusedLocals --noUnusedParameters`.

## Architecture

```text
native/macos  ->  Unix socket  ->  server/         ->  HTTP + SSE  ->  web/
 (listens)        (JSON lines)     Bun + Hono          (/v1)          Vite + React
                                   SQLite, core/                      three.js
```

- `core/` is pure TypeScript with no database or runtime dependencies, shared by the server, web and tests. Import it as `@core/...`. In `web/`, `@/` means `web/src/`.
- `server/` is one process, and it's the only thing that touches SQLite. `sensorLink.ts` reads sensors, `ingest.ts` files events, `snapshot.ts` builds what clients see, and `app.ts` is the API.
- `web/` only ever talks to `/v1`, so any other client can do what it does.
- The two seams are the sensor format (`core/events.ts`) and the `/v1` API. Keep them stable, and document changes in HOW_IT_WORKS.md.

The core model: an **Alias** is one identity heard on the air, and a **Device** is a claim that several aliases are one thing. Aliases merge into devices through timing (`core/inference.ts`, `Ingest.linkAliases`), a shared key, or a distinctive name (`core/recognise.ts`, `Ingest.mergeByName`).

## Rules that aren't obvious from one file

**Privacy is enforced on the server.** `readDevices` in `server/snapshot.ts` strips names unless `reveal` is set, and everything else derives from that view. Search and notifications both use it, so hidden names can't be found or shown. Never query name columns directly for something a client sees. In screenshot mode, other people appear only under their public name.

**Strangers stay pseudonymous.** Only devices tied to a person can be named. Don't add anything that works out who a stranger is, or that fingerprints phones through address rotation.

**Listen only.** The sensor must never connect to a device.

**Real data is close at hand, so keep it out of the repo.** `data/` holds real device names and serials. Use invented values in code, comments, tests and docs. Check for this before committing.

**Honest numbers.** The Device total is inflated by rotation, so lead with devices in range. Multi-place visuals come from labelled test data, and the console flags that. Absence is counted in minutes the Mac was listening, never on the clock (`core/presence.ts`).

**Snapshots are capped.** `buildSnapshot` returns the top 160 devices by relevance, so anything that needs all of them goes through `searchDevices`. Snapshots are shared for 1 second, and actions clear that cache.

**Adding an action touches four places:** `ActionRequest` in `core/types.ts`, `applyAction` and `parseAction` in `server/actions.ts`, and `applyOptimistic` in `web/src/lib/optimistic.ts`. The UI applies actions before the server confirms them, and `useSnapshot` holds them over incoming snapshots until it does.

**Schema changes** go in `migrate()` in `server/db.ts`, because real databases already exist. Back up `data/palantiny.db` before anything that merges or deletes rows.

**The sensor's signature matters.** Changing anything in `native/macos/` rebuilds the app, and a new ad-hoc signature can make macOS ask for permissions again. `build.sh` skips unchanged builds for this reason.

**The API guard refuses other hosts and origins.** In `bun run dev`, Vite's proxy rewrites `Host` but not `Origin`, so `scripts/dev.ts` tells the server which dev origins to trust. Test browser changes through both `localhost` and `127.0.0.1`.

**Colours exist twice.** WebGL can't read CSS variables, so `web/src/lib/tokens.ts` mirrors `web/src/styles.css`. Keep them in step.

## Design

The console plays it straight, like real analyst software: plain statements of what was observed, with uncertainty named. It never says "THREAT DETECTED".

Blue only means you, and red only means a finding that needs you. Device type is carried by shape, never by colour alone. Motion conveys state only, and reduced motion is respected.

`PRODUCT.md` and `docs/` are private local notes, gitignored on purpose. They may not exist in a fresh clone.

## Commits

Small logical batches with conventional prefixes (`feat`, `fix`, `chore`, `docs`, `test`, `refactor`). No co-author tags.
