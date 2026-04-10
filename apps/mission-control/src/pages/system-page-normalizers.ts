import type { SystemVitalsResponse } from "../api/client";

export function normalizeSystemVitals(vitals: Partial<SystemVitalsResponse> | null | undefined): SystemVitalsResponse {
  return {
    hostname: vitals?.hostname ?? "unknown-host",
    platform: vitals?.platform ?? "unknown-platform",
    release: vitals?.release ?? "unknown-release",
    uptimeSeconds: vitals?.uptimeSeconds ?? 0,
    loadAverage: vitals?.loadAverage ?? [0, 0, 0],
    cpuCount: vitals?.cpuCount ?? 0,
    memoryTotalBytes: vitals?.memoryTotalBytes ?? 0,
    memoryFreeBytes: vitals?.memoryFreeBytes ?? 0,
    memoryUsedBytes: vitals?.memoryUsedBytes ?? 0,
    processRssBytes: vitals?.processRssBytes ?? 0,
    processHeapUsedBytes: vitals?.processHeapUsedBytes ?? 0,
  };
}
