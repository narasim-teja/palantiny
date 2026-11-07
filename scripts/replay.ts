// Scores the inference against recorded data, without touching it. Prints counts only, so
// the output is safe to paste into notes. Use PALANTINY_DB to point at a backup.

import { Database } from "bun:sqlite";
import { contradicted } from "../core/inference";
import { quietLimit } from "../core/person";
import { dbPath } from "../server/db";

const db = new Database(dbPath(), { readonly: true });
const percent = (part: number, whole: number) => (whole === 0 ? "n/a" : `${((part / whole) * 100).toFixed(1)}%`);

// Links. A device uses one address at a time, so an old alias still talking disproves one.
const links = db
  .query(
    `SELECT a.link_confidence AS confidence, a.first_seen AS firstSeen, p.last_seen AS predecessorLastSeen
     FROM aliases a JOIN aliases p ON p.id = a.predecessor_id`,
  )
  .all() as { confidence: number; firstSeen: number; predecessorLastSeen: number }[];
const retracted = Number(
  (db.query("SELECT value FROM meta WHERE key = 'links.retracted'").get() as { value: string } | null)?.value ?? 0,
);
const broken = links.filter((link) => contradicted(link.predecessorLastSeen, link.firstSeen));
console.log(`Links: ${links.length} held, ${broken.length} contradicted (${percent(broken.length, links.length)}), ${retracted} retracted so far`);
const made = links.length + retracted;
console.log(`Of every link ever made, ${percent(broken.length + retracted, made)} were taken back or are contradicted. Links still held aren't proven right.`);

const buckets = [...new Set(links.map((link) => link.confidence.toFixed(2)))].sort();
for (const bucket of buckets) {
  const group = links.filter((link) => link.confidence.toFixed(2) === bucket);
  const bad = group.filter((link) => contradicted(link.predecessorLastSeen, link.firstSeen));
  console.log(`  rule score ${bucket}: ${group.length} links, ${percent(bad.length, group.length)} contradicted`);
}

// Silence. Learn each device's limit from the first half, then score the second half.
const listening = (db.query("SELECT DISTINCT minute FROM sightings ORDER BY minute").all() as { minute: number }[]).map(
  (row) => row.minute,
);
const position = new Map(listening.map((minute, index) => [minute, index]));
const half = Math.floor(listening.length / 2);
const days = (listening.length - half) / 1440;
const steady = db
  .query("SELECT device_id AS id FROM aliases GROUP BY device_id HAVING MAX(last_seen - first_seen) >= 7200000")
  .all() as { id: number }[];
const heardQuery = db.query(
  "SELECT DISTINCT s.minute FROM sightings s JOIN aliases a ON a.id = s.alias_id WHERE a.device_id = ? ORDER BY s.minute",
);
const series = steady
  .map(({ id }) => (heardQuery.all(id) as { minute: number }[]).map((row) => position.get(row.minute)!))
  .filter((heard) => heard.length >= 100);

function score(limitFor: (train: number[]) => number | null) {
  let calls = 0;
  let backSoon = 0;
  let devices = 0;
  for (const heard of series) {
    const train = heard.filter((at) => at < half);
    const test = heard.filter((at) => at >= half);
    const limit = limitFor(train);
    if (limit === null || test.length < 2) continue;
    devices += 1;
    for (let index = 1; index < test.length; index += 1) {
      const gap = test[index]! - test[index - 1]! - 1;
      if (gap < limit) continue;
      calls += 1;
      if (gap < limit + 30) backSoon += 1;
    }
  }
  return { calls, backSoon, devices };
}

console.log(`\nSilence: ${series.length} steady devices, ${listening.length} listening minutes, second half is ${days.toFixed(2)} days`);
for (const [name, rule] of [
  ["flat 20 minutes", () => 20],
  ["flat 60 minutes", () => 60],
  ["quietLimit", quietLimit],
] as const) {
  const { calls, backSoon, devices } = score(rule);
  console.log(`  ${name}: ${calls} "gone" calls across ${devices} devices, ${backSoon} back within 30 minutes`);
}
