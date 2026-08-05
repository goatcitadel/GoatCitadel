import type {
  ApprovalBulkResolveInput,
  ApprovalBulkResolveResult,
  ApprovalCreateInput,
  ApprovalListResponse,
  ApprovalRequest,
  ApprovalResolveInput,
  ToolGrantCreateInput,
  ToolGrantRecord,
  ToolGrantScope,
} from "@goatcitadel/contracts";
import type { ApprovalCreateAuthority } from "@goatcitadel/policy-engine";
import type {
  ApprovalReplayResult,
  ApprovalResolutionContext,
  ApprovalResolveResult,
  RemoteApprovalActionTokenIssueResult,
} from "./approval-types.js";
import type { ApprovalCreateCommitHook, ApprovalLifecycleHost } from "./approval-lifecycle-service.js";
import type { ApprovalRemoteActionContext } from "./approval-remote-action-service.js";
import * as approvalLifecycleService from "./approval-lifecycle-service.js";
import * as approvalRemoteActionService from "./approval-remote-action-service.js";

export interface ApprovalRuntime {
  listToolGrants(scope?: ToolGrantScope, scopeRef?: string, limit?: number): Promise<ToolGrantRecord[]>;
  createToolGrant(input: ToolGrantCreateInput): Promise<ToolGrantRecord>;
  revokeToolGrant(grantId: string, revokedBy: string): Promise<boolean>;
  createApproval(
    input: ApprovalCreateInput,
    onCreated?: ApprovalCreateCommitHook,
    authority?: ApprovalCreateAuthority,
  ): Promise<ApprovalRequest>;
  createApprovalRemoteActionToken(
    approvalId: string,
    input: {
      connectorId: string;
      issuedBy?: string;
      expiresInMs?: number;
    },
  ): Promise<RemoteApprovalActionTokenIssueResult>;
  resolveApprovalWithRemoteToken(input: {
    token: string;
    connectorId: string;
    decision: ApprovalResolveInput["decision"];
    editedPayload?: Record<string, unknown>;
    resolutionNote?: string;
    resolvedBy?: string;
  }): Promise<ApprovalResolveResult>;
  resolveApprovalWithRemoteTokenId(input: {
    tokenId: string;
    connectorId: string;
    decision: ApprovalResolveInput["decision"];
    editedPayload?: Record<string, unknown>;
    resolutionNote?: string;
    resolvedBy?: string;
  }): Promise<ApprovalResolveResult>;
  listApprovals(status?: ApprovalRequest["status"], limit?: number, workspaceId?: string): Promise<ApprovalRequest[]>;
  listApprovalsPage(input: {
    status?: ApprovalRequest["status"];
    limit?: number;
    cursor?: string;
    workspaceId?: string;
  }): Promise<ApprovalListResponse>;
  resolveApprovalsBulk(input: ApprovalBulkResolveInput): Promise<ApprovalBulkResolveResult>;
  expirePendingApprovals(limit?: number): Promise<number>;
  getApprovalReplay(approvalId: string, replayedBy?: string): Promise<ApprovalReplayResult>;
  resolveApproval(
    approvalId: string,
    input: ApprovalResolveInput,
    context?: ApprovalResolutionContext,
  ): Promise<ApprovalResolveResult>;
  resolveChatToolApproval(
    sessionId: string,
    approvalId: string,
    decision: "approve" | "reject",
    options?: {
      allowScope?: "once" | "session" | "workspace";
      resolvedBy?: string;
    },
  ): Promise<{
    allowScope: "once" | "session" | "workspace";
    grant?: ToolGrantRecord;
    grantError?: string;
    resumed: boolean;
    resumedTurnId?: string;
    resumedRunId?: string;
  }>;
}

export class ApprovalRuntimeService implements ApprovalRuntime {
  public constructor(private readonly host: ApprovalLifecycleHost & ApprovalRemoteActionContext) {}

  public async listToolGrants(scope?: ToolGrantScope, scopeRef?: string, limit = 200): Promise<ToolGrantRecord[]> {
    return approvalLifecycleService.listToolGrants(this.host, scope, scopeRef, limit);
  }

  public async createToolGrant(input: ToolGrantCreateInput): Promise<ToolGrantRecord> {
    return approvalLifecycleService.createToolGrant(this.host, input);
  }

  public async revokeToolGrant(grantId: string, revokedBy: string): Promise<boolean> {
    return approvalLifecycleService.revokeToolGrant(this.host, grantId, revokedBy);
  }

  public async createApproval(
    input: ApprovalCreateInput,
    onCreated?: ApprovalCreateCommitHook,
    authority?: ApprovalCreateAuthority,
  ): Promise<ApprovalRequest> {
    return authority
      ? approvalLifecycleService.createApproval(this.host, input, onCreated, authority)
      : approvalLifecycleService.createApproval(this.host, input, onCreated);
  }

  public async createApprovalRemoteActionToken(
    approvalId: string,
    input: {
      connectorId: string;
      issuedBy?: string;
      expiresInMs?: number;
    },
  ): Promise<RemoteApprovalActionTokenIssueResult> {
    return approvalRemoteActionService.createApprovalRemoteActionToken(this.host, approvalId, input);
  }

  public async resolveApprovalWithRemoteToken(input: {
    token: string;
    connectorId: string;
    decision: ApprovalResolveInput["decision"];
    editedPayload?: Record<string, unknown>;
    resolutionNote?: string;
    resolvedBy?: string;
  }): Promise<ApprovalResolveResult> {
    return approvalRemoteActionService.resolveApprovalWithRemoteToken(this.host, input);
  }

  public async resolveApprovalWithRemoteTokenId(input: {
    tokenId: string;
    connectorId: string;
    decision: ApprovalResolveInput["decision"];
    editedPayload?: Record<string, unknown>;
    resolutionNote?: string;
    resolvedBy?: string;
  }): Promise<ApprovalResolveResult> {
    return approvalRemoteActionService.resolveApprovalWithRemoteTokenId(this.host, input);
  }

  public async listApprovals(
    status?: ApprovalRequest["status"],
    limit = 100,
    workspaceId?: string,
  ): Promise<ApprovalRequest[]> {
    return approvalLifecycleService.listApprovals(this.host, status, limit, workspaceId);
  }

  public async listApprovalsPage(input: {
    status?: ApprovalRequest["status"];
    limit?: number;
    cursor?: string;
    workspaceId?: string;
  }): Promise<ApprovalListResponse> {
    return approvalLifecycleService.listApprovalsPage(this.host, input);
  }

  public async resolveApprovalsBulk(input: ApprovalBulkResolveInput): Promise<ApprovalBulkResolveResult> {
    return approvalLifecycleService.resolveApprovalsBulk(this.host, input);
  }

  public async expirePendingApprovals(limit = 100): Promise<number> {
    return approvalLifecycleService.expirePendingApprovals(this.host, limit);
  }

  public async getApprovalReplay(approvalId: string, replayedBy = "operator"): Promise<ApprovalReplayResult> {
    return approvalLifecycleService.getApprovalReplay(this.host, approvalId, replayedBy);
  }

  public async resolveApproval(
    approvalId: string,
    input: ApprovalResolveInput,
    context?: ApprovalResolutionContext,
  ): Promise<ApprovalResolveResult> {
    return approvalLifecycleService.resolveApproval(this.host, approvalId, input, context);
  }

  public async resolveChatToolApproval(
    sessionId: string,
    approvalId: string,
    decision: "approve" | "reject",
    options?: {
      allowScope?: "once" | "session" | "workspace";
      resolvedBy?: string;
    },
  ): Promise<{
    allowScope: "once" | "session" | "workspace";
    grant?: ToolGrantRecord;
    grantError?: string;
    resumed: boolean;
    resumedTurnId?: string;
    resumedRunId?: string;
  }> {
    return approvalLifecycleService.resolveChatToolApproval(this.host, sessionId, approvalId, decision, options);
  }
}
