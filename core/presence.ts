// A device going quiet only means something if we were listening at the time, so absence
// is counted in minutes the Mac was awake and hearing things, never on the clock.

/** Long enough to skip weak signals flickering, which on real data happen several times a day. */
export const RETURN_AFTER_MINUTES = 120;
/** How long a return stays worth mentioning. */
export const RETURN_FRESH_MINUTES = 30;

export interface Return {
  /** Listening minutes the device was absent for. */
  after: number;
  /** The minute it came back. */
  at: number;
}

/** Both lists are ascending minutes. Returns the latest long absence, if it just ended. */
export function lastReturn(deviceMinutes: number[], listeningMinutes: number[], nowMinute: number): Return | null {
  const position = new Map(listeningMinutes.map((minute, index) => [minute, index]));
  for (let i = deviceMinutes.length - 1; i > 0; i -= 1) {
    const here = position.get(deviceMinutes[i]!);
    const before = position.get(deviceMinutes[i - 1]!);
    if (here === undefined || before === undefined) continue;
    const absent = here - before - 1;
    if (absent < RETURN_AFTER_MINUTES) continue;
    const at = deviceMinutes[i]!;
    return nowMinute - at <= RETURN_FRESH_MINUTES ? { after: absent, at } : null;
  }
  return null;
}
