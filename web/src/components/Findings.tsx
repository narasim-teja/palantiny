import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { ShapeIcon } from "./ShapeIcon";
import type { DeviceView, Finding, PlaceView } from "@core/types";
import { placeName, shapeFor } from "@/lib/view";

const SEVERITY = { high: "High", medium: "Review", note: "Note" } as const;
const VISIBLE_DEVICES = 6;

interface Props {
  findings: Finding[];
  places: PlaceView[];
  devices: DeviceView[];
  selectedId: number | null;
  onSelect: (id: number) => void;
}

interface Group {
  key: string;
  severity: Finding["severity"];
  title: string;
  members: Finding[];
}

/** Five tags with the same finding are one thing to read, with five things to open. */
function group(findings: Finding[]): Group[] {
  const groups = new Map<string, Group>();
  for (const finding of findings) {
    const key = `${finding.severity}:${finding.title}`;
    const existing = groups.get(key);
    if (existing) existing.members.push(finding);
    else groups.set(key, { key, severity: finding.severity, title: finding.title, members: [finding] });
  }
  return [...groups.values()];
}

export function Findings({ findings, places, devices, selectedId, onSelect }: Props) {
  const names = new Map(places.map((place) => [place.id, placeName(place)]));
  const byId = new Map(devices.map((device) => [device.id, device]));
  const inRange = (finding: Finding) => (byId.get(finding.deviceId)?.live ? 1 : 0);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const expand = (key: string) => setExpanded((current) => new Set(current).add(key));
  return (
    <section className="section findings" aria-labelledby="findings-title">
      <div className="section-head">
        <h2 className="section-title" id="findings-title">Findings</h2>
        <span className="count">{findings.length}</span>
      </div>
      {findings.length === 0 ? (
        <p className="quiet">
          Nothing to review. A finding appears when an unclaimed device turns up at two of your places, or when a tracker is nearby.
        </p>
      ) : (
        <ul className="finding-list">
          <AnimatePresence initial={false}>
            {group(findings).map((entry) => {
              const tone = entry.severity === "high" ? "var(--alert)" : "var(--ink)";
              const first = entry.members[0];
              const placeIds = [...new Set(entry.members.flatMap((member) => member.placeIds))];
              // What's here now comes first, because that's what you can still go and look for.
              const members = [...entry.members].sort((a, b) => inRange(b) - inRange(a));
              const shown = expanded.has(entry.key) ? members : members.slice(0, VISIBLE_DEVICES);
              const hidden = members.length - shown.length;
              return (
                <motion.li
                  key={entry.key}
                  className="finding"
                  data-severity={entry.severity}
                  layout="position"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                >
                  <ShapeIcon shape={shapeFor(byId.get(first?.deviceId ?? 0)?.class ?? "unknown")} fill={tone} stroke={tone} />
                  <h3 className="finding-title">{entry.title}</h3>
                  <div className="finding-devices">
                    {shown.map((member) => (
                      <button
                        key={member.id}
                        className="chip"
                        aria-current={member.deviceId === selectedId}
                        onClick={() => onSelect(member.deviceId)}
                      >
                        {member.deviceCode}
                      </button>
                    ))}
                    {hidden > 0 && (
                      <button className="chip chip-more" onClick={() => expand(entry.key)}>
                        {hidden} more
                      </button>
                    )}
                  </div>
                  <p className="finding-meta">
                    <span>{placeIds.map((id) => names.get(id) ?? "An older place").join(", ")}</span>
                    <span className="severity">{SEVERITY[entry.severity]}</span>
                  </p>
                </motion.li>
              );
            })}
          </AnimatePresence>
        </ul>
      )}
    </section>
  );
}
