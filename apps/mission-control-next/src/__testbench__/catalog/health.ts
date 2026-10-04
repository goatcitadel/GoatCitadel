import { request } from "@goatcitadel/mission-control-shared/api/client-core";
import { isApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { ensure, fail, pass } from "../runner/assert";
import type { CheckDef } from "../runner/types";

interface HealthBody {
  readonly status?: string;
  readonly readiness?: string;
  readonly service?: string;
}

interface LivezBody {
  readonly status?: string;
  readonly uptimeSeconds?: number;
}

interface ReadinessBody extends HealthBody {
  readonly checks?: ReadonlyArray<{ readonly key: string; readonly state?: string }>;
}

/** Health routes answer 503 with a full body when degraded; that is a failure, not a blocked feature. */
async function readAllowingDegraded<T>(path: string, signal: AbortSignal): Promise<{ body: T; degraded: boolean }> {
  try {
    return { body: await request<T>(path, { signal }), degraded: false };
  } catch (error) {
    if (isApiRequestError(error) && error.status === 503 && error.body !== undefined) {
      return { body: error.body as T, degraded: true };
    }
    throw error;
  }
}

export const healthChecks: readonly CheckDef[] = [
  {
    id: "health.gateway",
    kind: "probe",
    domain: "health",
    title: "Gateway health",
    tier: "read",
    routes: ["GET /health"],
    async run(ctx) {
      const { body, degraded } = await readAllowingDegraded<HealthBody>("/health", ctx.signal);
      ensure(body.service === "gateway", "The health endpoint did not identify the gateway service.", body);
      return degraded || body.status !== "ok"
        ? fail(`Gateway health is ${body.status ?? "unknown"} (readiness ${body.readiness ?? "unknown"}).`, body)
        : pass("Gateway reports ok and ready.", body);
    },
  },
  {
    id: "health.livez",
    kind: "probe",
    domain: "health",
    title: "Process liveness",
    tier: "read",
    routes: ["GET /livez"],
    async run(ctx) {
      const body = await request<LivezBody>("/livez", { signal: ctx.signal });
      ensure(body.status === "ok", `Liveness is ${body.status ?? "unknown"}.`, body);
      ensure(typeof body.uptimeSeconds === "number", "Liveness did not report uptime.", body);
      return pass(`Process alive for ${Math.round(body.uptimeSeconds)} s.`, body);
    },
  },
  {
    id: "ops.readiness",
    kind: "probe",
    domain: "ops",
    title: "Operator readiness checks",
    tier: "read",
    routes: ["GET /api/v1/ops/readiness"],
    async run(ctx) {
      const { body, degraded } = await readAllowingDegraded<ReadinessBody>("/api/v1/ops/readiness", ctx.signal);
      const checks = body.checks ?? [];
      ensure(checks.length > 0, "Readiness returned no checks.", body);
      const failing = checks.filter((check) => check.state !== "ready").map((check) => check.key);
      return degraded || failing.length > 0
        ? fail(`Readiness is degraded: ${failing.join(", ") || "unknown checks"}.`, body)
        : pass(`${checks.length} readiness checks are ready.`, body);
    },
  },
];
