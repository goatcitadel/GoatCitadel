/**
 * Resolves the turn's policy scope once for the base prompt's tool catalog. Each catalog probe used to resolve the
 * same permission profile and Citadel again, one storage round trip per callable tool; a probe request that already
 * carries its workspace, Citadel and resolved policy context skips both lookups at evaluation time.
 *
 * The context matches what evaluation resolves for a probe without one (operator `system`, the turn's session,
 * workspace and surface), so the catalog is unchanged. A failed lookup rejects, and the caller refuses every tool.
 */

import type { PermissionSurface, ToolAccessEvaluateRequest, ToolPolicyActorContext } from "@goatcitadel/contracts";
import type { BasePromptCatalogScope, BasePromptToolAccessProbe } from "./base-prompt-capability-catalog.js";

export interface BasePromptPolicyScopeHost {
  resolveToolPolicyContext(input: {
    operatorId: string;
    workspaceId: string;
    sessionId: string;
    surface: PermissionSurface;
  }): Promise<ToolPolicyActorContext>;
  findWorkspace(id: string): Promise<{ citadelId?: string } | undefined>;
}

export interface BasePromptPolicyScope {
  workspaceId: string;
  citadelId?: string;
  policyContext: ToolPolicyActorContext;
}

export async function resolveBasePromptPolicyScope(
  host: BasePromptPolicyScopeHost,
  scope: { sessionId: string; workspaceId: string; mode: PermissionSurface },
): Promise<BasePromptPolicyScope> {
  const [workspace, policyContext] = await Promise.all([
    host.findWorkspace(scope.workspaceId),
    host.resolveToolPolicyContext({
      operatorId: "system",
      workspaceId: scope.workspaceId,
      sessionId: scope.sessionId,
      surface: scope.mode,
    }),
  ]);
  return {
    workspaceId: scope.workspaceId,
    ...(workspace?.citadelId ? { citadelId: workspace.citadelId } : {}),
    policyContext,
  };
}

/**
 * The catalog's tool access probe for a turn scope: every probe request carries the policy scope resolved on the
 * first call, so the lookup runs at most once per catalog build. When it fails, every probe rejects, which the
 * catalog filter treats as not callable. A scope without a workspace keeps per-probe resolution, which reads the
 * workspace from the session.
 */
export function withBasePromptPolicyScope(
  scope: BasePromptCatalogScope,
  host: Pick<BasePromptPolicyScopeHost, "resolveToolPolicyContext"> & { inspectToolAccess: BasePromptToolAccessProbe },
  findWorkspace: BasePromptPolicyScopeHost["findWorkspace"],
): BasePromptToolAccessProbe {
  const workspaceId = scope.workspaceId;
  if (!workspaceId) return (request) => host.inspectToolAccess(request);
  const scopeHost: BasePromptPolicyScopeHost = {
    resolveToolPolicyContext: (input) => host.resolveToolPolicyContext(input),
    findWorkspace,
  };
  let resolved: Promise<BasePromptPolicyScope> | undefined;
  return async (request: ToolAccessEvaluateRequest) =>
    host.inspectToolAccess({
      ...request,
      ...(await (resolved ??= resolveBasePromptPolicyScope(scopeHost, { ...scope, workspaceId }))),
    });
}
