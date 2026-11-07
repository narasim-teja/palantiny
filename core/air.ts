import type { AirNow, DeviceClass, FindMyState } from "./types";

// A device uses one Find My address at a time, so counting live ones isn't inflated by
// rotation the way the device total is. It's a floor: not everything sends Find My.

/** The Find My status byte's values. AirTag matched a real one held to the Mac. */
const APPLE_DEVICE = 0;
const AIRTAG_LIKE = 1;

export function isAirTagLike(findMyType: number | null): boolean {
  return findMyType === AIRTAG_LIKE;
}

/** Could this be a tag on you? A device that says it's a phone or computer isn't one. */
export function couldBeTracker(device: { class: DeviceClass; findMyType: number | null }): boolean {
  if (device.findMyType === APPLE_DEVICE) return false;
  return isAirTagLike(device.findMyType) || device.class === "tag";
}

export function readAir(live: { findMyType: number | null; findMy: FindMyState }[]): AirNow {
  const findMy = live.filter((alias) => alias.findMyType !== null);
  const tags = findMy.filter((alias) => isAirTagLike(alias.findMyType));
  return {
    findMy: findMy.length,
    airTagLike: {
      nearOwner: tags.filter((alias) => alias.findMy !== "separated").length,
      separated: tags.filter((alias) => alias.findMy === "separated").length,
    },
  };
}
