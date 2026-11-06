import type { Database } from "bun:sqlite";
import type { Finding } from "@core/types";
import { getMeta, setMeta } from "./db";
import { buildSnapshot } from "./snapshot";

const CHECK_MS = 30_000;
const MAX_REMEMBERED = 1_000;
const SEEN_KEY = "alerts.seen";

/** Only what you'd want to be interrupted for: anything serious, and anything you asked to watch. */
export function alertable(finding: Finding): boolean {
  return finding.severity === "high" || finding.id.startsWith("watch-");
}

export function unseen(findings: Finding[], seen: ReadonlySet<string>): Finding[] {
  return findings.filter((finding) => alertable(finding) && !seen.has(finding.id));
}

async function notify(title: string, body: string): Promise<void> {
  // Passed as arguments, never inside the script, because names here are user text.
  await Bun.spawn(
    [
      "osascript",
      "-e", "on run argv",
      "-e", "display notification (item 2 of argv) with title (item 1 of argv)",
      "-e", "end run",
      title,
      body,
    ],
    { stdout: "ignore", stderr: "ignore" },
  ).exited;
}

/** Sends macOS notifications, so you find out without the console open. */
export function startAlerts(db: Database): () => void {
  const saved = getMeta(db, SEEN_KEY);
  // Starting for the first time shouldn't announce everything already on the list.
  let seen: Set<string> | null = saved ? new Set(JSON.parse(saved) as string[]) : null;

  const check = () => {
    // Screenshot-safe on purpose: a notification can appear on a lock screen or a recording.
    const { findings } = buildSnapshot(db, false);
    const fresh = seen ? unseen(findings, seen) : [];
    seen ??= new Set(findings.filter(alertable).map((finding) => finding.id));
    for (const finding of fresh) {
      seen.add(finding.id);
      void notify("palantiny", finding.title);
    }
    setMeta(db, SEEN_KEY, JSON.stringify([...seen].slice(-MAX_REMEMBERED)));
  };

  check();
  const timer = setInterval(check, CHECK_MS);
  return () => clearInterval(timer);
}
