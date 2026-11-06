import { useState } from "react";
import type { PlaceView } from "@core/types";
import { ago } from "@/lib/view";

interface Props {
  places: PlaceView[];
  now: number;
  onRename: (placeId: number, label: string) => Promise<void>;
}

export function Places({ places, now, onRename }: Props) {
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");

  const save = async (id: number) => {
    setEditing(null);
    await onRename(id, draft);
  };

  return (
    <section className="section" aria-labelledby="places-title">
      <div className="section-head">
        <h2 className="section-title" id="places-title">Places</h2>
        <span className="count">{places.length}</span>
      </div>
      {places.length === 0 && (
        <p className="quiet">Your first place appears after two matching Wi-Fi scans, about a minute after listening starts.</p>
      )}
      <ul>
        {places.map((place) => (
          <li className="place-row" key={place.id}>
            {editing === place.id ? (
              <input
                className="place-input"
                aria-label={`Name for ${place.code}`}
                value={draft}
                maxLength={40}
                autoFocus
                onChange={(event) => setDraft(event.target.value)}
                onBlur={() => void save(place.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void save(place.id);
                  if (event.key === "Escape") setEditing(null);
                }}
              />
            ) : (
              <div className="place-name">
                <span className={place.label ? undefined : "data"}>{place.label ?? place.code}</span>
                {place.current && <span className="here">Here now</span>}
              </div>
            )}
            <button
              className="link-btn"
              aria-label={`Rename ${place.label ?? place.code}`}
              onClick={() => {
                setDraft(place.label ?? "");
                setEditing(place.id);
              }}
            >
              Rename
            </button>
            <span className="quiet" style={{ gridColumn: "1 / -1" }}>
              {place.deviceCount} devices, {place.networkCount} networks
              {!place.current && `, ${ago(place.lastSeen, now)}`}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
