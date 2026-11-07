import type { DeviceClass, DeviceReading, DeviceView, PersonPresence, PersonReach, PresenceState } from "./types";
import { MIN_MINUTES_AT_PLACE } from "./findings";

// Devices are what we hear, and people are what you want to know about. This reads one
// from the other, and refuses to when the evidence can't carry it. Everything here is
// relative to this Mac: it can say a device is in range, never where anyone is otherwise.

/** Less history than this can't say what normal silence looks like for a device. */
export const MIN_HEARD_MINUTES = 20;
/**
 * Silence only counts past max(20, 3 x the device's 99th percentile gap). Replayed on real
 * data (learn from the first half, score the second), this called a device gone about 5
 * times where a flat 20 minutes called it about 30. It's a small sample. See `bun run replay`.
 */
export const QUIET_FLOOR_MINUTES = 20;
const QUIET_SPREAD = 3;

const STAYS_PUT: DeviceClass[] = ["media", "home", "beacon"];

export function isCarried(device: DeviceView): boolean {
  return !STAYS_PUT.includes(device.class);
}

/** Only an identity that survives a break can prove anything by staying silent. */
function recognisable(device: DeviceView): boolean {
  return device.stability === "stable" || device.stability === "named";
}

/** `heard` is ascending positions in the list of listening minutes. */
export function quietLimit(heard: number[]): number | null {
  if (heard.length < MIN_HEARD_MINUTES) return null;
  const gaps = heard
    .slice(1)
    .map((position, index) => position - heard[index]! - 1)
    .sort((a, b) => a - b);
  const usual = gaps[Math.floor(gaps.length * 0.99)] ?? 0;
  return Math.max(QUIET_FLOOR_MINUTES, QUIET_SPREAD * usual);
}

export function readDevice(device: DeviceView, heardMinutes: number[], listening: number[]): DeviceReading {
  const position = new Map(listening.map((minute, index) => [minute, index]));
  const heard = heardMinutes.flatMap((minute) => position.get(minute) ?? []);
  const last = heard.at(-1);
  const silent = last === undefined ? 0 : listening.length - 1 - last;
  const limit = quietLimit(heard);
  const carried = isCarried(device);

  let state: PresenceState = "unknown";
  if (device.live) state = "in-range";
  else if (carried && limit !== null && silent < limit) state = "quiet";
  // A rotating device may be right here under a new address, so its silence proves nothing.
  else if (carried && limit !== null && recognisable(device)) state = "gone";

  return {
    deviceId: device.id,
    code: device.code,
    title: device.label ?? device.classLabel,
    state,
    carried,
    silent,
    quietLimit: limit,
  };
}

function reachOf(carried: DeviceView[]): PersonReach {
  if (carried.length === 0) return "none";
  return carried.some(recognisable) ? "anywhere" : "local";
}

function span(minutes: number): string {
  if (minutes < 90) return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.round(minutes / 60);
  return `${hours} ${hours === 1 ? "hour" : "hours"}`;
}

function statementFor(state: PresenceState, readings: DeviceReading[], reach: PersonReach, listening: boolean): string {
  if (!listening) return "This Mac isn't listening, so it can't say.";
  if (reach === "none") return "Only tagged to things that stay put, which says nothing about them.";

  if (state === "in-range") {
    const here = readings.filter((reading) => reading.state === "in-range" && reading.carried);
    return here.length === 1
      ? `${here[0]!.title} in range. That places the device here, not the person.`
      : `${here.length} of their devices in range.`;
  }
  if (state === "quiet") {
    const closest = readings.filter((reading) => reading.state === "quiet").sort((a, b) => a.silent - b.silent)[0]!;
    return `Quiet for ${span(closest.silent)}, which is normal for ${closest.title}.`;
  }
  if (state === "gone") {
    const latest = readings.filter((reading) => reading.state === "gone").sort((a, b) => a.silent - b.silent)[0]!;
    return `Not heard for ${span(latest.silent)} of listening, so ${latest.title} isn't near this Mac.`;
  }
  return reach === "local"
    ? "Their devices rotate, so silence can't tell gone from a new address."
    : "Too little history to know what silence means yet.";
}

/** The strongest thing any carried device can support. */
function overall(readings: DeviceReading[]): PresenceState {
  const carried = readings.filter((reading) => reading.carried);
  for (const state of ["in-range", "quiet", "gone"] as const) {
    if (carried.some((reading) => reading.state === state)) return state;
  }
  return "unknown";
}

/**
 * Reads the people you've tagged. It works from the same views a client gets, so someone
 * with no public name can't appear on a recording. You aren't in here: see core/exposure.ts.
 */
export function readPeople(
  devices: DeviceView[],
  heard: ReadonlyMap<number, number[]>,
  listeningMinutes: number[],
  listening: boolean,
): PersonPresence[] {
  const byPerson = new Map<string, DeviceView[]>();
  for (const device of devices) {
    if (!device.owner || device.owner.self || !device.owner.label) continue;
    byPerson.set(device.owner.code, [...(byPerson.get(device.owner.code) ?? []), device]);
  }

  const rank: Record<PresenceState, number> = { "in-range": 0, quiet: 1, gone: 2, unknown: 3 };
  return [...byPerson]
    .map(([code, owned]): PersonPresence => {
      const readings = owned.map((device) => readDevice(device, heard.get(device.id) ?? [], listeningMinutes));
      const carried = owned.filter(isCarried);
      const reach = reachOf(carried);
      const state = listening ? overall(readings) : "unknown";
      const places = carried.flatMap((device) =>
        device.presence.filter((place) => place.minutes >= MIN_MINUTES_AT_PLACE).map((place) => place.placeId),
      );
      return {
        code,
        label: owned[0]!.owner!.label!,
        state,
        reach,
        statement: statementFor(state, readings, reach, listening),
        lastHeard: carried.length > 0 ? Math.max(...carried.map((device) => device.lastSeen)) : null,
        placeIds: [...new Set(places)],
        devices: readings,
      };
    })
    .sort((a, b) => rank[a.state] - rank[b.state] || (b.lastHeard ?? 0) - (a.lastHeard ?? 0));
}
