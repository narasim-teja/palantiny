import { ShapeIcon } from "./ShapeIcon";
import type { DeviceView } from "@core/types";
import { deviceTitle, shapeFor, shortAgo } from "@/lib/view";

interface Props {
  devices: DeviceView[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  now: number;
}

function ownerName(device: DeviceView): string {
  if (device.owner?.self) return "You";
  return device.owner?.label ?? "Someone you know";
}

/** The devices you've put a name to. What's here right now comes first. */
export function Known({ devices, selectedId, onSelect, now }: Props) {
  const rows = devices
    .filter((device) => device.owner !== null)
    .sort((a, b) => Number(b.live) - Number(a.live) || b.lastSeen - a.lastSeen);

  return (
    <section className="section known" aria-labelledby="known-title">
      <div className="section-head">
        <h2 className="section-title" id="known-title">Known devices</h2>
        <span className="count">{rows.length}</span>
      </div>
      {rows.length === 0 ? (
        <p className="quiet">Nothing tagged yet. Select a device and press M to claim it.</p>
      ) : (
        <ul>
          {rows.map((device) => (
            <li key={device.id}>
              <button className="arrival" aria-current={device.id === selectedId} onClick={() => onSelect(device.id)}>
                <ShapeIcon
                  shape={shapeFor(device.class)}
                  fill={device.live ? "currentColor" : "none"}
                  stroke="currentColor"
                />
                <span className="arrival-name">{deviceTitle(device)}</span>
                <span className="arrival-class">{ownerName(device)}</span>
                <span className="arrival-age">{device.live ? "here" : shortAgo(device.lastSeen, now)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
