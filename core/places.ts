// A Place is recognised from the Wi-Fi networks around it. No GPS, no coordinates.

/** Share of the current scan that must match a known place. */
export const PLACE_MATCH_THRESHOLD = 0.35;

export interface PlaceFingerprint {
  id: number;
  networks: Set<string>;
}

export function overlap(scan: Set<string>, known: Set<string>): number {
  if (scan.size === 0) return 0;
  let shared = 0;
  for (const network of scan) if (known.has(network)) shared += 1;
  return shared / scan.size;
}

export function matchPlace(scan: Set<string>, places: PlaceFingerprint[]): number | null {
  let bestId: number | null = null;
  let bestScore = 0;
  for (const place of places) {
    const score = overlap(scan, place.networks);
    if (score > bestScore) {
      bestScore = score;
      bestId = place.id;
    }
  }
  return bestScore >= PLACE_MATCH_THRESHOLD ? bestId : null;
}

export type PlaceDecision =
  | { kind: "known"; placeId: number }
  | { kind: "new" }
  | { kind: "pending"; pending: Set<string> }
  | { kind: "hold" };

/**
 * Decides where the Mac is after a scan. A new place needs two agreeing scans in a
 * row, so walking past a coffee shop does not create one.
 */
export function decidePlace(
  scan: Set<string>,
  places: PlaceFingerprint[],
  pending: Set<string> | null,
): PlaceDecision {
  if (scan.size === 0) return { kind: "hold" };
  const placeId = matchPlace(scan, places);
  if (placeId !== null) return { kind: "known", placeId };
  if (pending && overlap(scan, pending) >= PLACE_MATCH_THRESHOLD) return { kind: "new" };
  return { kind: "pending", pending: scan };
}

export function placeCode(index: number): string {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const letter = letters[index % 26]!;
  const round = Math.floor(index / 26);
  return `PLACE-${letter}${round > 0 ? round + 1 : ""}`;
}
