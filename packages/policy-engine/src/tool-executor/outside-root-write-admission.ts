import {
  isOutsideRootWriteTool,
  type ToolGrantRecord,
  type ToolInvokeRequest,
  type ToolPolicyConfig,
} from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import { getVerifiedApprovalBypassId } from "../approval-bypass.js";
import { evaluateOutsideRootWrites, readRegisteredOutsideRootWrite } from "../outside-root-write-policy.js";
import { isOutsideRootWriteEnabled } from "../sandbox/outside-root-write.js";
import type { ToolWriteAdmission } from "../sandbox/tool-write-gate.js";
import { matchesToolPattern } from "../tool-patterns.js";
import { extractWritePathCandidates } from "../write-path-candidates.js";

type EligibilityHook = (
  request: Pick<ToolInvokeRequest, "sessionId" | "workspaceId" | "agentId" | "policyContext">,
) => Promise<boolean>;

/**
 * Execution-time re-check for writes outside every write root. Admission comes
 * only from storage: the matched folder grant (active, allow, same tool, and
 * scoped to this session or workspace) or the exact approved request's
 * engine-authored registration record. Paths carried on the request are never
 * trusted; everything is re-resolved and re-checked here.
 */
export async function resolveExecutionWriteAdmission(
  request: ToolInvokeRequest,
  config: ToolPolicyConfig,
  storage: AsyncStorage | undefined,
  isEligible: EligibilityHook | undefined,
): Promise<ToolWriteAdmission | undefined> {
  if (!storage || !isEligible || !isOutsideRootWriteTool(request.toolName) || !isOutsideRootWriteEnabled(config.sandbox)) {
    return undefined;
  }
  const grant = await resolveScopedFolderGrant(request, storage);
  const evaluation = await evaluateOutsideRootWrites(request, extractWritePathCandidates(request), grant ? [grant] : [], {
    sandbox: config.sandbox,
    isEligible: async () => (await isEligible(request)) === true,
    verifiedApprovalId: () => getVerifiedApprovalBypassId(request, storage),
    registeredDetails: async (approvalId) =>
      readRegisteredOutsideRootWrite(await storage.approvalEvents.listByApprovalId(approvalId)),
  });
  return evaluation.status === "admitted" ? { roots: evaluation.roots } : undefined;
}

async function resolveScopedFolderGrant(
  request: ToolInvokeRequest,
  storage: AsyncStorage,
): Promise<ToolGrantRecord | undefined> {
  const grantId = request.policyContext?.matchedGrantId?.trim();
  if (!grantId) return undefined;
  const grant = await storage.toolGrants.findActive(grantId);
  if (
    !grant ||
    grant.decision !== "allow" ||
    !grant.constraints?.writeRoots?.length ||
    !matchesToolPattern(grant.toolPattern, request.toolName)
  ) {
    return undefined;
  }
  const scopeMatches =
    (grant.scope === "session" && grant.scopeRef === request.sessionId) ||
    (grant.scope === "workspace" && Boolean(request.workspaceId) && grant.scopeRef === request.workspaceId);
  return scopeMatches ? grant : undefined;
}
