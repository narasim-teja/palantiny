// What stopped the moment you did. It needs no trip and no chain.
//
// "Last heard" is only as sharp as the signal is frequent. Find My adverts reach the Mac about
// every 11 seconds, so one phone's two identities ended 9 seconds apart in a Faraday bag, and a
// tag beside it 21 seconds apart. The window therefore comes from each signal's own rate.
// Any strong signal ends within 30 seconds by chance about 11% of the time, and a tag well
// under 1%, on a small sample, which is why only tags raise a finding.
//
// Only your own devices start the clock, so strangers are never compared with each other.

const LEFT_MIN_WINDOW_MS = 5_000;
export const LEFT_MAX_WINDOW_MS = 30_000;
/** Covers an unlucky run of missed adverts. */
const MISSED_ADVERTS = 3;
/** Silence shorter than this is ordinary flicker, and isn't a departure. */
export const SILENCE_MIN_MS = 300_000;
export const LEFT_NEAR_RSSI = -60;
export const LEFT_MIN_ADVERTS = 20;
/**
 * Only something usually heard can say you left. A WHOOP only broadcasts when its phone is out
 * of reach, so its silence means the opposite: that the phone came back.
 */
const STEADY_SHARE = 0.5;
/** Find My addresses change on the quarter hour, so signals ending then have only rotated. */
const QUARTER_MS = 900_000;
const ROTATION_SLACK_MS = 45_000;
/** The Mac has to keep hearing things after you go, or it's the Mac that stopped. */
const LISTENING_AFTER_MINUTES = 3;

export interface Silence {
  deviceId: number;
  from: number;
}

export interface Ended {
  deviceId: number;
  firstSeen: number;
  lastSeen: number;
  /** Its strongest, because walking out drags the average down: a phone fades over minutes. */
  bestRssi: number;
  adverts: number;
}

export interface Left {
  deviceId: number;
  ofDeviceId: number;
  at: number;
}

export function isSteady(heardMinutes: number, listeningMinutes: number): boolean {
  return listeningMinutes > 0 && heardMinutes / listeningMinutes >= STEADY_SHARE;
}

/** How far apart two things that stopped together can look, given how often this one is heard. */
export function windowFor(signal: Ended): number {
  const interval = (signal.lastSeen - signal.firstSeen) / Math.max(signal.adverts, 1);
  return Math.min(LEFT_MAX_WINDOW_MS, Math.max(LEFT_MIN_WINDOW_MS, MISSED_ADVERTS * interval));
}

export function onTheQuarter(ms: number): boolean {
  const offset = ms % QUARTER_MS;
  return offset < ROTATION_SLACK_MS || offset > QUARTER_MS - ROTATION_SLACK_MS;
}

export function macKeptListening(from: number, listening: ReadonlySet<number>): boolean {
  const minute = Math.floor(from / 60_000);
  return Array.from({ length: LISTENING_AFTER_MINUTES }, (_, index) => minute + index + 1).every((next) =>
    listening.has(next),
  );
}

/** Each device's latest departure, if something strong stopped within seconds of yours. */
export function leftTogether(silences: Silence[], ended: Ended[], listening: ReadonlySet<number>): Left[] {
  const left = new Map<number, Left>();
  const usable = silences
    .filter((silence) => !onTheQuarter(silence.from) && macKeptListening(silence.from, listening))
    .sort((a, b) => a.from - b.from);
  for (const silence of usable) {
    for (const signal of ended) {
      if (signal.deviceId === silence.deviceId) continue;
      if (signal.bestRssi < LEFT_NEAR_RSSI || signal.adverts < LEFT_MIN_ADVERTS) continue;
      if (Math.abs(signal.lastSeen - silence.from) > windowFor(signal)) continue;
      left.set(signal.deviceId, { deviceId: signal.deviceId, ofDeviceId: silence.deviceId, at: silence.from });
    }
  }
  return [...left.values()];
}
