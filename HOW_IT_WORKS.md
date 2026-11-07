# How palantiny works

palantiny turns public radio broadcasts into a small ontology, then asks whether any object in it keeps turning up wherever you go. This is the longer version of the [README](README.md): how each part works, what we measured on real data, and where it falls short.

## The pipeline

```text
native/macos  ->  Unix socket  ->  server/         ->  HTTP + SSE  ->  web/
 (listens)        (JSON lines)     Bun + Hono          (/v1)          Vite + React
                                   SQLite, core/                      three.js
```

One Bun process owns the database and everything that touches it. It reads sensor events, runs the inference in `core/`, and serves the API. It runs on your own machine and binds to `127.0.0.1`, so there's nothing to host.

The sensor is the only part that isn't TypeScript, because browsers can't scan Wi-Fi or listen to all nearby Bluetooth. Apple's CoreBluetooth and CoreWLAN do that, automatically and continuously, from a native app: Bluetooth runs all the time, and Wi-Fi scans every 45 seconds.

### Why the sensor is a real app

macOS hides Wi-Fi names and BSSIDs from anything without Location permission, and a bare command-line binary can't reliably hold that permission. In our testing a CLI scan returned 0 names and 0 BSSIDs, and a signed `.app` with Location returned 21 of 30 names and 30 of 30 BSSIDs. So the sensor is a small ad-hoc signed app bundle, launched with `open`, which streams JSON lines over a Unix socket and exits when the server goes away.

`native/macos/build.sh` skips unchanged builds, because a new ad-hoc signature can make macOS ask for permissions again.

## The ontology

The model borrows the shape of Palantir's [objects, links and actions](https://www.palantir.com/docs/foundry/ontology/core-concepts) at a very small scale.

```text
Person  -OWNS->      Device     only ever set by you, or by a paired device
Person  -NEAR->      Mac        read from their devices, never stored
Device  -HAS_ALIAS-> Alias      one rotating Bluetooth identity
Device  -SEEN_AT->   Place      observed through Sightings
Network -SEEN_AT->   Place      Wi-Fi networks are what define a Place
```

The most important decision here is the split between **Device** and **Alias**. What you hear on the air is an alias, and a device is a claim that several aliases are one thing. Keeping them separate means every guess stays visible and can be questioned.

A stranger's device stays a callsign like `Copper Heron`, which comes only from its row in the database. palantiny doesn't try to work out who anyone is. The only people in the ontology are you and anyone you add yourself, and each of them has a public name that replaces their real one on recordings.

## Places without GPS

A Place is a fingerprint of the Wi-Fi around it, stored as salted hashes of BSSIDs, because a raw BSSID can be geolocated.

- A scan matches a known place when at least 35% of its networks overlap.
- A new place needs two agreeing scans in a row, so walking past a coffee shop doesn't create one.

## Why identity is hard

macOS never shows a Bluetooth address. CoreBluetooth gives each peripheral a [UUID specific to your Mac](https://bleak.readthedocs.io/en/stable/backends/macos.html), so an alias in palantiny is that UUID.

Apple devices were [measured in 2019](https://petsymposium.org/popets/2019/popets-2019-0057.php) changing their random address about every 15 minutes. Rotation happens on the sending device, so no log on the receiving side can undo it. Only a device holding the pairing key can connect the addresses, which is why your own paired devices can be recognised and strangers' can't.

### Linking aliases

`core/inference.ts` links an alias to the one before it only when all of this holds:

- Same place and same advert signature.
- The old alias stopped as the new one started: at most 45 seconds apart, with up to 5 seconds of overlap.
- Mean signal within 8 dB.
- **Exactly one** candidate fits. Two plausible predecessors means no link.
- The old alias isn't paired, identified by its own key, or held for 2 hours or more. Those hold their address, so a gap in them isn't a rotation.

Each link stores a rule score and its evidence, such as "Only matching advert to stop 0s before this one started, 2 dB apart". The score comes from the rule and isn't an accuracy, so the console doesn't show it as a percentage.

Links need an unbroken handover at one place, so a rotating phone can't be followed from one place to another.

### Taking links back

A device uses one address at a time, so if the old alias is heard after its successor started, the link was wrong. That gives every link a test that needs no ground truth. On real data **18% of timing links failed it**, and the top rule score still failed 14% of the time, so the scores barely predicted anything. Contradictions took a median of 7 minutes to appear, so waiting longer before linking wouldn't have caught them.

So links are checked again on every pass, and any that's contradicted, or that today's rules would refuse, is taken back. The alias and everything chained after it become a separate device. Tags stay on the original, because a tag must never spread to a stranger. This matters most for you: before this rule, a one-advert stranger could attach itself to a stable gadget when its signal dropped out.

`bun run replay` scores the links and the silence rule on recorded data. A link that's still held isn't proven right, only not yet disproved.

### Linking by name

Some gadgets rotate their address but keep a serial in their name, like `Galaxy Watch Ultra (ABCD)`. `core/recognise.ts` treats a name as distinctive only if it carries something like that, because `LE-Bose QC35 II` is a model thousands of people own. Records with the same distinctive name merge into one device, and unlike timing, this works across places. On real data, one watch went from 18 records to 1.

The same file turns names into safe labels, so a WHOOP shows as "WHOOP band" without its serial, even on recordings.

### Can it be followed?

Every device shows which of these it is, so you know what a match would mean.

| Label | Meaning | Follows between places? |
|---|---|---|
| **Stable** | One identity for 2+ hours, or paired with your Mac | Yes |
| **Named** | Rotates, but keeps a serial in its name | Yes, whenever it broadcasts that name |
| **Keyed** | A separated Find My device | Same day. The [IETF draft](https://datatracker.ietf.org/doc/html/draft-ietf-dult-accessory-protocol-00) has it rotate every 24 hours, and on any change of state |
| **Rotating** | Changes identity | No |
| **New** | Too soon to tell | Not yet known |

The category of gadget doesn't settle this. On real data a Galaxy Watch rotated every 39 minutes or so and could only be followed by its name, a WHOOP held one identity for days, and Fitbits rotated with a name too generic to use. Of 294 unnamed headphone identities, none lasted 2 hours.

### What can be matched between places

| Device | Why |
|---|---|
| Your paired devices | You own them |
| Gadgets with a fixed address | Fitness bands, earbuds, TVs and smart-home gadgets often never rotate, so their UUID stays the same |
| Gadgets with a serial in their name | The address rotates, but the name gives them away |
| Separated Find My devices | They broadcast a key that holds for a while |
| Most phones | **Can't be matched.** That's what rotation is for |

We chose not to fingerprint phones through rotation. [Research shows it's possible](https://arxiv.org/pdf/1904.10600), but it's fragile, and it would mean defeating a privacy feature on strangers' phones.

## From devices to people

You hear devices, but you want to know about people, so `core/person.ts` reads one from the other and refuses when the evidence can't carry it. Everything it says is relative to the Mac. It can say a device is in range, and it can never say where anyone is otherwise. If the Mac stays home while you go out, it's still reporting on the Mac.

| State | Means |
|---|---|
| **In range** | One of their carried devices was heard just now. That places the device, not the person |
| **Quiet** | Not heard, but for no longer than this device usually goes quiet |
| **Not heard** | Silent for far longer than usual, on every device that can show it. It may have left, or be off or charging |
| **Can't say** | The silence means nothing, so no call is made |

Three rules do most of the work:

- **Only carried devices count.** A TV says nothing about its owner.
- **Only a lasting identity can prove absence.** A rotating device may be right here under a new address, so its silence is "can't say", never "not heard".
- **Silence is judged per device.** It has to pass `max(20, 3 × the device's 99th percentile gap)` in minutes the Mac was listening, after at least 20 minutes of history. Replayed on real data, this called a device gone about 5 times where a flat 20 minutes called it about 30, though that's a small sample and a real short trip out looks the same as a flicker.

Each person also has a **reach**, which is the honest answer to "would you know them at a cafe?". It's "anywhere" if they carry a Stable or Named device, and "local" if everything they carry rotates, because then one break in the signal loses them.

Someone with no public name is left out of this view entirely in screenshot mode. palantiny works out no routine or schedule for anyone else, on purpose.

## What the air knows about you

If palantiny can pick out your neighbours' gadgets, a stranger with a laptop can pick out yours. `core/exposure.ts` turns the tool on you, and only on you:

| Label | Means |
|---|---|
| **Recognisable** | Keeps an identity, so anyone listening can pick it out again |
| **Rotating** | Changes identity, so a stranger loses it |
| **Unverified** | Paired with this Mac |

Paired devices are unverified because the Mac holds their pairing key, so what it hears may be better than what a stranger hears. On real data, paired devices held one identifier for 40 hours. Showing that as exposure would be wrong. Settling it needs a second sensor that isn't paired to them.

For your most heard recognisable device, it also works out the hours a stranger could log it in.

It also flags a computer that's dropped to bursts. A Mac that had been heard constantly fell to short bursts about every 16 minutes when it went to sleep, confirmed by its owner, so the air can show when a computer is asleep. That's one event on a paired device, so it isn't known yet what a stranger would see.

## What left with you

When you leave, whatever you're carrying stops at the same moment. `core/together.ts` looks for that, and it needs no trip and no address chain. It records exactly when your own devices go quiet, then looks for strong signals that stopped at the same time.

"Same time" depends on the signal. Find My adverts reach the Mac about every 11 seconds, so "last heard" is only that sharp: in one Faraday bag test, a single iPhone's two identities ended 9 seconds apart, and a tag beside it 21 seconds apart. So each signal gets a window of three of its own advert gaps, up to 30 seconds. Any strong signal ends that close by chance about 11% of the time, and a tag far less often, on a small sample, which is why only tags raise a finding.

It ignores signals that were never strong, moments when the Mac stopped listening, and anything on the quarter hour, because most Find My addresses change then: 103 of 187 started within 30 seconds of one. Strength means a signal's best moment, because leaving drags the average down, and only a device that's usually heard can start the comparison.

That rule comes from a WHOOP. It only broadcast while its phone was out of reach: it started about 12 seconds after a phone went into a Faraday bag, and stopped within 18 seconds of it coming out. So its silence means the phone came back, and its broadcasts show when the phone is away.

It caught a tag live with a bag, where signals cut off at once. A real departure fades over minutes, and that's still unproven with a tag.

## Knowing the Mac moved

Fixed gadgets don't move, so if most of them shift at once, the Mac did. `core/moved.ts` compares the last 3 listening minutes with the 30 before them, and the median shift has to reach 6 dB. Carried to another room, signals shifted about 8 dB within 3 minutes, and came back to about 2 dB when it returned. Normal drift is 1 to 2 dB. Over 46 hours of real data that was the only awake event past the limit, though that's a single real move. A sleep inside the window can't be read either way, so it's ignored.

## What's on the air now

The device total is inflated by rotation, but a device only uses one Find My address at a time, so counting live ones gives a figure rotation can't inflate: on real data about 20, against 60 to 80 identities heard a minute. It's a floor, because not everything sends Find My, and a rotation briefly counts one device twice.

**Just got closer** picks out a device on purpose. Bring something up to the Mac, and anything that jumps 15 dB or more to within -60 dBm appears, along with anything at -50 dBm or stronger. The second rule is there because a rotation can wipe out the earlier signal partway through. Your own devices are left out.

## Moving with you

Two signals that rise and fall together at the same strength are in the same spot, and a rotating address can't hide that. `core/twins.ts` compares the last 4 hours of every device's signal against your own devices. A match needs 30 shared minutes, a rank correlation of 0.9 or more, a gap of 3 dB or less, and for your device to have actually moved. Ranks matter here: with plain correlation, one extreme minute scored a pair 0.94 that really ranked at 0.47.

On real data, 2 of 58 devices matched an iPhone, at 0.94 and 0.95 and within 1 dB. The next best was 0.63 and 19 dB away, so there's a wide empty gap. Both matches were that iPhone's own rotating identities, which also gives a known answer for the timing links: one chain of 7 aliases was right.

That has two uses:

- **Your own echoes.** It shows what your devices look like to everyone else. Rotation didn't protect that iPhone at close range, because timing followed it through every address change.
- **Something riding along.** A tag in your pocket should trace your phone's curve, so this could find one at a single place, with no trip needed. **It hasn't worked yet.** In a real 30 minute test the signals were near the noise floor, around -85 dBm, and the tag only scored about 0.5, which didn't separate it from other pairings. Its 15 minute rotation also broke the chain. It works at close range, and so far not across an apartment.

When the Mac itself moves, everything shifts together, and close devices shift far more than distant ones, so minutes where most signals have jumped are left out before comparing. Without that, a real move made two unrelated signals match at 0.94.

Only your own devices are ever the reference. Strangers are never compared with each other, because that would be working out which of their devices belong together.

## Find My

Apple manufacturer data carries a series of typed messages, and type `0x12` is [Find My](https://arxiv.org/pdf/2202.11813). The short form means the device is near its owner. The long form carries a public key and means it's [separated](https://arxiv.org/pdf/2606.21067), so `core/classify.ts` treats a payload of 25 bytes or more as separated, and stores a hash of the key as a stable identity.

"Separated" doesn't mean AirTag. AirPods and other Find My accessories send it too, and so do Apple devices. The status byte's type bits can narrow it down (`(status & 0x30) >> 4`, where 1 means AirTag in [AirGuard's decoding](https://github.com/seemoo-lab/AirGuard), which matched a real AirTag held to the Mac), so they're kept in the advert signature, which also stops an AirTag being linked to an iPhone. It also doesn't mean lost, since a device can be separated because its owner stepped out.

## Findings

`core/findings.ts` only counts a place after 3 minutes there, so one stray advert isn't a sighting. Devices you've claimed or trusted are skipped.

| Finding | Severity |
|---|---|
| Tracker or separated device at 2+ places | High |
| Any other unclaimed device at 2+ places | Review |
| Tracker or separated device at 1 place, while in range or after 60 minutes there | Note |
| A device you tagged to someone else, at 2+ places | Note |
| A watched stranger at a new place | High |
| A watched device you tagged to someone, at a new place | Review |
| A watched device back after 2+ hours away | Note |
| A tag moving with one of your devices | Review, or Note if you tagged it to someone |
| A tag that went silent within seconds of one of your devices | Review, or Note if you tagged it to someone |

### Coming along

Being heard at two places isn't following, because a neighbour's gadget can be at home on Monday and the cafe on Friday. [AirGuard's field data](https://petsymposium.org/popets/2024/popets-2024-0082.pdf) saw exactly this, and in [BLE-Doubt's small study](https://safe-things-2022.github.io/accepted_papers/safethings2022-final1.pdf) continuity did far better than duration alone. So `core/moves.ts` counts trips: a device came along if it was heard in the last 30 minutes before you left one place and the first 30 minutes after you reached the next.

Visits are measured in listening time, so a closed lid on the way doesn't count against it. Findings state the count, such as "It came along on 2 of 3 trips". It doesn't change severity yet, because it hasn't run on two real places.

## Plugging in

palantiny has two seams, so you can replace either end without touching the middle.

### Write a sensor

Anything that writes these as JSON lines to the server's Unix socket is a sensor. The types are in `core/events.ts`, and malformed lines are dropped.

```jsonc
{ "t": "hello",  "ts": 1793850000000, "v": 1 }
{ "t": "status", "ts": 1793850000000, "bluetooth": "on", "location": "allowed", "wifi": "on" }
{ "t": "ble",    "ts": 1793850000000, "id": "stable-id", "rssi": -60, "name": "Optional", "mfr": "4c0012...", "svc": ["FD5A"] }
{ "t": "wifi",   "ts": 1793850000000, "nets": [{ "ssid": "Cafe", "bssid": "aa:bb:cc:dd:ee:ff", "rssi": -50, "secured": true }] }
```

Keep `id` the same for as long as the sender keeps an address. `mfr` is hex manufacturer data, company ID first. Send a `wifi` event every 30 to 60 seconds, because places are recognised from those.

To run your own, start the server without the macOS app:

```sh
PALANTINY_SENSOR=external bun run server
```

It listens on `data/sensor.sock`, or wherever `PALANTINY_SOCKET` points. Several sensors can connect at once. A Linux sensor on a small always-on board would also solve the lid-closed gap.

### Write a client

The web console only uses this API, so a native app can do everything it does.

| Route | Does |
|---|---|
| `GET /v1/snapshot` | The ontology as JSON, with `presence` for people, `exposure` for you, `air` for what's live, `closer` for signals that just jumped and `moved` when the Mac itself has moved |
| `GET /v1/stream` | The same as server-sent events, every 3 seconds |
| `GET /v1/devices?q=` | Searches every device by name, person, callsign, type or status |
| `GET /v1/devices/:id` | Aliases, sightings and log for one device |
| `POST /v1/actions` | `claim`, `assign`, `name-device`, `trust`, `watch`, `rename-place` and their opposites |

Broadcast names and people's real names are removed unless you add `?reveal=1`. The response types are in `core/types.ts`.

The API is loopback only, and it refuses other hosts and web origins. That means a native app on the same Mac works as it is. A phone app is different, because it would have to reach the Mac over a network, which exposes people's device names. That needs authentication first, and it doesn't exist yet.

Separated devices pass by constantly, so the one-place rule matters. On real data it cut the list from 88 findings to 14.

### Trust and Watch

**Trust** means you know a device, so it never raises a finding. **Watch** means you want to know about it: anything you watch keeps its label on the graph, and raises a finding when it turns up somewhere new or comes back after a long absence.

Absence is counted only in minutes the Mac was listening. A device heard either side of a night with the lid closed hasn't been away at all. The 2 hour threshold comes from replaying real data: at 30 minutes a watched device would fire several times a day from weak signals flickering, and at 2 hours that drops to about one or two.

High findings and anything from Watch also send a macOS notification, using the same names a recording would show, because it can appear on a lock screen. Each one fires once.

## What we measured

One apartment, one MacBook, about 37 hours, with the lid closed overnight.

| | |
|---|---|
| Identities heard | 7,419 |
| Lasted under 15 minutes | 88% |
| Lasted over 24 hours | 31 |
| Separated Find My keys | 124, none lasting past about 15 hours |

- **The running total is misleading.** In one 30-minute window, devices in range held at about 88 to 102 while the device total climbed from 286 to 422. That growth was mostly rotation and passers-by, which is why the console leads with "in range".
- **Fixed identities survive overnight**, even through the Mac sleeping.
- **Stable gadgets were a mix:** TVs, a coffee machine and smart-home gadgets that can't follow anyone, alongside fitness bands, a watch and earbuds that can.
- **Separated devices are common.** A single sighting tells you very little.
- **Scanning mostly stops with the lid closed.** The processes survive and carry on when it opens.

## What's proven and what's not

**Proven on real data:** sensing, storage, place recognition at one place, identity surviving overnight for fixed-address gadgets, finding bad links, and the console.

**Not proven yet:**

- Following detection across two real places. So far that view has only run on labelled test data.
- Whether the alias links still held are correct. Retraction removes the ones that are disproved, but the rest aren't confirmed.
- What "not heard" means for a person. In the one real check, a watch fell silent because it was charging, so silence says nothing about where its owner is.
- Whether paired devices look different to a stranger.
- How long a separated key lasts in practice. The draft spec says 24 hours, and we saw none past about 15, but coverage had gaps and a device can simply leave.

## Sources

- [Handoff All Your Privacy](https://petsymposium.org/popets/2019/popets-2019-0057.php), Martin et al., PETS 2019
- [AirGuard](https://arxiv.org/pdf/2202.11813), on Find My advert layout and tracking detection
- [Who Can Find My Devices?](https://arxiv.org/pdf/2103.02282v1.pdf), on Apple's offline finding
- [Snatcher](https://arxiv.org/pdf/2606.21067), on the separated state
- [IETF DULT accessory protocol draft](https://datatracker.ietf.org/doc/html/draft-ietf-dult-accessory-protocol-00), on how often trackers rotate
- [BLE-Doubt](https://safe-things-2022.github.io/accepted_papers/safethings2022-final1.pdf), on continuity as a sign of following
- [AirGuard's field study](https://petsymposium.org/popets/2024/popets-2024-0082.pdf), PETS 2024
- [Tracking Anonymized Bluetooth Devices](https://petsymposium.org/popets/2019/popets-2019-0036.php), PETS 2019
- [bleak's macOS backend](https://bleak.readthedocs.io/en/stable/backends/macos.html), on CoreBluetooth UUIDs
- [Apple Developer Forums](https://developer.apple.com/forums/thread/124189), on CoreWLAN and Location
- [Palantir Foundry docs](https://www.palantir.com/docs/foundry/ontology/core-concepts), on the ontology idea
