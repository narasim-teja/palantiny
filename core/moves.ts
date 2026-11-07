import type { Visit } from "./types";

// Being heard at two places isn't following. A neighbour's gadget can be at home on Monday
// and at the cafe on Friday. What counts is leaving with you and arriving with you.

/** How close to leaving and to arriving it has to be heard. Visits end when the Mac stops listening, so a closed lid doesn't count against it. */
export const TRIP_WINDOW_MINUTES = 30;

export interface Trip {
  from: Visit;
  to: Visit;
}

/** Visits are in time order. A trip is any change of place between two in a row. */
export function tripsOf(visits: Visit[]): Trip[] {
  return visits.slice(1).flatMap((to, index) => {
    const from = visits[index]!;
    return from.placeId === to.placeId ? [] : [{ from, to }];
  });
}

export interface Heard {
  placeId: number;
  minute: number;
}

export function tripsTogether(heard: Heard[], trips: Trip[]): number {
  const window = TRIP_WINDOW_MINUTES * 60_000;
  const heardIn = (placeId: number, start: number, end: number) =>
    heard.some((entry) => {
      const at = entry.minute * 60_000;
      return entry.placeId === placeId && at >= start && at <= end;
    });
  return trips.filter(
    ({ from, to }) =>
      heardIn(from.placeId, Math.max(from.start, from.end - window), from.end) &&
      heardIn(to.placeId, to.start, Math.min(to.end, to.start + window)),
  ).length;
}
