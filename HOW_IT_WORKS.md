# How palantiny works

palantiny turns public radio broadcasts into a small ontology, then asks whether any object in it keeps turning up wherever you go. This is the longer version of the [README](README.md): how each part works, what we measured on real data, and where it falls short.

## The pipeline

```text
Swift sensor  ->  Unix socket  ->  Bun collector  ->  SQLite  ->  Next.js routes  ->  browser
 (listens)        (JSON lines)     (reasons)         (stores)    (SSE, every 3s)     (three.js)
```

There's no hosted backend. The API routes in `app/api/` run inside the local Next.js server, because a browser can't read SQLite or the Bluetooth radio itself.

### Why the sensor is a real app

macOS hides Wi-Fi names and BSSIDs from anything without Location permission, and a bare command-line binary can't reliably hold that permission. In our testing a CLI scan returned 0 names and 0 BSSIDs, and a signed `.app` with Location returned 21 of 30 names and 30 of 30 BSSIDs. So the sensor is a small ad-hoc signed app bundle, launched with `open`, which streams JSON lines over a Unix socket and exits when the collector goes away.

`sensor/build.sh` skips unchanged builds, because a new ad-hoc signature can make macOS ask for permissions again.

## The ontology

The model borrows the shape of Palantir's [objects, links and actions](https://www.palantir.com/docs/foundry/ontology/core-concepts) at a very small scale.

```text
Person  -OWNS->      Device     only ever set by you, or by a paired device
Device  -HAS_ALIAS-> Alias      one rotating Bluetooth identity
Device  -SEEN_AT->   Place      observed through Sightings
Network -SEEN_AT->   Place      Wi-Fi networks are what define a Place
```

The most important decision here is the split between **Device** and **Alias**. What you hear on the air is an alias, and a device is a claim that several aliases are one thing. Keeping them separate means every guess stays visible and can be questioned.

There's only ever one Person: you. A stranger's device stays `DEV-0042`. palantiny doesn't try to work out who anyone is.

## Places without GPS

A Place is a fingerprint of the Wi-Fi around it, stored as salted hashes of BSSIDs, because a raw BSSID can be geolocated.

- A scan matches a known place when at least 35% of its networks overlap.
- A new place needs two agreeing scans in a row, so walking past a coffee shop doesn't create one.

## Why identity is hard

macOS never shows a Bluetooth address. CoreBluetooth gives each peripheral a [UUID specific to your Mac](https://bleak.readthedocs.io/en/stable/backends/macos.html), so an alias in palantiny is that UUID.

Apple devices were [measured in 2019](https://petsymposium.org/popets/2019/popets-2019-0057.php) changing their random address about every 15 minutes. Rotation happens on the sending device, so no log on the receiving side can undo it. Only a device holding the pairing key can connect the addresses, which is why your own paired devices can be recognised and strangers' can't.

### Linking aliases

`lib/inference.ts` links an alias to the one before it only when all of this holds:

- Same place and same advert signature.
- The old alias stopped as the new one started: at most 45 seconds apart, with up to 5 seconds of overlap.
- Mean signal within 8 dB.
- **Exactly one** candidate fits. Two plausible predecessors means no link.

Each link stores a confidence and its evidence, such as "Only matching advert to stop 0s before this one started, 2 dB apart". The score comes from the rule, so it isn't a measured accuracy.

Links need an unbroken handover at one place, so a rotating phone can't be followed from one place to another.

### What can be matched between places

| Device | Why |
|---|---|
| Your paired devices | You own them |
| Gadgets with a fixed address | Fitness bands, earbuds, TVs and smart-home gadgets often never rotate, so their UUID stays the same |
| Separated Find My devices | They broadcast a key that holds for a while |
| Most phones | **Can't be matched.** That's what rotation is for |

We chose not to fingerprint phones through rotation. [Research shows it's possible](https://arxiv.org/pdf/1904.10600), but it's fragile, and it would mean defeating a privacy feature on strangers' phones.

## Find My

Apple manufacturer data carries a series of typed messages, and type `0x12` is [Find My](https://arxiv.org/pdf/2202.11813). The short form means the device is near its owner. The long form carries a public key and means it's [separated](https://arxiv.org/pdf/2606.21067), so `lib/classify.ts` treats a payload of 25 bytes or more as separated, and stores a hash of the key as a stable identity.

"Separated" doesn't mean AirTag. AirPods and other Find My accessories send it too. It also doesn't mean lost, since a device can be separated because its owner stepped out.

## Findings

`lib/findings.ts` only counts a place after 3 minutes there, so one stray advert isn't a sighting. Devices you've claimed or trusted are skipped.

| Finding | Severity |
|---|---|
| Tracker or separated device at 2+ places | High |
| Any other unclaimed device at 2+ places | Review |
| Tracker or separated device at 1 place | Note |

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

**Proven on real data:** sensing, storage, place recognition at one place, identity surviving overnight for fixed-address gadgets, and the console.

**Not proven yet:**

- Following detection across two real places. So far that view has only run on labelled test data.
- Whether alias links are correct. Nothing has checked them against a known device.
- How long a separated key lasts. We saw none past about 15 hours, but coverage had gaps, and a device can simply leave.

## Sources

- [Handoff All Your Privacy](https://petsymposium.org/popets/2019/popets-2019-0057.php), Martin et al., PETS 2019
- [AirGuard](https://arxiv.org/pdf/2202.11813), on Find My advert layout and tracking detection
- [Who Can Find My Devices?](https://arxiv.org/pdf/2103.02282v1.pdf), on Apple's offline finding
- [Snatcher](https://arxiv.org/pdf/2606.21067), on the separated state
- [bleak's macOS backend](https://bleak.readthedocs.io/en/stable/backends/macos.html), on CoreBluetooth UUIDs
- [Apple Developer Forums](https://developer.apple.com/forums/thread/124189), on CoreWLAN and Location
- [Palantir Foundry docs](https://www.palantir.com/docs/foundry/ontology/core-concepts), on the ontology idea
