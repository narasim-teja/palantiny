import { AnimatePresence, motion } from "motion/react";
import { Check, Eye, Pencil, ShieldCheck, User, UserPlus, Users, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ShapeIcon } from "./ShapeIcon";
import type { ActionRequest, DeviceDetail, DeviceView, Finding, PersonView, PlaceView, Snapshot } from "@core/types";
import { ago, deviceTitle, duration, placeName, shapeFor, STABILITY } from "@/lib/view";

interface Props {
  snapshot: Snapshot;
  device: DeviceView | null;
  finding: Finding | undefined;
  detail: DeviceDetail | null;
  onAction: (request: ActionRequest) => Promise<void>;
}

function identityLine(device: DeviceView): string {
  if (device.paired) return "Paired with this Mac";
  if (device.findMy === "separated") return "Broadcast key";
  if (device.identityConfidence < 1) return `Inferred, ${Math.round(device.identityConfidence * 100)}% confidence`;
  return "Observed";
}

function typing(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement;
  return target.tagName === "INPUT" || event.metaKey || event.ctrlKey || event.altKey;
}

interface ChipProps {
  icon: LucideIcon;
  label: string;
  pressed?: boolean;
  disabled?: boolean;
  shortcut?: string;
  title?: string;
  onClick: () => void;
}

function Chip({ icon: Icon, label, pressed, disabled, shortcut, title, onClick }: ChipProps) {
  return (
    <button
      className="tag"
      aria-pressed={pressed}
      aria-keyshortcuts={shortcut}
      disabled={disabled}
      title={title}
      onClick={onClick}
    >
      <Icon size={14} strokeWidth={2} aria-hidden="true" />
      {label}
      {shortcut && <kbd>{shortcut}</kbd>}
    </button>
  );
}

interface TitleProps {
  device: DeviceView;
  tone: string;
  editing: boolean;
  onEdit: (editing: boolean) => void;
  onAction: Props["onAction"];
}

/** The heading is the field, so naming a device doesn't move anything on the page. */
function Title({ device, tone, editing, onEdit, onAction }: TitleProps) {
  const [draft, setDraft] = useState("");
  const nameable = device.owner !== null;

  useEffect(() => {
    if (editing) setDraft(device.label ?? "");
  }, [editing, device.label]);

  const save = () => {
    onEdit(false);
    if (draft.trim() !== (device.label ?? "")) void onAction({ action: "name-device", deviceId: device.id, label: draft });
  };

  return (
    <h2 className="object-title">
      <ShapeIcon shape={shapeFor(device.class)} size={16} fill={tone} stroke={tone} />
      {editing ? (
        <input
          className="title-input"
          aria-label={`Name for ${device.code}`}
          value={draft}
          placeholder={device.code}
          maxLength={40}
          autoFocus
          onFocus={(event) => event.target.select()}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={save}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              setDraft(device.label ?? "");
              onEdit(false);
            }
          }}
        />
      ) : (
        <span className="title-text">{deviceTitle(device)}</span>
      )}
      {nameable && !editing && (
        <button className="icon-btn" aria-label="Rename" aria-keyshortcuts="N" title="Rename (N)" onClick={() => onEdit(true)}>
          <Pencil size={14} strokeWidth={2} aria-hidden="true" />
        </button>
      )}
    </h2>
  );
}

interface PersonFormProps {
  onSave: (person: string, publicLabel: string) => void;
  onCancel: () => void;
}

function PersonForm({ onSave, onCancel }: PersonFormProps) {
  const [person, setPerson] = useState("");
  const [publicLabel, setPublicLabel] = useState("");
  return (
    <form
      className="person-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (person.trim()) onSave(person, publicLabel);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") onCancel();
      }}
    >
      <label>
        Their name
        <input value={person} maxLength={40} autoFocus onChange={(event) => setPerson(event.target.value)} />
      </label>
      <label>
        Shown on recordings
        <input
          value={publicLabel}
          maxLength={40}
          placeholder="Roommate"
          onChange={(event) => setPublicLabel(event.target.value)}
        />
      </label>
      <div className="person-form-actions">
        <button className="tag" type="submit" disabled={!person.trim()}>
          <Check size={14} strokeWidth={2} aria-hidden="true" />
          Add
        </button>
        <button className="tag" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

interface IdentityProps {
  device: DeviceView;
  people: PersonView[];
  reveal: boolean;
  onName: () => void;
  onAction: Props["onAction"];
}

function Identity({ device, people, reveal, onName, onAction }: IdentityProps) {
  const [failed, setFailed] = useState(false);
  const [adding, setAdding] = useState(false);
  const mine = device.owner?.self === true;
  const other = device.owner && !device.owner.self ? device.owner : null;
  const person = people.find((candidate) => candidate.label === other?.label);

  const run = useCallback(
    (request: ActionRequest) => {
      setFailed(false);
      onAction(request).catch(() => setFailed(true));
    },
    [onAction],
  );

  // Tagging a device is usually followed by naming it, so go straight there.
  const tag = useCallback(
    (request: ActionRequest) => {
      const fresh = device.owner === null && device.label === null;
      run(request);
      if (fresh) onName();
    },
    [device.owner, device.label, run, onName],
  );

  const toggleMine = useCallback(() => {
    if (mine) run({ action: "unclaim", deviceId: device.id });
    else tag({ action: "claim", deviceId: device.id });
  }, [mine, device.id, run, tag]);
  const toggleTrust = useCallback(
    () => run({ action: device.trusted ? "untrust" : "trust", deviceId: device.id }),
    [device.trusted, device.id, run],
  );
  const toggleWatch = useCallback(
    () => run({ action: device.watched ? "unwatch" : "watch", deviceId: device.id }),
    [device.watched, device.id, run],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (typing(event)) return;
      if (event.key === "m") toggleMine();
      if (event.key === "t") toggleTrust();
      if (event.key === "w") toggleWatch();
      if (event.key === "n" && device.owner) {
        event.preventDefault();
        onName();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleMine, toggleTrust, toggleWatch, onName, device.owner]);

  return (
    <section className="section identity" aria-label="Who this device belongs to">
      <div className="tag-row" role="group" aria-label="Belongs to">
        <Chip icon={User} label="Mine" pressed={mine} shortcut="M" onClick={toggleMine} />
        {people.map((candidate) => (
          <Chip
            key={candidate.id}
            icon={Users}
            label={candidate.label}
            pressed={other?.label === candidate.label}
            onClick={() =>
              other?.label === candidate.label
                ? run({ action: "unclaim", deviceId: device.id })
                : tag({ action: "assign", deviceId: device.id, person: candidate.label })
            }
          />
        ))}
        {other && !reveal && (
          <Chip icon={Users} label={other.label ?? "Someone you know"} pressed disabled onClick={() => {}} />
        )}
        {reveal && !adding && <Chip icon={UserPlus} label="Add person" onClick={() => setAdding(true)} />}
      </div>

      {adding && (
        <PersonForm
          onCancel={() => setAdding(false)}
          onSave={(name, publicLabel) => {
            setAdding(false);
            tag({ action: "assign", deviceId: device.id, person: name, publicLabel });
          }}
        />
      )}

      {other && reveal && person && (
        <label className="public-name">
          Shown on recordings as
          <input
            key={person.id}
            defaultValue={person.publicLabel ?? ""}
            placeholder="Someone you know"
            maxLength={40}
            onBlur={(event) => {
              const value = event.target.value.trim();
              if (value !== (person.publicLabel ?? "")) {
                run({ action: "assign", deviceId: device.id, person: person.label, publicLabel: value });
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
        </label>
      )}

      <div className="tag-row">
        <Chip
          icon={ShieldCheck}
          label={device.trusted ? "Trusted" : "Trust"}
          pressed={device.trusted}
          shortcut="T"
          title="Stop raising findings for this device"
          onClick={toggleTrust}
        />
        <Chip
          icon={Eye}
          label={device.watched ? "Watching" : "Watch"}
          pressed={device.watched}
          shortcut="W"
          title="Keep this device labelled on the graph"
          onClick={toggleWatch}
        />
      </div>

      {!reveal && !device.owner && <p className="hint">Turn off Screenshot mode to see names and tag someone you know.</p>}

      {failed && <p className="error-line" role="alert">That didn't save. Check the console is still running, then try again.</p>}
    </section>
  );
}

function DeviceObject({ snapshot, device, finding, detail, onAction }: Props & { device: DeviceView }) {
  const tone = finding?.severity === "high" ? "var(--alert)" : device.owner?.self ? "var(--you)" : "var(--ink)";
  const [editing, setEditing] = useState(false);
  const startNaming = useCallback(() => setEditing(true), []);
  const places = new Map<number, PlaceView>(snapshot.places.map((place) => [place.id, place]));
  const now = snapshot.generatedAt;
  const stability = STABILITY[device.stability];
  return (
    <>
      <section className="inspector-head">
        <Title device={device} tone={tone} editing={editing} onEdit={setEditing} onAction={onAction} />
        <p className="object-sub">
          {device.classLabel}
          <span className="stability" data-stability={device.stability} title={stability.detail}>{stability.word}</span>
        </p>
        {finding && (
          <p className="object-note" data-severity={finding.severity}>
            <b>{finding.title}</b>
            {finding.detail}
          </p>
        )}
      </section>
      <Identity device={device} people={snapshot.people} reveal={snapshot.reveal} onName={startNaming} onAction={onAction} />
      <section className="section">
        <dl className="facts">
          <dt>Owner</dt>
          <dd>{device.owner ? (device.owner.label ?? "Someone you know") : "Unknown"}</dd>
          <dt>Identity</dt>
          <dd>{identityLine(device)}</dd>
          {deviceTitle(device) !== device.code && (
            <>
              <dt>Callsign</dt>
              <dd>{device.code}</dd>
            </>
          )}
          <dt>Vendor</dt>
          <dd>{device.vendor ?? "Not broadcast"}</dd>
          <dt>Broadcast name</dt>
          <dd>{device.name ?? (device.hasName ? "Hidden in screenshot mode" : "None")}</dd>
          <dt>First seen</dt>
          <dd className="data">{ago(device.firstSeen, now)}</dd>
          <dt>Last seen</dt>
          <dd className="data">{device.live ? "Now" : ago(device.lastSeen, now)}</dd>
        </dl>
      </section>
      <section className="section" aria-label="Seen at">
        <div className="section-head">
          <h3 className="section-title">Seen at</h3>
          <span className="count">{device.presence.length}</span>
        </div>
        {device.presence.length === 0 && <p className="quiet">Not heard over Bluetooth yet.</p>}
        <dl className="facts">
          {device.presence.map((presence) => {
            const place = places.get(presence.placeId);
            return (
              <div key={presence.placeId} style={{ display: "contents" }}>
                <dt>{place ? placeName(place) : "Older place"}</dt>
                <dd className="data">{duration(presence.minutes)}, best {presence.bestRssi} dBm</dd>
              </div>
            );
          })}
        </dl>
      </section>
      <section className="section" aria-label="Aliases">
        <div className="section-head">
          <h3 className="section-title">Aliases</h3>
          <span className="count">{device.aliasCount}</span>
        </div>
        {detail === null ? (
          <>
            <div className="skeleton" />
            <div className="skeleton" style={{ width: "70%" }} />
          </>
        ) : (
          <ul>
            {detail.aliases.slice(-8).map((alias) => (
              <li className="alias-row" key={alias.code}>
                <div className="alias-top">
                  <span className="data">{alias.code}</span>
                  <span className="quiet">{alias.confidence === null ? "Observed" : `${Math.round(alias.confidence * 100)}% link`}</span>
                </div>
                {alias.evidence && <p className="evidence">{alias.evidence}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

const panel = {
  initial: { opacity: 0, x: 24 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: 24 },
  transition: { duration: 0.24, ease: [0.22, 1, 0.36, 1] as const },
};

export function Inspector({ onClose, ...props }: Props & { device: DeviceView; onClose: () => void }) {
  return (
    <motion.aside className="inspector" aria-label={`Inspector for ${deviceTitle(props.device)}`} {...panel}>
      <button className="inspector-close" aria-label="Close inspector" onClick={onClose}>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M1.5 1.5 10.5 10.5M10.5 1.5 1.5 10.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={props.device.id}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.14 }}
        >
          <DeviceObject {...props} />
        </motion.div>
      </AnimatePresence>
    </motion.aside>
  );
}
