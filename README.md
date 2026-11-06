# palantiny

A local console that listens to public Bluetooth and Wi-Fi broadcasts around your Mac, models them as an ontology, and answers one question: is anything following me?

Everything stays on your Mac. There's no account, no cloud and nothing hosted, and the server binds to `127.0.0.1` only.

palantiny is a side project. It has no connection to Palantir Technologies.

> **Status:** the sensor, ontology and console work on real data. Following detection across two real places hasn't been tested yet. See [what's proven](HOW_IT_WORKS.md#whats-proven-and-whats-not).

## Run it

Needs macOS 14+, [Bun](https://bun.sh) and the Xcode command line tools.

```sh
bun install
bun run dev
```

Open <http://127.0.0.1:4117>. The first run asks for two permissions for **palantiny sensor**:

- **Bluetooth**, to hear nearby broadcasts.
- **Location**, because macOS hides Wi-Fi names without it. palantiny stores no coordinates.

If you miss a prompt, allow the app under System Settings, Privacy & Security.

Your first place appears after two matching Wi-Fi scans, about a minute in. To find anything that follows you, take the Mac somewhere else and leave it awake and listening. Scanning mostly stops while the lid is closed.

## Reading the graph

Each plate is a place. Every device stands on a needle: closer to the centre is a stronger signal, and a taller needle was heard for longer. Shape is device type, and a hollow marker isn't being heard right now. A line through plates is one device seen at each place, dashed where that identity is inferred. Blue is you, and red is a finding that needs you.

## How it's built

```text
native/macos/  Swift sensor: passive Bluetooth and Wi-Fi scanning
server/        Bun + Hono: owns SQLite, files sensor events, serves the API
core/          The ontology, parsing and inference (pure TypeScript, tested)
web/           Vite + React console, with three.js for the graph
scripts/       One-command dev runner and labelled test data
```

Two seams keep this pluggable:

- **Sensors** write JSON lines to a Unix socket, so one can be written in any language, for any OS.
- **Clients** use the local HTTP API at `/v1`, so the web console is only one possible client.

Both are documented in [How it works](HOW_IT_WORKS.md#plugging-in).

| Object | What it is |
|---|---|
| Person | You. Strangers are never given an identity. |
| Device | One piece of hardware, as best we can tell |
| Alias | One rotating Bluetooth identity of a device |
| Sighting | An alias heard at a place during a given minute |
| Place | Recognised from nearby Wi-Fi, with no GPS |
| Network | A Wi-Fi network seen at a place |

Actions are Claim as mine, Mark trusted, Watch and Rename place. Each one is logged.

For the full story, including what we measured and the research behind it, read [How it works](HOW_IT_WORKS.md).

## Reading the results honestly

- **"In range" is the honest count.** The Device total keeps growing, because passers-by and rotated addresses that couldn't be linked each add a row. Quote the in-range number.
- **Your own devices show up first.** They follow you everywhere, so claim them.
- **Addresses rotate.** Linking aliases is inference. Dashed lines and confidence scores mark every guess, and any doubt means no link.
- **Most phones can't be matched between places.** Gadgets with a fixed address can, and separated Find My devices can for a while.
- **A separated Find My device is not proof of anything.** It may be a neighbour's lost keys, or someone you're travelling with. This is a side project, not a safety tool. If you think you're being tracked, use your phone's built-in tracker alerts and contact the police.

## Privacy defaults

- Screenshot mode is on at every page load. Names are removed on the server, so they never reach the browser.
- BSSIDs are stored only as salted hashes.
- Strangers' sightings are deleted after 30 days.
- Listening only: no connecting to devices and no packet capture.
- The sensor exits when the server stops, so nothing keeps scanning in the background.
- `data/` is gitignored, because it holds nearby devices' names. Don't share it.

Be considerate with this. The people around you didn't opt in, so keep their devices pseudonymous and don't use it to follow anyone.

## Commands

| Command | Does |
|---|---|
| `bun run dev` | Sensor, server and console together, with hot reload |
| `bun run build && bun run start` | The same on one port, serving the built console |
| `bun test` | Tests for parsing, places, linking, findings, the API and redaction |
| `bun run typecheck` | Type check |
| `bun run fixture` | Builds `data/fixture.db`, labelled test data for layout work |
| `PALANTINY_DB=data/fixture.db PALANTINY_SENSOR=off bun run server` | Serves the built console on that test data |

Keyboard: `G` graph, `L` list, `F` film mode, `Esc` clear selection.

Film mode hides the panels and controls, slowly orbits the graph and captions it with what is in range now.

## License

[MIT](LICENSE)
