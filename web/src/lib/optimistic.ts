import type { ActionRequest, DeviceView, Snapshot } from "@core/types";

const YOU = { code: "YOU", label: "You", self: true };

/** What a request will do, applied straight away so the console never waits on the server. */
export function applyOptimistic(snapshot: Snapshot, request: ActionRequest): Snapshot {
  if (request.action === "rename-place") {
    const label = request.label.trim() || null;
    return {
      ...snapshot,
      places: snapshot.places.map((place) => (place.id === request.placeId ? { ...place, label } : place)),
    };
  }

  const change = (device: DeviceView): DeviceView => {
    switch (request.action) {
      case "claim":
        return { ...device, owner: YOU };
      case "unclaim":
        return { ...device, owner: null, label: null };
      case "assign":
        return { ...device, owner: { code: "PERSON", label: request.person.trim(), self: false } };
      case "name-device":
        return { ...device, label: request.label.trim() || null };
      case "trust":
      case "untrust":
        return { ...device, trusted: request.action === "trust" };
      case "watch":
      case "unwatch":
        return { ...device, watched: request.action === "watch" };
    }
  };

  return {
    ...snapshot,
    devices: snapshot.devices.map((device) => (device.id === request.deviceId ? change(device) : device)),
  };
}
