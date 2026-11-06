import type { DeviceView, Finding } from "./types";

// A place only counts after a few minutes, so one stray advert is not a sighting.
export const MIN_MINUTES_AT_PLACE = 3;

// Separated devices pass by constantly, so one place only earns a note while it's in
// range or if it lingered. Otherwise a busy building fills the list with noise.
export const LINGER_MINUTES = 60;

const SEVERITY_RANK = { high: 0, medium: 1, note: 2 } as const;

function placesCounted(device: DeviceView): number[] {
  return device.presence.filter((p) => p.minutes >= MIN_MINUTES_AT_PLACE).map((p) => p.placeId);
}

function absence(minutes: number): string {
  const hours = Math.round(minutes / 60);
  return hours === 1 ? "an hour" : `${hours} hours`;
}

function lingered(device: DeviceView): boolean {
  return device.presence.some((p) => p.minutes >= LINGER_MINUTES);
}

export function deriveFindings(devices: DeviceView[]): Finding[] {
  const findings: Finding[] = [];

  for (const device of devices) {
    if (device.owner?.self || device.trusted) continue;

    const placeIds = placesCounted(device);
    const name = device.label ?? device.code;

    if (device.watched) {
      const base = {
        deviceId: device.id,
        deviceCode: device.code,
        confidence: device.identityConfidence,
        observed: device.identityConfidence >= 1,
      };
      const arrivals = device.presence.filter(
        (p) => p.minutes >= MIN_MINUTES_AT_PLACE && device.watchedAt !== null && p.firstSeen >= device.watchedAt,
      );
      for (const place of arrivals) {
        findings.push({
          ...base,
          id: `watch-place-${device.id}-${place.placeId}`,
          // Someone you know turning up is worth seeing. A stranger doing it is the whole point.
          severity: device.owner ? "medium" : "high",
          placeIds: [place.placeId],
          title: `${name} turned up at a new place`,
          detail: "You're watching this device, and it wasn't at this place when you started.",
        });
      }
      if (device.back) {
        findings.push({
          ...base,
          id: `watch-back-${device.id}-${device.back.at}`,
          severity: "note",
          placeIds,
          title: `${name} is back after ${absence(device.back.after)}`,
          detail: "Counted only while this Mac was listening, so sleep doesn't make it look longer.",
        });
      }
      if (arrivals.length > 0) continue;
    }

    // You told us whose this is, so it isn't a mystery. It's still worth a mention.
    if (device.owner) {
      if (placeIds.length >= 2) {
        findings.push({
          id: `known-${device.id}`,
          severity: "note",
          deviceId: device.id,
          deviceCode: device.code,
          placeIds,
          confidence: device.identityConfidence,
          observed: device.identityConfidence >= 1,
          title: `${device.owner.label ?? "Someone you know"} seen at ${placeIds.length} places`,
          detail: "You tagged this device, so it isn't a concern.",
        });
      }
      continue;
    }

    const observed = device.identityConfidence >= 1;
    const base = {
      deviceId: device.id,
      deviceCode: device.code,
      placeIds,
      confidence: device.identityConfidence,
      observed,
    };
    const tracker = device.class === "tag";
    const label = device.findMy === "separated" ? "Separated Find My device" : "Possible tracker tag";
    const how = observed
      ? "Same broadcast identity each time."
      : `Identity inferred across ${device.aliasCount} rotating aliases.`;

    if (tracker && placeIds.length >= 2) {
      findings.push({
        ...base,
        id: `tag-multi-${device.id}`,
        severity: "high",
        title: `${label} seen at ${placeIds.length} places`,
        detail: `${how} Check your bag, coat and car. If you find nothing, it may belong to someone you travelled with.`,
      });
    } else if (placeIds.length >= 2) {
      findings.push({
        ...base,
        id: `recurring-${device.id}`,
        severity: "medium",
        title: `${device.classLabel} seen at ${placeIds.length} places`,
        detail: `${how} Your own devices show up here first, so claim it if it's yours.`,
      });
    } else if (tracker && placeIds.length === 1 && (device.live || lingered(device))) {
      findings.push({
        ...base,
        id: `tag-single-${device.id}`,
        severity: "note",
        title: `${label} near one place`,
        detail: "One place is not evidence of following. It could be a neighbour's lost keys.",
      });
    }
  }

  return findings.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      b.placeIds.length - a.placeIds.length ||
      b.confidence - a.confidence,
  );
}
