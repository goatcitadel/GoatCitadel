/** Approvals + tool-grants domain slice. Pure re-exports from client.ts. */
export {
  fetchApprovals,
  resolveApproval,
  resolveApprovalsBulk,
  resolveApprovalWithRemoteToken,
  fetchApprovalReplay,
  fetchToolCatalog,
  evaluateToolAccess,
  fetchToolGrants,
  createToolGrant,
  revokeToolGrant,
  invokeTool,
} from "./client.js";
