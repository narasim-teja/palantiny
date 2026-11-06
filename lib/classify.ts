import type { DeviceClass, FindMyState } from "./types";

// Reads what a Bluetooth advert says about itself. These are reverse-engineered
// formats, so every label here is a best guess about the hardware, never a fact
// about the person carrying it.

const COMPANIES: Record<number, string> = {
  0x0006: "Microsoft",
  0x004c: "Apple",
  0x0059: "Nordic Semiconductor",
  0x0075: "Samsung",
  0x0087: "Garmin",
  0x009e: "Bose",
  0x00e0: "Google",
  0x012d: "Sony",
  0x0157: "Huami",
  0x0171: "Amazon",
  0x02e5: "Espressif",
  0x038f: "Xiaomi",
  0x067c: "Tile",
};

const SERVICE_HINTS: Record<string, { class: DeviceClass; vendor?: string }> = {
  FD5A: { class: "tag", vendor: "Samsung" },
  FEED: { class: "tag", vendor: "Tile" },
  FEEC: { class: "tag", vendor: "Tile" },
  FCB2: { class: "tag" },
  FE2C: { class: "audio", vendor: "Google" },
  FD6F: { class: "personal" },
};

const APPLE_TYPE_CLASS: Record<number, DeviceClass> = {
  0x02: "beacon",
  0x06: "home",
  0x07: "audio",
  0x09: "media",
  0x0a: "media",
  0x0c: "personal",
  0x10: "personal",
  0x12: "personal",
};

// When one device sends several message types, the most specific one wins.
const CLASS_PRIORITY: DeviceClass[] = [
  "tag",
  "audio",
  "wearable",
  "media",
  "home",
  "beacon",
  "personal",
  "unknown",
];

export interface AdvertInput {
  mfr?: string;
  svc?: string[];
}

export interface AdvertFacts {
  company: number | null;
  vendor: string | null;
  appleTypes: number[];
  findMy: FindMyState;
  /** Hex key material of a separated Find My device. Hash it before storing. */
  findMyKey: string | null;
  class: DeviceClass;
  /** Coarse shape of the advert, used to judge whether two aliases could be one device. */
  signature: string;
}

function hexToBytes(hex: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i + 1 < hex.length; i += 2) {
    const byte = Number.parseInt(hex.slice(i, i + 2), 16);
    if (Number.isNaN(byte)) return [];
    bytes.push(byte);
  }
  return bytes;
}

interface AppleMessage {
  type: number;
  data: number[];
}

/** Apple manufacturer data is a run of [type, length, ...data] messages. */
export function parseAppleMessages(payload: number[]): AppleMessage[] {
  const messages: AppleMessage[] = [];
  let i = 0;
  while (i + 1 < payload.length) {
    const type = payload[i]!;
    const length = payload[i + 1]!;
    const data = payload.slice(i + 2, i + 2 + length);
    messages.push({ type, data });
    i += 2 + length;
  }
  return messages;
}

// A separated Find My device sends the long form with its public key.
// Near its owner it sends a 2-byte short form.
const FIND_MY_TYPE = 0x12;
const FIND_MY_LONG_FORM = 25;

export function parseAdvert(input: AdvertInput): AdvertFacts {
  const bytes = input.mfr ? hexToBytes(input.mfr) : [];
  const company = bytes.length >= 2 ? bytes[0]! | (bytes[1]! << 8) : null;
  const classes = new Set<DeviceClass>();
  let vendor = company === null ? null : (COMPANIES[company] ?? null);
  let findMy: FindMyState = null;
  let findMyKey: string | null = null;
  const appleTypes: number[] = [];

  if (company === 0x004c) {
    for (const message of parseAppleMessages(bytes.slice(2))) {
      appleTypes.push(message.type);
      const mapped = APPLE_TYPE_CLASS[message.type];
      if (mapped) classes.add(mapped);
      if (message.type !== FIND_MY_TYPE) continue;
      if (message.data.length >= FIND_MY_LONG_FORM) {
        findMy = "separated";
        findMyKey = message.data
          .slice(1, 23)
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("");
        classes.add("tag");
      } else if (findMy === null) {
        findMy = "near-owner";
      }
    }
  }

  const services = (input.svc ?? []).map((uuid) => uuid.toUpperCase());
  for (const uuid of services) {
    const hint = SERVICE_HINTS[uuid];
    if (!hint) continue;
    classes.add(hint.class);
    vendor ??= hint.vendor ?? null;
  }

  const resolved = CLASS_PRIORITY.find((candidate) => classes.has(candidate)) ?? "unknown";
  const types = [...new Set(appleTypes)].sort((a, b) => a - b);
  const signature = [
    company === null ? "none" : company.toString(16),
    types.map((type) => type.toString(16)).join("."),
    [...services].sort().join("."),
  ].join("|");

  return { company, vendor, appleTypes: types, findMy, findMyKey, class: resolved, signature };
}

export function classLabel(deviceClass: DeviceClass, findMy: FindMyState): string {
  if (findMy === "separated") return "Find My device, separated from owner";
  if (deviceClass === "tag") return "Possible tracker tag";
  if (findMy === "near-owner") return "Find My device, near owner";
  const labels: Record<DeviceClass, string> = {
    tag: "Possible tracker tag",
    personal: "Phone, tablet or computer",
    audio: "Headphones or earbuds",
    wearable: "Wearable",
    media: "TV or speaker",
    home: "Smart home device",
    beacon: "Beacon",
    unknown: "Unidentified device",
  };
  return labels[deviceClass];
}

/** Keeps the most specific class seen across a device's adverts. */
export function mergeClass(a: DeviceClass, b: DeviceClass): DeviceClass {
  return CLASS_PRIORITY.indexOf(a) <= CLASS_PRIORITY.indexOf(b) ? a : b;
}
