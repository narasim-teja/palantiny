// Every device gets a fixed two-word callsign, so it can be remembered and talked about
// without saying anything about who owns it. It comes only from the device's row id.

const ADJECTIVES = [
  "Amber", "Ashen", "Azure", "Birch", "Bright", "Bronze", "Brisk", "Calm", "Cedar", "Chalk",
  "Clear", "Cobalt", "Copper", "Coral", "Crisp", "Dawn", "Deep", "Distant", "Dusk", "Dusty",
  "Early", "Ember", "Faint", "Fallow", "Far", "Fern", "Fleet", "Flint", "Foggy", "Frost",
  "Gentle", "Gilded", "Glass", "Golden", "Granite", "Green", "Grey", "Hazel", "Hidden", "High",
  "Hollow", "Honey", "Indigo", "Inland", "Iron", "Ivory", "Jade", "Juniper", "Keen", "Kindled",
  "Lapis", "Late", "Lean", "Light", "Linen", "Little", "Lone", "Long", "Low", "Lunar",
  "Maple", "Marble", "Mellow", "Mica", "Midnight", "Mild", "Mint", "Misty", "Moss", "Muted",
  "Narrow", "Neon", "Nimble", "Noble", "Northern", "Oaken", "Ochre", "Olive", "Onyx", "Opal",
  "Outer", "Pale", "Paper", "Pearl", "Pine", "Plain", "Polar", "Quartz", "Quick", "Quiet",
  "Rapid", "Raven", "Red", "Reed", "River", "Rough", "Rowan", "Rust", "Sable", "Saffron",
  "Sage", "Salt", "Sandy", "Scarlet", "Sea", "Shaded", "Sienna", "Silent", "Silver", "Slate",
  "Slow", "Smoke", "Soft", "Solar", "Southern", "Spare", "Steady", "Steel", "Still", "Stone",
  "Storm", "Sudden", "Summer", "Swift", "Tawny", "Tidal", "Timber", "Velvet",
];

const NOUNS = [
  "Acorn", "Alder", "Anchor", "Antler", "Arrow", "Aspen", "Atlas", "Badger", "Basin", "Beacon",
  "Beetle", "Bison", "Bluff", "Bracken", "Bridge", "Brook", "Buoy", "Canyon", "Cairn", "Cedar",
  "Cinder", "Cliff", "Clover", "Comet", "Compass", "Condor", "Coyote", "Crane", "Creek", "Crest",
  "Crow", "Current", "Delta", "Drift", "Dune", "Eagle", "Echo", "Egret", "Elk", "Falcon",
  "Fathom", "Fen", "Ferry", "Finch", "Fjord", "Forge", "Fox", "Gale", "Glacier", "Glade",
  "Gorge", "Grove", "Gull", "Harbor", "Hare", "Harrier", "Hawk", "Heath", "Heron", "Hollow",
  "Horizon", "Ibis", "Inlet", "Island", "Jackal", "Jay", "Kestrel", "Kite", "Knoll", "Lagoon",
  "Lantern", "Lark", "Ledge", "Lichen", "Lighthouse", "Lynx", "Magpie", "Marsh", "Marten", "Meadow",
  "Mesa", "Meteor", "Mink", "Moor", "Moth", "Nebula", "Nomad", "Oak", "Orbit", "Orca",
  "Osprey", "Otter", "Owl", "Pass", "Peak", "Pelican", "Pier", "Pine", "Plover", "Prairie",
  "Puffin", "Quail", "Quarry", "Raven", "Reef", "Ridge", "Robin", "Sparrow", "Spruce", "Stag",
  "Starling", "Stork", "Stream", "Summit", "Swallow", "Swift", "Tern", "Thicket", "Thistle", "Tide",
  "Trail", "Tundra", "Valley", "Vole", "Wagtail", "Warbler", "Willow", "Wren",
];

const PAIRS = ADJECTIVES.length * NOUNS.length;
// Coprime with PAIRS, so neighbouring ids land far apart and never repeat within a cycle.
const STRIDE = 7_919;

export function callsign(id: number): string {
  const slot = (id * STRIDE) % PAIRS;
  const adjective = ADJECTIVES[Math.floor(slot / NOUNS.length)]!;
  const noun = NOUNS[slot % NOUNS.length]!;
  const cycle = Math.floor(id / PAIRS);
  return cycle > 0 ? `${adjective} ${noun} ${cycle + 1}` : `${adjective} ${noun}`;
}
