import type { DeviceClass } from "./types";

// Many gadgets say what they are in their broadcast name. This keeps the type and drops
// the rest, so "WHOOP 5A00000000" becomes "WHOOP band" and is safe to show on a recording.

export interface Recognised {
  kind: string;
  class: DeviceClass;
}

const RULES: [RegExp, Recognised][] = [
  [/^whoop\b/i, { kind: "WHOOP band", class: "wearable" }],
  [/galaxy watch/i, { kind: "Galaxy Watch", class: "wearable" }],
  [/\bfitbit\b/i, { kind: "Fitbit", class: "wearable" }],
  [/\bgarmin\b|\bforerunner\b|\bfenix\b/i, { kind: "Garmin watch", class: "wearable" }],
  [/\boura\b/i, { kind: "Oura ring", class: "wearable" }],
  [/galaxy buds/i, { kind: "Galaxy Buds", class: "audio" }],
  [/airpods/i, { kind: "AirPods", class: "audio" }],
  [/\bbeats\b/i, { kind: "Beats headphones", class: "audio" }],
  [/\bbose\b/i, { kind: "Bose audio", class: "audio" }],
  [/\bjbl\b/i, { kind: "JBL audio", class: "audio" }],
  [/\bjlab\b/i, { kind: "JLab earbuds", class: "audio" }],
  [/\bsony\b|\bwh-1000|\bwf-1000/i, { kind: "Sony audio", class: "audio" }],
  [/\bsonos\b/i, { kind: "Sonos speaker", class: "media" }],
  [/\[tv\]|\bcrystal uhd\b|\boled\b|\bqled\b|\bbravia\b|\broku\b|\bfire tv\b|\bchromecast\b/i, { kind: "TV", class: "media" }],
  [/\bvertuo\b|\bnespresso\b/i, { kind: "Coffee machine", class: "home" }],
  [/^ihoment|^gvh\d|\bgovee\b/i, { kind: "Govee smart device", class: "home" }],
  [/\bprinter\b|\bdeskjet\b|\bofficejet\b|\blaserjet\b/i, { kind: "Printer", class: "home" }],
];

export function recognise(name: string | null): Recognised | null {
  if (!name) return null;
  return RULES.find(([pattern]) => pattern.test(name))?.[1] ?? null;
}

/**
 * True when a name carries something like a serial, so it points at one physical device.
 * "Galaxy Watch Ultra (ABCD)" does. "LE-Bose QC35 II" doesn't: thousands of people own one.
 */
export function isDistinctiveName(name: string): boolean {
  if (/\([0-9A-Z]{4}\)/.test(name)) return true;
  return name.split(/[\s_()-]+/).some((token) => {
    if (token.length < 7 || !/^[0-9A-Za-z]+$/.test(token)) return false;
    return /\d/.test(token) && /[A-Za-z]/.test(token);
  });
}
