import type { AirNow, Exposure as ExposureReport, Visibility } from "@core/types";
import { busiestHour } from "@/lib/view";

const VISIBILITY: Record<Visibility, string> = {
  recognisable: "Recognisable",
  unverified: "Unverified",
  rotating: "Rotating",
};

interface Props {
  exposure: ExposureReport;
  air: AirNow;
  selectedId: number | null;
  onSelect: (id: number) => void;
}

/** The tool turned on you: what a stranger listening nearby could get from your own devices. */
export function Exposure({ exposure, air, selectedId, onSelect }: Props) {
  const busiest = exposure.routine && busiestHour(exposure.routine.hours);
  const source = exposure.items.find((item) => item.deviceId === exposure.routine?.deviceId);
  const tags = air.airTagLike.nearOwner + air.airTagLike.separated;
  const sleeping = exposure.items.find((item) => item.sleepPulse !== null);

  return (
    <section className="section exposure" aria-labelledby="exposure-title">
      <div className="section-head">
        <h2 className="section-title" id="exposure-title">What the air knows</h2>
      </div>
      <p className="quiet">
        About <span className="data">{air.findMy}</span> Find My devices in range, <span className="data">{tags}</span> of
        them AirTag-like.
      </p>
      <p className="quiet">{exposure.statement}</p>
      {busiest && source && (
        <p className="quiet">
          {source.title} is heard most around <span className="data">{busiest.hour}</span>, in{" "}
          <span className="data">{busiest.share}%</span> of listening minutes. A stranger could log that too.
        </p>
      )}
      {exposure.echoes.map((echo) => (
        <p className="quiet" key={echo.title}>
          Your {echo.title} also shows as <span className="data">{echo.identities}</span> rotating{" "}
          {echo.identities === 1 ? "identity" : "identities"}. Timing alone followed it through{" "}
          <span className="data">{echo.addressChanges}</span> address changes.
        </p>
      ))}
      {sleeping && (
        <p className="quiet">
          {sleeping.title} has dropped to bursts about every <span className="data">{sleeping.sleepPulse}</span> minutes,
          the pattern seen when a Mac goes to sleep.
        </p>
      )}
      {exposure.items.length > 0 && (
        <ul>
          {exposure.items.map((item) => (
            <li key={item.deviceId}>
              <button
                className="exposure-row"
                title={item.reason}
                aria-current={item.deviceId === selectedId}
                onClick={() => onSelect(item.deviceId)}
              >
                <span className="arrival-name">{item.title}</span>
                <span className="arrival-class">{VISIBILITY[item.visibility]}</span>
                <span className="arrival-age">{Math.round(item.heardShare * 100)}%</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
