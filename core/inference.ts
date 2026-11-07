// Bluetooth addresses rotate, so one device appears as a chain of short-lived aliases.
// This links an alias to the one that came just before it. It is a guess, which is why
// every link records its confidence and evidence, and why any doubt means no link.

export const HANDOVER_WINDOW_MS = 45_000;
const OVERLAP_TOLERANCE_MS = 5_000;
const MAX_RSSI_GAP = 8;
// Nothing measured here rotates this slowly. On real data, 91% of links to an address held
// this long were later contradicted, because a stable gadget had simply dropped out.
const MAX_ROTATION_MS = 2 * 3_600_000;

export interface AliasFacts {
  id: string;
  deviceId: number;
  placeId: number;
  signature: string;
  firstSeen: number;
  lastSeen: number;
  meanRssi: number;
  hasSuccessor: boolean;
  /** Paired, or identified by its own key, so it never hands over to another alias. */
  firm?: boolean;
}

export interface AliasLink {
  aliasId: string;
  predecessorId: string;
  deviceId: number;
  confidence: number;
  evidence: string;
}

/** A device uses one address at a time, so an old alias still talking disproves the link. */
export function contradicted(predecessorLastSeen: number, aliasFirstSeen: number): boolean {
  return predecessorLastSeen > aliasFirstSeen + OVERLAP_TOLERANCE_MS;
}

type Held = Pick<AliasFacts, "firstSeen" | "lastSeen" | "firm">;

function holdsItsAddress(alias: Held): boolean {
  return alias.firm === true || alias.lastSeen - alias.firstSeen >= MAX_ROTATION_MS;
}

/** Whether a link already made would be refused today, so that old mistakes don't stay. */
export function refuted(predecessor: Held, aliasFirstSeen: number): boolean {
  return holdsItsAddress(predecessor) || contradicted(predecessor.lastSeen, aliasFirstSeen);
}

export function canFollow(candidate: AliasFacts, alias: AliasFacts): boolean {
  if (candidate.id === alias.id || candidate.hasSuccessor) return false;
  if (candidate.deviceId === alias.deviceId) return false;
  if (candidate.placeId !== alias.placeId) return false;
  if (candidate.signature !== alias.signature) return false;
  if (contradicted(candidate.lastSeen, alias.firstSeen)) return false;
  if (alias.firstSeen - candidate.lastSeen > HANDOVER_WINDOW_MS) return false;
  return Math.abs(candidate.meanRssi - alias.meanRssi) <= MAX_RSSI_GAP;
}

export function inferLink(alias: AliasFacts, others: AliasFacts[]): AliasLink | null {
  const candidates = others.filter((candidate) => canFollow(candidate, alias));
  // Two plausible predecessors means we cannot tell them apart. Stay separate.
  if (candidates.length !== 1) return null;

  const predecessor = candidates[0]!;
  // It still counted as a rival above, because the new alias could be its neighbour's.
  if (holdsItsAddress(predecessor)) return null;
  const gapSeconds = Math.max(0, Math.round((alias.firstSeen - predecessor.lastSeen) / 1000));
  const rssiGap = Math.abs(predecessor.meanRssi - alias.meanRssi);
  const confidence = Math.min(
    0.9,
    0.55 + (rssiGap <= 3 ? 0.2 : 0) + (gapSeconds <= 10 ? 0.15 : 0),
  );
  return {
    aliasId: alias.id,
    predecessorId: predecessor.id,
    deviceId: predecessor.deviceId,
    confidence,
    evidence: `Only matching advert to stop ${gapSeconds}s before this one started, ${Math.round(rssiGap)} dB apart`,
  };
}
