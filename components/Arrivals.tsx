"use client";

import { AnimatePresence, motion } from "motion/react";
import { ShapeIcon } from "./ShapeIcon";
import type { DeviceView } from "@/lib/types";
import { arrivals, deviceTitle, shapeFor, shortAgo } from "@/lib/view";

const LIMIT = 40;

interface Props {
  devices: DeviceView[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  now: number;
}

export function Arrivals({ devices, selectedId, onSelect, now }: Props) {
  const rows = arrivals(devices).slice(0, LIMIT);
  return (
    <section className="section arrivals" aria-labelledby="arrivals-title">
      <div className="section-head">
        <h2 className="section-title" id="arrivals-title">Arrivals</h2>
        <span className="count">{rows.length === LIMIT ? `Latest ${LIMIT}` : rows.length}</span>
      </div>
      {rows.length === 0 && <p className="quiet">Devices appear here the moment they're first heard.</p>}
      <ul className="arrival-list">
        <AnimatePresence initial={false}>
          {rows.map((device) => {
            const selected = device.id === selectedId;
            return (
              <motion.li
                key={device.id}
                layout="position"
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
              >
                <button className="arrival" aria-current={selected} onClick={() => onSelect(device.id)}>
                  <ShapeIcon
                    shape={shapeFor(device.class)}
                    fill={device.live ? "currentColor" : "none"}
                    stroke="currentColor"
                  />
                  <span className="data">{deviceTitle(device)}</span>
                  <span className="arrival-class">{device.classLabel}</span>
                  <span className="arrival-age">{shortAgo(device.firstSeen, now)}</span>
                </button>
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ul>
    </section>
  );
}
