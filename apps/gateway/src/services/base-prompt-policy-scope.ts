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

/** Resolves the actor context evaluation would resolve for a probe that carries none. */
export type BasePromptPolicyContextResolver = (input: {
  operatorId: string;
  workspaceId: string;
  sessionId: string;
  surface: PermissionSurface;
}) => Promise<ToolPolicyActorContext>;

/** Reads the scope's workspace, for its Citadel. */
export type BasePromptWorkspaceReader = (id: string) => Promise<{ citadelId?: string } | undefined>;

/**
 * Marks a probe request whose workspace was already read and has no Citadel, so evaluation does not read it again.
 * A symbol key keeps it off the request contract; only requests built by this scope carry it.
 */
export const WORKSPACE_HAS_NO_CITADEL = Symbol("goatcitadel.workspaceHasNoCitadel");

export interface BasePromptPolicyScope {
  workspaceId: string;
  citadelId?: string;
  policyContext: ToolPolicyActorContext;
  [WORKSPACE_HAS_NO_CITADEL]?: true;
}

export async function resolveBasePromptPolicyScope(
  resolvePolicyContext: BasePromptPolicyContextResolver,
  findWorkspace: BasePromptWorkspaceReader,
  scope: { sessionId: string; workspaceId: string; mode: PermissionSurface },
): Promise<BasePromptPolicyScope> {
  const [workspace, policyContext] = await Promise.all([
    findWorkspace(scope.workspaceId),
    resolvePolicyContext({
      operatorId: "system",
      workspaceId: scope.workspaceId,
      sessionId: scope.sessionId,
      surface: scope.mode,
    }),
  ]);
  return {
    workspaceId: scope.workspaceId,
    ...(workspace?.citadelId ? { citadelId: workspace.citadelId } : { [WORKSPACE_HAS_NO_CITADEL]: true as const }),
    policyContext,
  };
}

/** The request's Citadel: its own, none for a scope that already read a workspace without one, else the workspace's. */
export async function resolveProbeCitadelId(
  request: ToolAccessEvaluateRequest,
  workspaceId: string,
  findWorkspace: BasePromptWorkspaceReader,
): Promise<string | undefined> {
  if (request.citadelId) return request.citadelId;
  if (WORKSPACE_HAS_NO_CITADEL in request) return undefined;
  return (await findWorkspace(workspaceId))?.citadelId;
}

/**
 * The catalog's tool access probe for a turn scope: every probe request carries the policy scope resolved on the
 * first call, so the lookup runs at most once per catalog build. When it fails, every probe rejects, which the
 * catalog filter treats as not callable. A scope without a workspace keeps per-probe resolution, which reads the
 * workspace from the session.
 */
export function withBasePromptPolicyScope(
  scope: BasePromptCatalogScope,
  inspect: BasePromptToolAccessProbe,
  resolvePolicyContext: BasePromptPolicyContextResolver,
  findWorkspace: BasePromptWorkspaceReader,
): BasePromptToolAccessProbe {
  const workspaceId = scope.workspaceId;
  if (!workspaceId) return inspect;
  let resolved: Promise<BasePromptPolicyScope> | undefined;
  return async (request: ToolAccessEvaluateRequest) =>
    inspect({
      ...request,
      ...(await (resolved ??= resolveBasePromptPolicyScope(resolvePolicyContext, findWorkspace, {
        ...scope,
        workspaceId,
      }))),
    });
}
