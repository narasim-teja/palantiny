import type { Database } from "bun:sqlite";

// Paired devices are the one honest link from a device to a person: you paired them.

interface ProfilerDevice {
  device_address?: string;
  device_minorType?: string;
}

function classFor(minorType: string | undefined): string {
  const type = (minorType ?? "").toLowerCase();
  if (/headphone|headset|speaker|audio/.test(type)) return "audio";
  if (/phone|computer|tablet/.test(type)) return "personal";
  if (/watch|wearable/.test(type)) return "wearable";
  return "unknown";
}

export async function importPairedDevices(db: Database, now: number): Promise<number> {
  const process = Bun.spawn(["system_profiler", "SPBluetoothDataType", "-json"], {
    stdout: "pipe",
    stderr: "ignore",
    timeout: 45_000,
  });
  const text = await new Response(process.stdout).text();
  if ((await process.exited) !== 0 || !text) return 0;

  const root = JSON.parse(text) as { SPBluetoothDataType?: Record<string, unknown>[] };
  const section = root.SPBluetoothDataType?.[0] ?? {};
  const groups = ["device_connected", "device_not_connected"];
  const self = db.query("SELECT id FROM people WHERE self = 1").get() as { id: number };
  let imported = 0;

  for (const group of groups) {
    const list = (section[group] ?? []) as Record<string, ProfilerDevice>[];
    for (const entry of list) {
      for (const [name, device] of Object.entries(entry)) {
        const existing = db
          .query("SELECT id FROM devices WHERE paired = 1 AND name = ?")
          .get(name) as { id: number } | null;
        if (existing) continue;
        db.query(
          `INSERT INTO devices (class, name, person_id, paired, first_seen, last_seen)
           VALUES (?, ?, ?, 1, ?, ?)`,
        ).run(classFor(device.device_minorType), name, self.id, now, now);
        imported += 1;
      }
    }
  }
  return imported;
}
