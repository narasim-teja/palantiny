import { useEffect, useState } from "react";
import type { DeviceDetail } from "@core/types";

export function useDeviceDetail(deviceId: number | null, refreshKey: number) {
  const [detail, setDetail] = useState<DeviceDetail | null>(null);
  useEffect(() => {
    if (deviceId === null) {
      setDetail(null);
      return;
    }
    const controller = new AbortController();
    fetch(`/v1/devices/${deviceId}`, { signal: controller.signal })
      .then((response) => response.json() as Promise<DeviceDetail>)
      .then(setDetail)
      .catch(() => {});
    return () => controller.abort();
  }, [deviceId, refreshKey]);
  return detail;
}
