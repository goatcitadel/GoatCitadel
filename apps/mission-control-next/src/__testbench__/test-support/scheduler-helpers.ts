import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { pass } from "../runner/assert";
import { INITIAL_RUN_STATE, runReducer, type RunEvent, type RunState } from "../runner/state";
import type { CheckDef, CheckResult, CheckTier, RunOptions } from "../runner/types";

export const RUN_OPTIONS: RunOptions = { allowHost: false, confirmedExternalIds: new Set() };

export function makeCheck(
  id: string,
  tier: CheckTier,
  run: CheckDef["run"],
  extra: Omit<Partial<CheckDef>, "id" | "tier" | "run"> = {},
): CheckDef {
  return { id, kind: "probe", domain: "test", title: id, tier, routes: ["GET /api/v1/test"], run, ...extra };
}

export function collector() {
  const events: RunEvent[] = [];
  return { events, emit: (event: RunEvent) => void events.push(event) };
}

export function finished(events: readonly RunEvent[], checkId: string) {
  return events.find(
    (event): event is Extract<RunEvent, { type: "check-finished" }> =>
      event.type === "check-finished" && event.checkId === checkId,
  );
}

/** Folds collected events through the production reducer, as the live console does. */
export function foldEvents(events: readonly RunEvent[]): RunState {
  return events.reduce(runReducer, INITIAL_RUN_STATE);
}

export function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Lets abandoned check bodies run their continuations before the test asserts. */
export function settle(milliseconds = 30): Promise<void> {
  return new Promise((done) => setTimeout(done, milliseconds));
}

export interface Gauge {
  active: number;
  peak: number;
}

/** A check body that records how many bodies sharing `gauge` were active at once. */
export function gauged(gauge: Gauge, id: string, order: string[] = []) {
  return async (): Promise<CheckResult> => {
    gauge.active += 1;
    gauge.peak = Math.max(gauge.peak, gauge.active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    gauge.active -= 1;
    order.push(id);
    return pass(id);
  };
}

/** The error a shared client function throws when the Gateway cannot be reached. */
export function gatewayDownError(): ApiRequestError {
  return new ApiRequestError("Network error POST /api/v1/test: fetch failed", {
    kind: "network",
    method: "POST",
    path: "/api/v1/test",
  });
}
