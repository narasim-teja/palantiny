import { useCallback, useEffect, useRef, useState } from "react";
import { applyOptimistic } from "@/lib/optimistic";
import type { ActionRequest, Snapshot } from "@core/types";

export function useSnapshot(reveal: boolean) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(true);
  // Anything the server hasn't confirmed yet. A snapshot built before an action landed
  // would otherwise briefly undo it on screen.
  const pending = useRef<ActionRequest[]>([]);

  const receive = useCallback((incoming: Snapshot) => {
    setSnapshot(pending.current.reduce(applyOptimistic, incoming));
  }, []);

  useEffect(() => {
    const source = new EventSource(`/v1/stream?reveal=${reveal ? 1 : 0}`);
    source.onmessage = (event) => {
      receive(JSON.parse(event.data as string) as Snapshot);
      setConnected(true);
    };
    source.onerror = () => setConnected(false);
    return () => source.close();
  }, [reveal, receive]);

  /** Shows the result straight away, then settles on what the server says. */
  const act = useCallback(
    async (request: ActionRequest, send: (request: ActionRequest) => Promise<void>) => {
      pending.current.push(request);
      setSnapshot((current) => (current ? applyOptimistic(current, request) : current));
      try {
        await send(request);
      } finally {
        pending.current = pending.current.filter((candidate) => candidate !== request);
        const response = await fetch(`/v1/snapshot?reveal=${reveal ? 1 : 0}`);
        if (response.ok) receive((await response.json()) as Snapshot);
      }
    },
    [reveal, receive],
  );

  return { snapshot, connected, act };
}
