import { isAirTagLike } from "./air";
import type { DeviceView, Exposure, ExposureItem, Visibility } from "./types";
import { isCarried } from "./person";

// palantiny can pick some of your neighbours' devices out of the air, so anyone can do the
// same to yours. This turns the tool on you: what would a stranger with a laptop get?
// Only ever your own devices. Nobody else's routine is worked out, on purpose.

const REASONS: Record<Visibility, string> = {
  recognisable: "Keeps one identity, so anyone listening can pick it out again.",
  rotating: "Changes identity, so a stranger loses it.",
  unverified: "Paired with this Mac, which can see through its rotation. A stranger may see less.",
};

function visibilityOf(device: DeviceView): Visibility {
  if (device.paired) return "unverified";
  return device.stability === "stable" || device.stability === "named" ? "recognisable" : "rotating";
}

/** Share of listening minutes it was heard in, for each hour of the day on this Mac's clock. */
export function routineOf(heardMinutes: number[], listeningMinutes: number[]): (number | null)[] {
  const hourOf = (minute: number) => new Date(minute * 60_000).getHours();
  const listened = Array<number>(24).fill(0);
  const heard = Array<number>(24).fill(0);
  for (const minute of listeningMinutes) listened[hourOf(minute)]! += 1;
  for (const minute of heardMinutes) heard[hourOf(minute)]! += 1;
  return listened.map((total, hour) => (total === 0 ? null : heard[hour]! / total));
}

const PULSE_WINDOW_MINUTES = 60;
const PULSE_MAX_SHARE = 0.3;
const PULSE_USUAL_SHARE = 0.6;
const PULSE_MIN_BURSTS = 3;
/** Bursts last up to 4 minutes, so anything longer means it's awake again. */
const AWAKE_AFTER_MINUTES = 5;

/**
 * A sleeping Mac still wakes briefly about every 16 minutes, and that shows on the air. Seen
 * once so far, on a Mac Studio whose owner confirmed it had gone to sleep, so a computer
 * that's usually steady and has dropped to bursts reads as this. Returns the minutes between.
 */
export function sleepPulse(heardMinutes: number[], listeningMinutes: number[]): number | null {
  const start = listeningMinutes.at(-PULSE_WINDOW_MINUTES);
  if (start === undefined || listeningMinutes.length <= PULSE_WINDOW_MINUTES) return null;
  const heard = new Set(heardMinutes);
  if (listeningMinutes.slice(-AWAKE_AFTER_MINUTES).every((minute) => heard.has(minute))) return null;
  const recent = heardMinutes.filter((minute) => minute >= start);
  const earlier = heardMinutes.length - recent.length;
  const usual = earlier / (listeningMinutes.length - PULSE_WINDOW_MINUTES);
  if (recent.length / PULSE_WINDOW_MINUTES > PULSE_MAX_SHARE || usual < PULSE_USUAL_SHARE) return null;

  const bursts = recent.filter((minute, index) => index === 0 || minute - recent[index - 1]! > 3);
  if (bursts.length < PULSE_MIN_BURSTS) return null;
  const gaps = bursts
    .slice(1)
    .map((minute, index) => minute - bursts[index]!)
    .sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)]!;
}

function statementFor(items: ExposureItem[], recognisable: number, unverified: number): string {
  if (items.length === 0) return "Claim your devices to see what they give away.";
  const lead =
    recognisable === 0
      ? `None of your ${items.length} heard devices is proven recognisable.`
      : `${recognisable} of your ${items.length} heard devices can be recognised by anyone listening.`;
  if (unverified === 0) return lead;
  return `${lead} ${unverified} ${unverified === 1 ? "is" : "are"} paired with this Mac, so what strangers see is unverified.`;
}

export function readExposure(
  devices: DeviceView[],
  heard: ReadonlyMap<number, number[]>,
  listeningMinutes: number[],
): Exposure {
  const yours = devices.filter(
    (device) => device.owner?.self && isCarried(device) && (heard.get(device.id)?.length ?? 0) > 0,
  );
  const share = (device: DeviceView) =>
    listeningMinutes.length === 0 ? 0 : (heard.get(device.id)?.length ?? 0) / listeningMinutes.length;

  const order: Record<Visibility, number> = { recognisable: 0, unverified: 1, rotating: 2 };
  const items = yours
    .map((device): ExposureItem => {
      const visibility = visibilityOf(device);
      return {
        deviceId: device.id,
        code: device.code,
        title: device.label ?? device.classLabel,
        visibility,
        reason: REASONS[visibility],
        heardShare: share(device),
        sleepPulse: device.class === "personal" ? sleepPulse(heard.get(device.id) ?? [], listeningMinutes) : null,
      };
    })
    .sort((a, b) => order[a.visibility] - order[b.visibility] || b.heardShare - a.heardShare);

  const count = (visibility: Visibility) => items.filter((item) => item.visibility === visibility).length;
  const recognisable = count("recognisable");
  const unverified = count("unverified");
  // Paired devices are left out: this Mac hears them better than a stranger would.
  const worst = items.find((item) => item.visibility === "recognisable");

  const echoes = new Map<string, Exposure["echoes"][number]>();
  for (const device of devices) {
    // Something that's yours is an echo. An AirTag-like device riding along is a finding instead.
    if (!device.twinOf || isAirTagLike(device.findMyType)) continue;
    const echo = echoes.get(device.twinOf.title) ?? { title: device.twinOf.title, identities: 0, addressChanges: 0 };
    echo.identities += 1;
    echo.addressChanges += Math.max(0, device.aliasCount - 1);
    echoes.set(device.twinOf.title, echo);
  }

  return {
    statement: statementFor(items, recognisable, unverified),
    recognisable,
    unverified,
    rotating: count("rotating"),
    items,
    echoes: [...echoes.values()],
    routine: worst
      ? { deviceId: worst.deviceId, hours: routineOf(heard.get(worst.deviceId) ?? [], listeningMinutes) }
      : null,
  };
}
