import type { OpsRuntimeData } from "../../../features/native-routes/ops/runtime-overview-model";

type SourceKey = keyof OpsRuntimeData["sourceStatus"];
const SOURCES: SourceKey[] = [
  "dashboard",
  "timeline",
  "health",
  "cost",
  "daemon",
  "llamaCpp",
  "backups",
  "sessions",
  "mcpServers",
  "runtimeMeasurements",
  "localEngines",
  "evalProofRuns",
];

/** Test-only: a running, controllable daemon as the runtime snapshot reports it. */
export const testDaemon = {
  supported: true,
  running: true,
  state: "running",
  host: "host-a",
  pid: 42,
  uptimeSeconds: 3600,
  controllable: true,
  controlMessage: "Controlled by this process.",
  diagnostics: [],
};

/** Test-only: a runtime snapshot with every source loaded except the ones named in `failed`. */
export function runtimeData(overrides: Record<string, unknown> = {}, failed: SourceKey[] = []): OpsRuntimeData {
  const sourceStatus = Object.fromEntries(
    SOURCES.map((key) => [key, failed.includes(key) ? { status: "error", message: "down" } : { status: "ok" }]),
  );
  return {
    dashboard: null,
    timeline: null,
    cost: null,
    health: {
      daemonStatus: testDaemon,
      systemVitals: { memoryUsedBytes: 2048, processRssBytes: 1024 },
      database: {},
      backups: { latest: null },
    },
    daemon: testDaemon,
    llamaCpp: null,
    backups: [],
    sessions: [],
    mcpServers: [],
    runtimeMeasurements: [],
    localEngines: [],
    evalProofRuns: [],
    sourceStatus,
    ...overrides,
  } as unknown as OpsRuntimeData;
}
