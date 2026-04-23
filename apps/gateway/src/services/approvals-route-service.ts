import type { GatewayService } from "./gateway-service.js";

type ApprovalsRouteGateway = Pick<
  GatewayService,
  | "createApproval"
  | "createApprovalRemoteActionToken"
  | "getApprovalReplay"
  | "listApprovals"
  | "resolveApproval"
  | "resolveApprovalWithRemoteToken"
  | "resolveApprovalsBulk"
>;

export class ApprovalsRouteService {
  public constructor(private readonly gateway: ApprovalsRouteGateway) {}

  public async createApproval(input: Parameters<ApprovalsRouteGateway["createApproval"]>[0]) {
    return this.gateway.createApproval(input);
  }

  public listApprovals(
    status?: Parameters<ApprovalsRouteGateway["listApprovals"]>[0],
    limit?: Parameters<ApprovalsRouteGateway["listApprovals"]>[1],
  ) {
    return this.gateway.listApprovals(status, limit);
  }

  public async resolveApprovalsBulk(input: Parameters<ApprovalsRouteGateway["resolveApprovalsBulk"]>[0]) {
    return this.gateway.resolveApprovalsBulk(input);
  }

  public async resolveApproval(
    approvalId: Parameters<ApprovalsRouteGateway["resolveApproval"]>[0],
    input: Parameters<ApprovalsRouteGateway["resolveApproval"]>[1],
  ) {
    return this.gateway.resolveApproval(approvalId, input);
  }

  public createApprovalRemoteActionToken(
    approvalId: Parameters<ApprovalsRouteGateway["createApprovalRemoteActionToken"]>[0],
    input: Parameters<ApprovalsRouteGateway["createApprovalRemoteActionToken"]>[1],
  ) {
    return this.gateway.createApprovalRemoteActionToken(approvalId, input);
  }

  public async resolveApprovalWithRemoteToken(
    input: Parameters<ApprovalsRouteGateway["resolveApprovalWithRemoteToken"]>[0],
  ) {
    return this.gateway.resolveApprovalWithRemoteToken(input);
  }

  public getApprovalReplay(
    approvalId: Parameters<ApprovalsRouteGateway["getApprovalReplay"]>[0],
    replayedBy?: Parameters<ApprovalsRouteGateway["getApprovalReplay"]>[1],
  ) {
    return this.gateway.getApprovalReplay(approvalId, replayedBy);
  }
}
