import type { DeviceView } from "./types";

/**
 * Everything a device can be found by. It's built from the view the client is allowed to
 * see, so in screenshot mode a hidden name can't be discovered by searching for it.
 */
export function searchText(device: DeviceView): string {
  return [
    device.code,
    device.label,
    device.name,
    device.classLabel,
    device.vendor,
    device.stability,
    device.owner?.label,
    device.owner?.self && "mine yours",
    device.trusted && "trusted",
    device.watched && "watching watched",
    device.live && "in range live now",
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/** Every word has to match, so "galaxy watch" narrows rather than widens. */
export function matches(device: DeviceView, query: string): boolean {
  const text = searchText(device);
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((word) => text.includes(word));
}
