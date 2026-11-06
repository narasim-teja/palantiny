"use client";

import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { ShapeIcon } from "./ShapeIcon";
import type { ActionRequest, DeviceDetail, DeviceView, Finding, PlaceView, Snapshot } from "@/lib/types";
import { ago, deviceTitle, duration, placeName, shapeFor } from "@/lib/view";

interface Props {
  snapshot: Snapshot;
  device: DeviceView | null;
  finding: Finding | undefined;
  detail: DeviceDetail | null;
  onAction: (request: ActionRequest) => Promise<void>;
}

function identityLine(device: DeviceView): string {
  if (device.paired) return "Paired with this Mac";
  if (device.findMy === "separated") return "Stable broadcast key";
  if (device.identityConfidence >= 1) {
    return device.aliasCount > 1 ? "Observed" : "Single alias, may rotate";
  }
  return `Inferred, ${Math.round(device.identityConfidence * 100)}% confidence`;
}

function Actions({ device, onAction }: { device: DeviceView; onAction: Props["onAction"] }) {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const mine = device.owner?.self === true;

  const run = async (action: "claim" | "unclaim" | "trust" | "untrust" | "watch" | "unwatch") => {
    setPending(true);
    setFailed(false);
    try {
      await onAction({ action, deviceId: device.id });
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <div className="actions">
        <button className="btn" disabled={pending} aria-pressed={mine} onClick={() => void run(mine ? "unclaim" : "claim")}>
          {mine ? "Mine" : "Claim as mine"}
        </button>
        <button className="btn" disabled={pending} aria-pressed={device.trusted} onClick={() => void run(device.trusted ? "untrust" : "trust")}>
          {device.trusted ? "Trusted" : "Mark trusted"}
        </button>
        <button className="btn" disabled={pending} aria-pressed={device.watched} onClick={() => void run(device.watched ? "unwatch" : "watch")}>
          {device.watched ? "Watching" : "Watch"}
        </button>
      </div>
      {failed && <p className="error-line" role="alert">That didn't save. Check the console is still running, then try again.</p>}
    </>
  );
}

function DeviceObject({ snapshot, device, finding, detail, onAction }: Props & { device: DeviceView }) {
  const tone = finding?.severity === "high" ? "var(--alert)" : device.owner?.self ? "var(--you)" : "var(--ink)";
  const places = new Map<number, PlaceView>(snapshot.places.map((place) => [place.id, place]));
  const now = snapshot.generatedAt;
  return (
    <>
      <section className="inspector-head">
        <h2 className="object-title">
          <ShapeIcon shape={shapeFor(device.class)} size={16} fill={tone} stroke={tone} />
          {deviceTitle(device)}
        </h2>
        <p className="object-sub">{device.classLabel}</p>
        {finding && (
          <p className="object-note" data-severity={finding.severity}>
            <b>{finding.title}</b>
            {finding.detail}
          </p>
        )}
      </section>
      <section className="section">
        <Actions device={device} onAction={onAction} />
      </section>
      <section className="section">
        <dl className="facts">
          <dt>Owner</dt>
          <dd>{device.owner ? device.owner.label : "Unknown"}</dd>
          <dt>Identity</dt>
          <dd>{identityLine(device)}</dd>
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
