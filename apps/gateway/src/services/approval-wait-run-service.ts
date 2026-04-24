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
import type { RequestAttribution, Storage } from "@goatcitadel/storage";
import type { RuntimeSettings } from "./gateway/runtime-settings.js";

export interface ApprovalWaitRunServiceDeps {
  createDurableRun(input: DurableRunCreateRequest): DurableRunRecord;
  getDurableRun(runId: string): DurableRunRecord;
  getRequestAttribution?: () => RequestAttribution | undefined;
}

export interface ApprovalWaitRunServiceContext {
  readonly storage: Storage;
  isFeatureEnabled(flag: keyof RuntimeSettings["features"]): boolean;
  publishRealtime(
    eventType: string,
    source: string,
    payload: Record<string, unknown>,
    options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">,
  ): void;
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
    return {
      approvalId: approval.approvalId,
      sessionId: approval.linkage?.sessionId,
      taskId: approval.linkage?.taskId,
      runId: approval.linkage?.durableRunId,
      proactiveRunId: approval.linkage?.proactiveRunId,
      workspaceId: approval.linkage?.workspaceId,
      connectorId: approval.linkage?.connectorId,
      tokenId: approval.linkage?.tokenId,
    };
  }

  public primeApprovalLifecycle(approvalId: string, linkage?: ApprovalLinkage): ApprovalRequest {
    let approval = this.ctx.storage.approvals.get(approvalId);
    if (linkage) {
      approval = this.ctx.storage.approvals.mergeLinkage(approvalId, linkage);
    }
    const waitRun = this.ensureApprovalWaitDurableRun(approval);
    if (waitRun?.runId && approval.linkage?.durableRunId !== waitRun.runId) {
      approval = this.ctx.storage.approvals.mergeLinkage(approval.approvalId, { durableRunId: waitRun.runId });
    }
    return approval;
  }

  public ensureApprovalWaitDurableRun(approval: ApprovalRequest): DurableRunRecord | undefined {
    if (!this.ctx.isFeatureEnabled("durableKernelV1Enabled")) {
      return undefined;
    }
    const existing = this.ctx.storage.approvalWaitRuns.get(approval.approvalId);
    if (existing?.runId) {
      try {
        return this.deps.getDurableRun(existing.runId);
      } catch (error) {
        if (!(error instanceof NotFoundError)) {
          throw error;
        }
        // Fall through and repair the mapping with a new waiting run.
      }
    }
    const requestAttribution = this.getCurrentRequestAttribution();
    const run = this.deps.createDurableRun({
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
    this.ctx.storage.approvalWaitRuns.upsert({
      approvalId: approval.approvalId,
      runId: run.runId,
      createdAt: new Date().toISOString(),
    });
    return run;
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
