import type {
  ApprovalBulkResolveInput,
  ApprovalBulkResolveResult,
  ApprovalCreateInput,
  ApprovalRequest,
  ApprovalResolveInput,
  ToolGrantCreateInput,
  ToolGrantRecord,
} from "@goatcitadel/contracts";
import type {
  ApprovalReplayResult,
  ApprovalResolveResult,
  RemoteApprovalActionTokenIssueResult,
} from "./gateway-service.js";
import type { ApprovalLifecycleHost } from "./approval-lifecycle-service.js";
import * as approvalLifecycleService from "./approval-lifecycle-service.js";

export interface ApprovalRuntime {
  listToolGrants(
    scope?: "global" | "session" | "workspace" | "agent" | "task",
    scopeRef?: string,
    limit?: number,
  ): ToolGrantRecord[];
  createToolGrant(input: ToolGrantCreateInput): ToolGrantRecord;
  revokeToolGrant(grantId: string): boolean;
  createApproval(input: ApprovalCreateInput): Promise<ApprovalRequest>;
  createApprovalRemoteActionToken(
    approvalId: string,
    input: {
      connectorId: string;
      issuedBy?: string;
      expiresInMs?: number;
    },
  ): RemoteApprovalActionTokenIssueResult;
  resolveApprovalWithRemoteToken(input: {
    token: string;
    decision: ApprovalResolveInput["decision"];
    editedPayload?: Record<string, unknown>;
    resolutionNote?: string;
  }): Promise<ApprovalResolveResult>;
  resolveApprovalWithRemoteTokenId(input: {
    tokenId: string;
    decision: ApprovalResolveInput["decision"];
    editedPayload?: Record<string, unknown>;
    resolutionNote?: string;
  }): Promise<ApprovalResolveResult>;
  listApprovals(status?: ApprovalRequest["status"], limit?: number): ApprovalRequest[];
  resolveApprovalsBulk(input: ApprovalBulkResolveInput): Promise<ApprovalBulkResolveResult>;
  getApprovalReplay(approvalId: string, replayedBy?: string): ApprovalReplayResult;
  resolveApproval(approvalId: string, input: ApprovalResolveInput): Promise<ApprovalResolveResult>;
  resolveChatToolApproval(
    sessionId: string,
    approvalId: string,
    decision: "approve" | "reject",
    options?: {
      allowScope?: "once" | "session" | "workspace";
    },
  ): Promise<{
    allowScope: "once" | "session" | "workspace";
    grant?: ToolGrantRecord;
    resumed: boolean;
    resumedTurnId?: string;
    resumedRunId?: string;
  }>;
}

export class ApprovalRuntimeService implements ApprovalRuntime {
  public constructor(private readonly host: ApprovalLifecycleHost) {}

  public listToolGrants(
    scope?: "global" | "session" | "workspace" | "agent" | "task",
    scopeRef?: string,
    limit = 200,
  ): ToolGrantRecord[] {
    return approvalLifecycleService.listToolGrants(this.host, scope, scopeRef, limit);
  }

  public createToolGrant(input: ToolGrantCreateInput): ToolGrantRecord {
    return approvalLifecycleService.createToolGrant(this.host, input);
  }

  public revokeToolGrant(grantId: string): boolean {
    return approvalLifecycleService.revokeToolGrant(this.host, grantId);
  }

  public async createApproval(input: ApprovalCreateInput): Promise<ApprovalRequest> {
    return approvalLifecycleService.createApproval(this.host, input);
  }

  public createApprovalRemoteActionToken(
    approvalId: string,
    input: {
      connectorId: string;
      issuedBy?: string;
      expiresInMs?: number;
    },
  ): RemoteApprovalActionTokenIssueResult {
    return approvalLifecycleService.createApprovalRemoteActionToken(this.host, approvalId, input);
  }

  public async resolveApprovalWithRemoteToken(input: {
    token: string;
    decision: ApprovalResolveInput["decision"];
    editedPayload?: Record<string, unknown>;
    resolutionNote?: string;
  }): Promise<ApprovalResolveResult> {
    return approvalLifecycleService.resolveApprovalWithRemoteToken(this.host, input);
  }

  public async resolveApprovalWithRemoteTokenId(input: {
    tokenId: string;
    decision: ApprovalResolveInput["decision"];
    editedPayload?: Record<string, unknown>;
    resolutionNote?: string;
  }): Promise<ApprovalResolveResult> {
    return approvalLifecycleService.resolveApprovalWithRemoteTokenId(this.host, input);
  }

  public listApprovals(status?: ApprovalRequest["status"], limit = 100): ApprovalRequest[] {
    return approvalLifecycleService.listApprovals(this.host, status, limit);
  }

  public async resolveApprovalsBulk(input: ApprovalBulkResolveInput): Promise<ApprovalBulkResolveResult> {
    return approvalLifecycleService.resolveApprovalsBulk(this.host, input);
  }

  public getApprovalReplay(approvalId: string, replayedBy = "operator"): ApprovalReplayResult {
    return approvalLifecycleService.getApprovalReplay(this.host, approvalId, replayedBy);
  }

  public async resolveApproval(approvalId: string, input: ApprovalResolveInput): Promise<ApprovalResolveResult> {
    return approvalLifecycleService.resolveApproval(this.host, approvalId, input);
  }

  public async resolveChatToolApproval(
    sessionId: string,
    approvalId: string,
    decision: "approve" | "reject",
    options?: {
      allowScope?: "once" | "session" | "workspace";
    },
  ): Promise<{
    allowScope: "once" | "session" | "workspace";
    grant?: ToolGrantRecord;
    resumed: boolean;
    resumedTurnId?: string;
    resumedRunId?: string;
  }> {
    return approvalLifecycleService.resolveChatToolApproval(this.host, sessionId, approvalId, decision, options);
  }
}
