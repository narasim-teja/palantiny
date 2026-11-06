"use client";

import { useEffect, useState } from "react";
import type { DeviceDetail } from "@/lib/types";

export function useDeviceDetail(deviceId: number | null, refreshKey: number) {
  const [detail, setDetail] = useState<DeviceDetail | null>(null);
  useEffect(() => {
    if (deviceId === null) {
      setDetail(null);
      return;
    }
    const controller = new AbortController();
    fetch(`/api/device/${deviceId}`, { signal: controller.signal })
      .then((response) => response.json() as Promise<DeviceDetail>)
      .then(setDetail)
      .catch(() => {});
    return () => controller.abort();
  }, [deviceId, refreshKey]);
  return detail;
}
