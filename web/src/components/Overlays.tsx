import { ShapeIcon } from "./ShapeIcon";
import type { DeviceView, Finding, PlaceView, Snapshot } from "@core/types";
import { filmCaption } from "@/lib/view";

export function Ledger({ totals }: { totals: Snapshot["totals"] }) {
  const rows: [string, number][] = [
    ["Person", totals.people],
    ["Device", totals.devices],
    ["Alias", totals.aliases],
    ["Sighting", totals.sightings],
    ["Place", totals.places],
    ["Network", totals.networks],
  ];
  return (
    <dl className="ledger" aria-label="Objects in the ontology">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          {/* Keyed on the value, so the number only flashes when it really changes. */}
          <dd key={value}>{value.toLocaleString()}</dd>
        </div>
      ))}
    </dl>
  );
}

const KEY = [
  { shape: "circle", label: "Phone or computer" },
  { shape: "square", label: "Audio or wearable" },
  { shape: "diamond", label: "Tag or tracker" },
  { shape: "triangle", label: "Other" },
] as const;

export function GraphKey() {
  return (
    <div className="graph-key">
      <ul aria-label="Marker shapes">
        {KEY.map((row) => (
          <li key={row.shape}>
            <ShapeIcon shape={row.shape} size={10} fill="var(--ink)" stroke="var(--ink)" />
            {row.label}
          </li>
        ))}
      </ul>
      <p>Closer to the centre is a stronger signal. A taller needle was heard for longer. Hollow means not heard right now.</p>
    </div>
  );
}

interface CaptionProps {
  place: PlaceView | undefined;
  findings: Finding[];
  devices: DeviceView[];
}

export function FilmCaption({ place, findings, devices }: CaptionProps) {
  const lines = filmCaption(place, findings, devices);
  if (lines.length === 0) return null;
  return (
    <div className="film-caption">
      {lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </div>
  );
}
