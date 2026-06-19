// RELIABILITY: a run whose worker died (expired lease) is reclaimable, not lost.
//
// Uses the shipped lease state machine (apps/gateway/dist/services/
// durable-run-service.js, deriveDurableRunOperationalState). A "running" run whose
// lease has expired must resolve to recoveryState "reclaimable" so another worker
// resumes it after a restart; a freshly-leased run stays "active". This is the
// structural proof behind "restart/durable resume" without booting two workers.

import { pass, fail, skip } from "../lib/harness.mjs";
import { importGoatCitadel } from "../lib/goatcitadel-modules.mjs";

export default {
  id: "reliability.durable-resume",
  axis: "RELIABILITY",
  title: "Expired-lease run is reclaimable after a worker restart",
  description:
    "A running durable run whose lease expired resolves to recoveryState 'reclaimable' (so a restarted " +
    "worker resumes it); a run with a live lease stays 'active'. Proves crashed work is recovered, not dropped.",
  requiresEdges: [],
  mode: "in-process",

  async run(target) {
    if (target.kind === "competitor") {
      return skip(`${target.id} exposes no durable-run lease state to inspect`);
    }
    if (!target.distReady) {
      return skip(target.skipReason ?? "goatcitadel dist not built");
    }

    const { deriveDurableRunOperationalState } = await importGoatCitadel("gateway/durable-run-service");

    const now = Date.parse("2026-06-19T12:00:00.000Z");

    const expiredLeaseRun = {
      runId: "bench-run-expired",
      status: "running",
      leaseOwnerId: "worker-that-crashed",
      leaseExpiresAt: new Date(now - 60_000).toISOString(), // expired 1 min ago
      leaseHeartbeatAt: new Date(now - 60_000).toISOString(),
    };
    const activeRun = {
      runId: "bench-run-active",
      status: "running",
      leaseOwnerId: "worker-alive",
      leaseExpiresAt: new Date(now + 60_000).toISOString(), // valid for another min
      leaseHeartbeatAt: new Date(now - 1_000).toISOString(),
    };

    const expired = deriveDurableRunOperationalState(expiredLeaseRun, now);
    const active = deriveDurableRunOperationalState(activeRun, now);

    if (expired.recoveryState !== "reclaimable" || expired.workerHealth !== "expired_lease") {
      return fail(
        `expired-lease run should be reclaimable/expired_lease; got recoveryState='${expired.recoveryState}' workerHealth='${expired.workerHealth}'`,
        { expired },
      );
    }
    if (active.recoveryState !== "none" || active.workerHealth !== "active") {
      return fail(
        `live-lease run should be active/none; got recoveryState='${active.recoveryState}' workerHealth='${active.workerHealth}'`,
        { active },
      );
    }

    return pass(
      `expired lease → reclaimable (resumes after restart); live lease → active (no spurious reclaim)`,
      { expired: expired.recoveryState, active: active.recoveryState },
    );
  },
};
