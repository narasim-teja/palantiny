import { Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ShapeIcon } from "./ShapeIcon";
import type { DeviceView, Finding } from "@core/types";
import { ago, deviceTitle, findingFor, shapeFor, STABILITY } from "@/lib/view";

type SortKey = "device" | "places" | "aliases" | "seen";

interface Props {
  devices: DeviceView[];
  findings: Finding[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  now: number;
  query: string;
  onQuery: (query: string) => void;
  /** Every match on the server, or null when not searching. */
  total: number | null;
  searching: boolean;
  reveal: boolean;
  /** Changes when something asks for the search box to take focus. */
  focusKey: number;
}

const COLUMNS: { key: SortKey; label: string; numeric?: boolean }[] = [
  { key: "device", label: "Device" },
  { key: "places", label: "Places", numeric: true },
  { key: "aliases", label: "Aliases", numeric: true },
  { key: "seen", label: "Last seen", numeric: true },
];

function value(device: DeviceView, key: SortKey): number | string {
  if (key === "places") return device.presence.length;
  if (key === "aliases") return device.aliasCount;
  if (key === "seen") return device.lastSeen;
  return device.code;
}

export function DeviceTable({ devices, findings, selectedId, onSelect, now, query, onQuery, total, searching, reveal, focusKey }: Props) {
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (focusKey > 0) input.current?.select();
  }, [focusKey]);

  const inspecting = devices.some((device) => device.id === selectedId);
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({ key: "places", descending: true });

  const rows = useMemo(() => {
    const direction = sort.descending ? -1 : 1;
    return [...devices].sort((a, b) => {
      const left = value(a, sort.key);
      const right = value(b, sort.key);
      if (left === right) return b.lastSeen - a.lastSeen;
      return (left < right ? -1 : 1) * direction;
    });
  }, [devices, sort]);

  return (
    <div className="list-wrap" data-inspector={inspecting}>
      <div className="list-search" role="search">
        <Search size={15} strokeWidth={2} aria-hidden="true" />
        <input
          ref={input}
          type="search"
          value={query}
          aria-label="Search devices"
          placeholder={reveal ? "Search names, people, callsigns and types" : "Search callsigns and types"}
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              onQuery("");
              event.currentTarget.blur();
            }
          }}
        />
        {total !== null && (
          <span className="list-count" role="status">
            {searching ? "Searching" : total > rows.length ? `First ${rows.length} of ${total.toLocaleString()}` : `${total.toLocaleString()} found`}
          </span>
        )}
        {query ? (
          <button className="icon-btn" aria-label="Clear search" onClick={() => onQuery("")}>
            <X size={14} strokeWidth={2} aria-hidden="true" />
          </button>
        ) : (
          <kbd aria-hidden="true">/</kbd>
        )}
      </div>
      {total === 0 && !searching ? (
        <p className="list-empty">
          Nothing matches "{query.trim()}".{!reveal && " Names aren't searchable in Screenshot mode."}
        </p>
      ) : (
      <table>
        <caption className="sr-only">Devices heard near this Mac</caption>
        <thead>
          <tr>
            {COLUMNS.map((column) => (
              <th
                key={column.key}
                className={column.numeric ? "num" : undefined}
                aria-sort={sort.key === column.key ? (sort.descending ? "descending" : "ascending") : "none"}
              >
                <button
                  onClick={() =>
                    setSort((current) => ({
                      key: column.key,
                      descending: current.key === column.key ? !current.descending : true,
                    }))
                  }
                >
                  {column.label}
                  {sort.key === column.key && <span aria-hidden="true">{sort.descending ? "↓" : "↑"}</span>}
                </button>
              </th>
            ))}
            <th><span className="th-plain">Type</span></th>
            <th><span className="th-plain">Identity</span></th>
            <th><span className="th-plain">Status</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((device) => {
            const finding = findingFor(findings, device.id);
            const alert = finding?.severity === "high";
            return (
              <tr key={device.id} aria-selected={device.id === selectedId} onClick={() => onSelect(device.id)}>
                <td>
                  <button className="row-code" onClick={() => onSelect(device.id)}>
                    <ShapeIcon
                      shape={shapeFor(device.class)}
                      fill={alert ? "var(--alert)" : device.live ? "var(--ink)" : "none"}
                      stroke={alert ? "var(--alert)" : "var(--ink)"}
                    />
                    {deviceTitle(device)}
                  </button>
                </td>
                <td className="num">{device.presence.length}</td>
                <td className="num">{device.aliasCount}</td>
                <td className="num">{device.live ? "Now" : ago(device.lastSeen, now)}</td>
                <td className="dim">{device.classLabel}</td>
                <td className="dim" title={STABILITY[device.stability].detail}>{STABILITY[device.stability].word}</td>
                <td>
                  {device.owner?.self ? "Yours" : device.owner ? (device.owner.label ?? "Someone you know") : device.trusted ? "Trusted" : device.watched ? "Watching" : finding ? (alert ? "Flagged" : "Review") : ""}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      )}
    </div>
  );
}
