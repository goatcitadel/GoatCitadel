import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { getGatewayApiBaseUrl, preflightGatewayAccess } from "@goatcitadel/mission-control-shared/api/client-core";
import { HAND_WRITTEN_CHECKS } from "../catalog";
import { buildAutoProbes } from "../catalog/auto-probes";
import { fetchDevStatus, fetchRouteManifest, seedWorkspace } from "../catalog/dev-verification";
import type { TestbenchEnv } from "../env";
import { classifyError } from "../runner/classify";
import { computeCoverage, trackedRouteKeys, type CoverageReport, type RouteManifest } from "../runner/routes";
import { runChecks, type RunSeed } from "../runner/scheduler";
import { INITIAL_RUN_STATE, runReducer, type RunState } from "../runner/state";
import type { CheckDef, RouteKey, RunOptions } from "../runner/types";
import { detectTarget, type DevVerificationStatus, type TargetInfo } from "../gateway-target/detect-target";
import type { TargetRequest } from "../gateway-target/resolve-target";

export type GatewayAccessStatus = "ready" | "needs-auth" | "unreachable" | "misconfigured";

export interface TestbenchDeps {
  readonly apiBase: () => string;
  readonly preflight: () => Promise<{ readonly status: GatewayAccessStatus; readonly message: string }>;
  readonly fetchStatus: () => Promise<DevVerificationStatus>;
  readonly fetchManifest: () => Promise<RouteManifest>;
  readonly seed: (signal: AbortSignal) => Promise<RunSeed>;
  readonly handWritten: readonly CheckDef[];
}

export const DEFAULT_TESTBENCH_DEPS: TestbenchDeps = {
  apiBase: getGatewayApiBaseUrl,
  preflight: () => preflightGatewayAccess(),
  fetchStatus: fetchDevStatus,
  fetchManifest: fetchRouteManifest,
  seed: async (signal) => {
    const seeded = await seedWorkspace(`Test bench run ${new Date().toISOString()}`, signal);
    return { workspaceId: seeded.workspaceId };
  },
  handWritten: HAND_WRITTEN_CHECKS,
};

export interface ReadyLoad {
  readonly phase: "ready";
  readonly target: TargetInfo;
  readonly manifestKeys: readonly RouteKey[] | undefined;
  readonly manifestError: string | undefined;
  readonly checks: readonly CheckDef[];
}

export type LoadState =
  | { readonly phase: "loading" }
  | { readonly phase: "blocked"; readonly title: string; readonly detail: string }
  | ReadyLoad;

export interface TestbenchController {
  readonly load: LoadState;
  readonly runState: RunState;
  readonly coverage: CoverageReport | undefined;
  readonly options: RunOptions;
  readonly setAllowHost: (value: boolean) => void;
  readonly run: (checkIds: readonly string[], confirmExternalId?: string) => void;
  readonly stop: () => void;
}

export async function loadTestbench(
  targetRequest: TargetRequest,
  env: TestbenchEnv,
  deps: TestbenchDeps,
): Promise<LoadState> {
  const access = await deps.preflight();
  if (access.status !== "ready") {
    return describeBlockedAccess(access.status, access.message);
  }
  const target = await detectTarget(targetRequest, env, { apiBase: deps.apiBase(), fetchStatus: deps.fetchStatus });
  const manifestResult = await deps.fetchManifest().then(
    (manifest) => ({ manifest, error: undefined }),
    (error: unknown) => ({ manifest: undefined, error: classifyError(error).summary }),
  );
  const autoProbes = manifestResult.manifest
    ? buildAutoProbes(manifestResult.manifest, deps.handWritten, target.kind)
    : [];
  return {
    phase: "ready",
    target,
    manifestKeys: manifestResult.manifest ? trackedRouteKeys(manifestResult.manifest) : undefined,
    manifestError: manifestResult.error,
    checks: [...deps.handWritten, ...autoProbes],
  };
}

function describeBlockedAccess(status: Exclude<GatewayAccessStatus, "ready">, message: string): LoadState {
  switch (status) {
    case "needs-auth":
      return {
        phase: "blocked",
        title: "This gateway needs you to sign in",
        detail: `${message} Sign in through Mission Control on this same address, then reload the test bench.`,
      };
    case "unreachable":
      return {
        phase: "blocked",
        title: "Gateway unreachable",
        detail: `${message} If this is an installed GoatCitadel, open the test bench from the dev server on port 5173: production gateways only accept browser requests from that origin.`,
      };
    case "misconfigured":
      return { phase: "blocked", title: "Gateway access is misconfigured", detail: message };
  }
}

export function useTestbench(
  targetRequest: TargetRequest,
  env: TestbenchEnv,
  deps: TestbenchDeps,
): TestbenchController {
  const [load, setLoad] = useState<LoadState>({ phase: "loading" });
  const [runState, dispatch] = useReducer(runReducer, INITIAL_RUN_STATE);
  const [allowHost, setAllowHost] = useState(false);
  const [confirmedExternalIds, setConfirmedExternalIds] = useState<ReadonlySet<string>>(() => new Set<string>());
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadTestbench(targetRequest, env, deps).then(
      (next) => {
        if (!cancelled) {
          setLoad(next);
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setLoad({ phase: "blocked", title: "The test bench could not start", detail: classifyError(error).summary });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [targetRequest, env, deps]);

  useEffect(() => {
    const activeRun = controllerRef;
    return () => {
      activeRun.current?.abort();
    };
  }, []);

  const coverage = useMemo(
    () => (load.phase === "ready" ? computeCoverage(load.manifestKeys, load.checks) : undefined),
    [load],
  );
  const options = useMemo<RunOptions>(() => ({ allowHost, confirmedExternalIds }), [allowHost, confirmedExternalIds]);

  const run = useCallback(
    (checkIds: readonly string[], confirmExternalId?: string) => {
      if (load.phase !== "ready" || controllerRef.current) {
        return;
      }
      const confirmed =
        confirmExternalId === undefined ? confirmedExternalIds : new Set([...confirmedExternalIds, confirmExternalId]);
      if (confirmExternalId !== undefined) {
        setConfirmedExternalIds(confirmed);
      }
      const wanted = new Set(checkIds);
      const controller = new AbortController();
      controllerRef.current = controller;
      void runChecks({
        checks: load.checks.filter((check) => wanted.has(check.id)),
        target: load.target,
        options: { allowHost, confirmedExternalIds: confirmed },
        signal: controller.signal,
        emit: dispatch,
        seed: deps.seed,
      }).finally(() => {
        controllerRef.current = null;
      });
    },
    [load, allowHost, confirmedExternalIds, deps],
  );

  const stop = useCallback(() => {
    controllerRef.current?.abort();
  }, []);

  return { load, runState, coverage, options, setAllowHost, run, stop };
}
