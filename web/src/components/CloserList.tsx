import type { Closer, DeviceView } from "@core/types";
import { deviceTitle } from "@/lib/view";

interface Props {
  closer: Closer[];
  devices: DeviceView[];
  selectedId: number | null;
  onSelect: (id: number) => void;
}

/** Only appears when something jumps, so you can bring a device up to the Mac and find it. */
export function CloserList({ closer, devices, selectedId, onSelect }: Props) {
  const rows = closer.flatMap((entry) => {
    const device = devices.find((candidate) => candidate.id === entry.deviceId);
    return device ? [{ entry, device }] : [];
  });
  if (rows.length === 0) return null;

  return (
    <section className="section closer" aria-labelledby="closer-title">
      <div className="section-head">
        <h2 className="section-title" id="closer-title">Just got closer</h2>
      </div>
      <ul>
        {rows.map(({ entry, device }) => (
          <li key={device.id}>
            <button className="exposure-row" aria-current={device.id === selectedId} onClick={() => onSelect(device.id)}>
              <span className="arrival-name">{deviceTitle(device)}</span>
              <span className="arrival-class">{device.classLabel}</span>
              <span className="arrival-age">{entry.rssi} dBm</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
