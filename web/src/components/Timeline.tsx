import { useEffect, useMemo, useRef, useState } from "react";
import type { DeviceDetail, DeviceView, PlaceView, Visit } from "@core/types";
import { clock, deviceTitle, placeName } from "@/lib/view";

const LANE = 22;
const LABEL_WIDTH = 96;
const AXIS = 16;
const MIN_SPAN = 20 * 60_000;
const HEAD_ROOM = 0.06;

interface Props {
  places: PlaceView[];
  visits: Visit[];
  device: DeviceView | null;
  detail: DeviceDetail | null;
  flagged: boolean;
  now: number;
}

interface Run {
  placeId: number;
  first: number;
  last: number;
  rssi: number;
}

/** Back-to-back minutes read as one stretch of time, not a row of ticks. */
function toRuns(sightings: DeviceDetail["sightings"]): Run[] {
  const runs: Run[] = [];
  const ordered = [...sightings].sort((a, b) => a.placeId - b.placeId || a.minute - b.minute);
  for (const { placeId, minute, rssi } of ordered) {
    const run = runs.at(-1);
    if (run && run.placeId === placeId && minute - run.last <= 1) {
      run.last = minute;
      run.rssi = Math.max(run.rssi, rssi);
    } else {
      runs.push({ placeId, first: minute, last: minute, rssi });
    }
  }
  return runs;
}

interface Tip {
  x: number;
  text: string;
}

export function Timeline({ places, visits, device, detail, flagged, now }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [tip, setTip] = useState<Tip | null>(null);

  useEffect(() => {
    if (!wrap.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(wrap.current);
    return () => observer.disconnect();
  }, []);

  const lanes = places.slice(0, 4);
  const earliest = Math.min(now, ...visits.map((visit) => visit.start));
  const start = Math.min(now - MIN_SPAN, earliest - (now - earliest) * HEAD_ROOM);
  const plotWidth = Math.max(width - LABEL_WIDTH, 1);
  const x = (ts: number) => LABEL_WIDTH + ((ts - start) / (now - start)) * plotWidth;
  const laneY = new Map(lanes.map((place, index) => [place.id, index * LANE + LANE / 2]));
  const height = Math.max(lanes.length, 1) * LANE + AXIS;

  const ticks = useMemo(() => {
    const count = width < 500 ? 2 : 4;
    return Array.from({ length: count + 1 }, (_, i) => start + ((now - start) * i) / count);
  }, [start, now, width]);

  const mark = flagged ? "var(--alert)" : "var(--ink)";
  const runs = useMemo(() => (device && detail ? toRuns(detail.sightings) : []), [device, detail]);

  return (
    <section className="timeline" aria-label="Timeline">
      <div className="timeline-head">
        <strong className={device ? "data" : undefined}>{device ? deviceTitle(device) : "Your movements"}</strong>
        <span className="timeline-keys">
          <span className="key"><i className="key-visit" />This Mac at place</span>
          {device && <span className="key"><i className="key-sighting" style={{ background: mark }} />Device heard</span>}
        </span>
      </div>
      <div ref={wrap} style={{ position: "relative" }} onMouseLeave={() => setTip(null)}>
        {tip && <div className="timeline-tip" style={{ left: Math.min(Math.max(tip.x, 70), width - 70) }}>{tip.text}</div>}
        <svg height={height} role="img" aria-label={device ? `Sightings of ${deviceTitle(device)} over time` : "Time spent at each place"}>
          {lanes.map((place) => {
            const y = laneY.get(place.id) ?? 0;
            return (
              <g key={place.id}>
                <text x={0} y={y + 4} fill="var(--ink-2)">
                  {placeName(place).slice(0, 13)}
                </text>
                <line x1={LABEL_WIDTH} x2={width} y1={y} y2={y} stroke="var(--rule)" />
              </g>
            );
          })}
          {visits.map((visit) => {
            const y = laneY.get(visit.placeId);
            if (y === undefined) return null;
            const left = x(visit.start);
            const name = lanes.find((place) => place.id === visit.placeId);
            return (
              <g key={`${visit.placeId}-${visit.start}`}>
                <rect x={left} y={y - 2} width={Math.max(x(visit.end) - left, 4)} height={4} rx={2} fill="var(--you)" opacity={device ? 0.35 : 1} />
                <rect
                  x={left}
                  y={y - LANE / 2}
                  width={Math.max(x(visit.end) - left, 8)}
                  height={LANE}
                  fill="transparent"
                  onMouseEnter={() =>
                    setTip({
                      x: left + (x(visit.end) - left) / 2,
                      text: `${name ? placeName(name) : "Place"}, ${clock(visit.start)} to ${clock(visit.end)}`,
                    })
                  }
                />
              </g>
            );
          })}
          {runs.map((run) => {
            const y = laneY.get(run.placeId);
            if (y === undefined) return null;
            const start = run.first * 60_000;
            const end = (run.last + 1) * 60_000;
            const left = x(start);
            const span = Math.max(x(end) - left, 2);
            const when = run.first === run.last ? clock(start) : `${clock(start)} to ${clock(end)}`;
            return (
              <rect
                key={`${run.placeId}-${run.first}`}
                x={left}
                y={y - 6}
                width={span}
                height={12}
                rx={1}
                fill={mark}
                onMouseEnter={() => setTip({ x: left + span / 2, text: `${when}, best ${run.rssi} dBm` })}
              />
            );
          })}
          {ticks.map((tick, index) => (
            <text
              key={tick}
              x={x(tick)}
              y={height - 3}
              fill="var(--ink-3)"
              textAnchor={index === 0 ? "start" : index === ticks.length - 1 ? "end" : "middle"}
            >
              {clock(tick)}
            </text>
          ))}
        </svg>
      </div>
    </section>
  );
}
