# palantiny

A local console that listens to public Bluetooth and Wi-Fi broadcasts around your Mac, models them as an ontology, and answers one question: is anything following me?

Everything stays on your Mac. There's no account, no cloud and no hosted backend, and the web server binds to `127.0.0.1` only.

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
sensor/       Swift app: passive Bluetooth and Wi-Fi scanning, JSON lines over a Unix socket
collector/    Bun process: files events into SQLite, recognises places, links rotating aliases
lib/          The ontology, inference and findings (pure, tested)
app/          Next.js console, plus the local API routes that read SQLite
components/   Console UI, with three.js for the graph
hooks/        Live data and media queries for the UI
scripts/      One-command dev runner and labelled test data
```

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
- The sensor exits when the collector stops, so nothing keeps scanning in the background.
- `data/` is gitignored, because it holds nearby devices' names. Don't share it.

Be considerate with this. The people around you didn't opt in, so keep their devices pseudonymous and don't use it to follow anyone.

## Commands

| Command | Does |
|---|---|
| `bun run dev` | Sensor, collector and console together |
| `bun test` | Tests for parsing, places, linking, findings and redaction |
| `bun run typecheck` | Type check |
| `bun run scripts/fixture.ts` | Builds `data/fixture.db`, labelled test data for layout work |
| `PALANTINY_DB=data/fixture.db bun run web` | Runs the console on that test data |

Keyboard: `G` graph, `L` list, `F` film mode, `Esc` clear selection.

Film mode hides the panels and controls, slowly orbits the graph and captions it with what is in range now.

## License

[MIT](LICENSE)
