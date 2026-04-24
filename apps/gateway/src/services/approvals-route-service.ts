import type { ApprovalRuntime } from "./approval-runtime-service.js";

type ApprovalsRoutePort = Pick<
  ApprovalRuntime,
  | "createApproval"
  | "createApprovalRemoteActionToken"
  | "getApprovalReplay"
  | "listApprovals"
  | "resolveApproval"
  | "resolveApprovalWithRemoteToken"
  | "resolveApprovalsBulk"
>;

export class ApprovalsRouteService {
  public constructor(private readonly approvals: ApprovalsRoutePort) {}

  public async createApproval(input: Parameters<ApprovalsRoutePort["createApproval"]>[0]) {
    return this.approvals.createApproval(input);
  }

  public listApprovals(
    status?: Parameters<ApprovalsRoutePort["listApprovals"]>[0],
    limit?: Parameters<ApprovalsRoutePort["listApprovals"]>[1],
  ) {
    return this.approvals.listApprovals(status, limit);
  }

  public async resolveApprovalsBulk(input: Parameters<ApprovalsRoutePort["resolveApprovalsBulk"]>[0]) {
    return this.approvals.resolveApprovalsBulk(input);
  }

  public async resolveApproval(
    approvalId: Parameters<ApprovalsRoutePort["resolveApproval"]>[0],
    input: Parameters<ApprovalsRoutePort["resolveApproval"]>[1],
  ) {
    return this.approvals.resolveApproval(approvalId, input);
  }

  public createApprovalRemoteActionToken(
    approvalId: Parameters<ApprovalsRoutePort["createApprovalRemoteActionToken"]>[0],
    input: Parameters<ApprovalsRoutePort["createApprovalRemoteActionToken"]>[1],
  ) {
    return this.approvals.createApprovalRemoteActionToken(approvalId, input);
  }

  public async resolveApprovalWithRemoteToken(
    input: Parameters<ApprovalsRoutePort["resolveApprovalWithRemoteToken"]>[0],
  ) {
    return this.approvals.resolveApprovalWithRemoteToken(input);
  }

  public getApprovalReplay(
    approvalId: Parameters<ApprovalsRoutePort["getApprovalReplay"]>[0],
    replayedBy?: Parameters<ApprovalsRoutePort["getApprovalReplay"]>[1],
  ) {
    return this.approvals.getApprovalReplay(approvalId, replayedBy);
  }
}
