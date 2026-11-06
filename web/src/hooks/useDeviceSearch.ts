import { useEffect, useState } from "react";
import type { DeviceSearch } from "@core/types";

const DEBOUNCE_MS = 140;
const EMPTY: DeviceSearch = { total: 0, devices: [] };

/** Searches every device on the server, because a snapshot only carries the top few. */
export function useDeviceSearch(query: string, reveal: boolean, refreshKey: number) {
  const [results, setResults] = useState<DeviceSearch>(EMPTY);
  const [searching, setSearching] = useState(false);
  const term = query.trim();

  useEffect(() => {
    if (!term) {
      setResults(EMPTY);
      setSearching(false);
      return;
    }
    setSearching(true);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/v1/devices?q=${encodeURIComponent(term)}&reveal=${reveal ? 1 : 0}`, { signal: controller.signal })
        .then((response) => response.json() as Promise<DeviceSearch>)
        .then((found) => {
          setResults(found);
          setSearching(false);
        })
        .catch(() => {});
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [term, reveal, refreshKey]);

  return { ...results, searching };
}
