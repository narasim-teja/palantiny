import type { DeviceView, PersonPresence, PersonReach, PlaceView, PresenceState } from "@core/types";
import { placeName, shortAgo } from "@/lib/view";

const STATE: Record<PresenceState, string> = {
  "in-range": "In range",
  quiet: "Quiet",
  gone: "Not near",
  unknown: "Can't say",
};

const REACH: Record<PersonReach, string> = {
  anywhere: "Recognisable at other places",
  local: "Lost after a break in signal",
  none: "Nothing they carry is tagged",
};

interface Props {
  presence: PersonPresence[];
  devices: DeviceView[];
  places: PlaceView[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  now: number;
}

function heardAt(person: PersonPresence, places: PlaceView[]): string | null {
  const names = person.placeIds.flatMap((id) => {
    const place = places.find((candidate) => candidate.id === id);
    return place ? [placeName(place)] : [];
  });
  return names.length > 0 ? `Heard at ${names.join(", ")}` : null;
}

/** People you've tagged, read from their devices. It only ever speaks for what's near this Mac. */
export function People({ presence, devices, places, selectedId, onSelect, now }: Props) {
  const hidden = devices.some((device) => device.owner && !device.owner.self && !device.owner.label);

  return (
    <section className="section people" aria-labelledby="people-title">
      <div className="section-head">
        <h2 className="section-title" id="people-title">Near this Mac</h2>
        <span className="count">{presence.length}</span>
      </div>
      {presence.length === 0 ? (
        <p className="quiet">
          {hidden
            ? "People without a public name stay off recordings."
            : "Tag someone's device to see when it's near this Mac."}
        </p>
      ) : (
        <ul>
          {presence.map((person) => {
            const first = person.devices.find((reading) => reading.carried) ?? person.devices[0];
            const place = heardAt(person, places);
            return (
              <li key={person.code}>
                <button
                  className="person"
                  aria-current={person.devices.some((reading) => reading.deviceId === selectedId)}
                  onClick={() => first && onSelect(first.deviceId)}
                >
                  <span className="person-top">
                    <i className="person-mark" data-state={person.state} aria-hidden="true" />
                    <span className="person-name">{person.label}</span>
                    <span className="person-state">{STATE[person.state]}</span>
                    {person.state !== "in-range" && person.lastHeard !== null && (
                      <span className="arrival-age">{shortAgo(person.lastHeard, now)}</span>
                    )}
                  </span>
                  <span className="person-line">{person.statement}</span>
                  <span className="person-line">
                    {REACH[person.reach]}
                    {place && `. ${place}`}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
