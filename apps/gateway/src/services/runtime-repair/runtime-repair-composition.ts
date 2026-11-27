/**
 * Wires the detect-only Runtime Repair Sweep to Gateway storage. Route
 * composition creates the runtime; the Gateway maintenance tick (every 60 s)
 * calls `runIfDue`, which throttles itself to the sweep cadence. This keeps the
 * sweep's lifecycle out of GatewayService: the maintenance scheduler already
 * owns start, stop, closing, and shared-host admission.
 */
import { randomUUID } from "node:crypto";
import {
  NotFoundError,
  RUNTIME_REPAIR_AUDIT_STREAM,
  type ApprovalRequest,
  type DurableDeadLetterRecord,
  type DurableRunRecord,
} from "@goatcitadel/contracts";
import { logger } from "@goatcitadel/gateway-core";
import {
  RuntimeRepairSweepService,
  type RuntimeRepairAuditPort,
  type RuntimeRepairReadPort,
  type RuntimeRepairsRouteService,
} from "./runtime-repair-sweep-service.js";
import type { GatewayRouteCompositionPort } from "../gateway-route-composition-port.js";

/** Detect-only work is not urgent; a slow cadence keeps its read cost negligible. */
export const RUNTIME_REPAIR_SWEEP_INTERVAL_MS = 5 * 60_000;
export const RUNTIME_REPAIR_SWEEP_BOOT_DELAY_MS = 60_000;

type Awaitable<T> = T | Promise<T>;

/** The slice of Gateway storage the sweep reads. Works for both the SQLite and PostgreSQL storage shapes. */
export interface RuntimeRepairStorageView {
  durableRuns: {
    listRunIdsByStatus(status: "waiting", limit: number): Awaitable<string[]>;
    getRunsByIds(runIds: string[]): Awaitable<Map<string, DurableRunRecord>>;
    listDeadLetters(limit: number): Awaitable<DurableDeadLetterRecord[]>;
    listRuns(limit: number): Awaitable<DurableRunRecord[]>;
  };
  approvals: {
    get(approvalId: string): Awaitable<ApprovalRequest>;
    list(status: "pending", limit: number): Awaitable<ApprovalRequest[]>;
    listExpiredPending(nowIso: string, limit: number): Awaitable<ApprovalRequest[]>;
  };
  audit: {
    append(stream: typeof RUNTIME_REPAIR_AUDIT_STREAM, payload: Record<string, unknown>): Promise<void>;
    listRecent(stream: typeof RUNTIME_REPAIR_AUDIT_STREAM, limit: number): Promise<Record<string, unknown>[]>;
  };
}

export function createRuntimeRepairReadPort(storage: RuntimeRepairStorageView): RuntimeRepairReadPort {
  return {
    listWaitingRunIds: async (limit) => await storage.durableRuns.listRunIdsByStatus("waiting", limit),
    getRunsByIds: async (runIds) => await storage.durableRuns.getRunsByIds(runIds),
    getApproval: async (approvalId) => {
      try {
        return await storage.approvals.get(approvalId);
      } catch (error) {
        if (error instanceof NotFoundError) return null;
        throw error;
      }
    },
    listPendingApprovals: async (limit) => await storage.approvals.list("pending", limit),
    listExpiredPendingApprovals: async (nowIso, limit) => await storage.approvals.listExpiredPending(nowIso, limit),
    listDeadLetters: async (limit) => await storage.durableRuns.listDeadLetters(limit),
    listRecentRuns: async (limit) => await storage.durableRuns.listRuns(limit),
  };
}

export function createRuntimeRepairAuditPort(storage: RuntimeRepairStorageView): RuntimeRepairAuditPort {
  return {
    append: async (payload) => await storage.audit.append(RUNTIME_REPAIR_AUDIT_STREAM, payload),
    listRecent: async (limit) => await storage.audit.listRecent(RUNTIME_REPAIR_AUDIT_STREAM, limit),
  };
}

/** The route view plus the hook the Gateway maintenance tick calls. */
export interface RuntimeRepairsRuntime extends RuntimeRepairsRouteService {
  /** Runs one sweep when the cadence says one is due. Never throws. */
  runIfDue(): Promise<void>;
}

export interface RuntimeRepairsRuntimeInput {
  storage: RuntimeRepairStorageView;
  /** Runs the work only when this Gateway is admitted to background cron work on a shared host. */
  runAdmitted: (label: string, work: () => Promise<void>) => Promise<unknown>;
  now?: () => number;
}

/** Route-composition entry point: builds the sweep runtime from the Gateway's composition port. */
export function composeRuntimeRepairs(gateway: GatewayRouteCompositionPort): RuntimeRepairsRuntime {
  return createRuntimeRepairsRuntime({ storage: gateway.storage, runAdmitted: gateway.runSharedHostCronWork });
}

export function createRuntimeRepairsRuntime(input: RuntimeRepairsRuntimeInput): RuntimeRepairsRuntime {
  const now = input.now ?? Date.now;
  const sweep = new RuntimeRepairSweepService({
    reads: createRuntimeRepairReadPort(input.storage),
    audit: createRuntimeRepairAuditPort(input.storage),
    now,
    newId: randomUUID,
    onError: (message, error) =>
      logger.warn(message, { error: error instanceof Error ? error.message : String(error) }),
  });
  let nextDueAt = now() + RUNTIME_REPAIR_SWEEP_BOOT_DELAY_MS;
  return {
    snapshot: () => sweep.snapshot(),
    runIfDue: async () => {
      if (now() < nextDueAt) return;
      nextDueAt = now() + RUNTIME_REPAIR_SWEEP_INTERVAL_MS;
      try {
        await input.runAdmitted("runtime-repair-sweep", () => sweep.runTick());
      } catch (error) {
        logger.warn("runtime repair sweep could not run", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
