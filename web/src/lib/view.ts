import type { DeviceClass, DeviceView, Finding, PlaceView, Snapshot } from "@core/types";

export type Shape = "circle" | "square" | "diamond" | "triangle";

/** Object type is always carried by shape, so it never depends on seeing colour. */
export function shapeFor(deviceClass: DeviceClass): Shape {
  if (deviceClass === "tag") return "diamond";
  if (deviceClass === "audio" || deviceClass === "wearable") return "square";
  if (deviceClass === "personal") return "circle";
  return "triangle";
}

export const MAX_PLATES = 6;

export function visiblePlaces(places: PlaceView[]): PlaceView[] {
  return places.slice(0, MAX_PLATES);
}

export function placeName(place: PlaceView): string {
  return place.label ?? place.code;
}

export function findingFor(findings: Finding[], deviceId: number): Finding | undefined {
  return findings.find((finding) => finding.deviceId === deviceId);
}

export function deviceTitle(device: DeviceView): string {
  return device.name ?? device.code;
}

export function ago(from: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - from) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** The compact form for dense lists. */
export function shortAgo(from: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - from) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

/** Newest first, leaving out paired devices that have never been heard here. */
export function arrivals(devices: DeviceView[]): DeviceView[] {
  return devices
    .filter((device) => device.presence.length > 0)
    .sort((a, b) => b.firstSeen - a.firstSeen || b.id - a.id);
}

/** What film mode says on screen: observed facts as plain sentences. */
export function filmCaption(place: PlaceView | undefined, findings: Finding[], devices: DeviceView[]): string[] {
  if (!place) return [];
  // In range now, not the running total, which rotated addresses and passers-by inflate.
  const live = devices.filter((device) => device.live).length;
  const noun = live === 1 ? "device" : "devices";
  const lines = [`${live.toLocaleString()} ${noun} in range at ${placeName(place)}.`];
  const urgent = findings.find((finding) => finding.severity === "high");
  const separated = devices.filter((device) => device.findMy === "separated" && device.live).length;
  if (urgent) lines.push(`${urgent.title}.`);
  else if (separated === 1) lines.push("1 Find My device separated from its owner.");
  else if (separated > 1) lines.push(`${separated} Find My devices separated from their owners.`);
  return lines;
}

export function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function duration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

export function statusLine(snapshot: Snapshot): string {
  const { sensor, bluetooth, location, wifi } = snapshot.status;
  if (sensor === "offline") return "Sensor offline";
  if (sensor === "stale") return "Sensor not responding";
  if (bluetooth === "denied") return "Bluetooth permission needed";
  if (location === "denied") return "Location permission needed";
  if (bluetooth !== "on") return "Waiting for Bluetooth";
  if (wifi === "off") return "Listening, Wi-Fi off";
  return "Listening";
}
