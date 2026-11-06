"use client";

import { useEffect, useState } from "react";
import type { Snapshot } from "@/lib/types";

export function useSnapshot(reveal: boolean) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(true);

  useEffect(() => {
    const source = new EventSource(`/api/stream?reveal=${reveal ? 1 : 0}`);
    source.onmessage = (event) => {
      setSnapshot(JSON.parse(event.data as string) as Snapshot);
      setConnected(true);
    };
    source.onerror = () => setConnected(false);
    return () => source.close();
  }, [reveal]);

  return { snapshot, connected };
}
