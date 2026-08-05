import {
  NotFoundError,
  type ApprovalLinkage,
  type ApprovalRequest,
  type ApprovalWaitWorkflowPayload,
  type DurableRunCreateRequest,
  type DurableRunRecord,
  type RealtimeEventLinks,
  type RealtimeEvent,
} from "@goatcitadel/contracts";
import { randomUUID } from "node:crypto";
import type { RequestAttribution, AsyncStorage as Storage } from "@goatcitadel/storage";
import type { RuntimeSettings } from "./gateway/runtime-settings.js";
import { buildApprovalRealtimeLinks } from "./approval-observability.js";

export interface ApprovalWaitRunServiceDeps {
  createDurableRun(input: DurableRunCreateRequest): Promise<DurableRunRecord>;
  getDurableRun(runId: string): Promise<DurableRunRecord>;
  getRequestAttribution?: () => RequestAttribution | undefined;
  createApprovalWaitRunId?: () => string;
}

export interface ApprovalWaitRunServiceContext {
  readonly storage: Storage;
  isFeatureEnabled(flag: keyof RuntimeSettings["features"]): Promise<boolean>;
  publishRealtime(
    eventType: string,
    source: string,
    payload: Record<string, unknown>,
    options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">,
  ): Promise<unknown>;
}

export class ApprovalWaitRunService {
  public constructor(
    private readonly ctx: ApprovalWaitRunServiceContext,
    private readonly deps: ApprovalWaitRunServiceDeps,
  ) {}

  public buildApprovalLinkage(linkage?: ApprovalLinkage): ApprovalLinkage | undefined {
    const requestAttribution = this.getCurrentRequestAttribution();
    const normalized = Object.fromEntries(
      Object.entries({
        ...linkage,
        correlationId: linkage?.correlationId ?? requestAttribution.correlationId,
        traceId: linkage?.traceId ?? requestAttribution.traceId,
      }).filter(([, value]) => typeof value === "string" && value.trim().length > 0),
    ) as ApprovalLinkage;
    return Object.keys(normalized).length > 0 ? normalized : undefined;
  }

  public buildApprovalRealtimeLinks(approval: ApprovalRequest): RealtimeEventLinks {
    return buildApprovalRealtimeLinks(approval);
  }

  public async primeApprovalLifecycle(approvalId: string, linkage?: ApprovalLinkage): Promise<ApprovalRequest> {
    let approval = await this.ctx.storage.approvals.get(approvalId);
    if (linkage) {
      approval = await this.ctx.storage.approvals.mergeLinkage(approvalId, linkage);
    }
    const existingReservation = await this.ctx.storage.approvalWaitRuns.get(approval.approvalId);
    if (approval.status !== "pending" && !existingReservation) {
      return approval;
    }
    if (approval.status === "pending") {
      approval = await this.reserveApprovalWaitRun(approval);
    }
    const waitRun = await this.ensureApprovalWaitDurableRun(approval);
    if (waitRun?.runId && approval.linkage?.durableRunId !== waitRun.runId) {
      approval = await this.ctx.storage.approvals.mergeLinkage(approval.approvalId, { durableRunId: waitRun.runId });
    }
    return approval;
  }

  /**
   * Reserves the wait-run identity in the approval transaction. Resolution can
   * then enqueue a wake against that identity even if durable-run materializing
   * happens on another node after the approval commits.
   */
  public async reserveApprovalWaitRun(approval: ApprovalRequest): Promise<ApprovalRequest> {
    if (!(await this.ctx.isFeatureEnabled("durableKernelV1Enabled")) || approval.status !== "pending") {
      return approval;
    }
    const preferredRunId =
      approval.linkage?.durableRunId?.trim() || this.deps.createApprovalWaitRunId?.() || randomUUID();
    const reservation = await this.ctx.storage.approvalWaitRuns.createOrGet({
      approvalId: approval.approvalId,
      runId: preferredRunId,
    });
    if (approval.linkage?.durableRunId === reservation.runId) {
      return approval;
    }
    return this.ctx.storage.approvals.mergeLinkage(approval.approvalId, { durableRunId: reservation.runId });
  }

  public async ensureApprovalWaitDurableRun(approval: ApprovalRequest): Promise<DurableRunRecord | undefined> {
    if (!(await this.ctx.isFeatureEnabled("durableKernelV1Enabled"))) {
      return undefined;
    }
    let reservation = await this.ctx.storage.approvalWaitRuns.get(approval.approvalId);
    if (!reservation && approval.status === "pending") {
      await this.reserveApprovalWaitRun(approval);
      reservation = await this.ctx.storage.approvalWaitRuns.get(approval.approvalId);
    }
    if (!reservation?.runId) {
      return undefined;
    }
    if (reservation.runId) {
      try {
        return await this.deps.getDurableRun(reservation.runId);
      } catch (error) {
        if (!(error instanceof NotFoundError)) {
          throw error;
        }
        // Fall through and materialize the transactionally reserved identity.
      }
    }
    const requestAttribution = this.getCurrentRequestAttribution();
    try {
      return await this.deps.createDurableRun({
        runId: reservation.runId,
        workflowKey: "approval.wait",
        payload: approvalWaitPayloadToRecord({
          version: "approval.wait.v1",
          approvalId: approval.approvalId,
          approvalKind: approval.kind,
          createdAt: approval.createdAt,
          correlationId: requestAttribution.correlationId,
          traceId: requestAttribution.traceId,
          originSurface: requestAttribution.originSurface,
        }),
        metadata: {
          approvalId: approval.approvalId,
          approvalKind: approval.kind,
        },
        waitForEvent: {
          eventKey: "approval.resolved",
          correlationId: approval.approvalId,
        },
      });
    } catch (error) {
      try {
        return await this.deps.getDurableRun(reservation.runId);
      } catch {
        throw error;
      }
    }
  }

  private getCurrentRequestAttribution(): {
    correlationId?: string;
    traceId?: string;
    originSurface?: string;
  } {
    const attribution = this.deps.getRequestAttribution?.();
    return {
      correlationId: typeof attribution?.correlationId === "string" ? attribution.correlationId : undefined,
      traceId: typeof attribution?.traceId === "string" ? attribution.traceId : undefined,
      originSurface: typeof attribution?.originSurface === "string" ? attribution.originSurface : undefined,
    };
  }
}

function approvalWaitPayloadToRecord(payload: ApprovalWaitWorkflowPayload): Record<string, unknown> {
  return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined));
}
