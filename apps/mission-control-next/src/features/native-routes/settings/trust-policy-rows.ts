import type {
  TrustPolicyLastUseEvidence,
  TrustPolicyPosture,
  TrustPolicySnapshot,
} from "@goatcitadel/mission-control-shared/api/trust";
import type { TrustPolicyDashboardStatus, TrustPolicyMatrixRow } from "./trust-policy-types";
import { normalizeTrustPolicyStatus } from "./trust-policy-filters";

export function buildTrustPolicyRows(snapshot: TrustPolicySnapshot | null | undefined): TrustPolicyMatrixRow[] {
  if (!snapshot) {
    return [];
  }
  const rows: TrustPolicyMatrixRow[] = [];
  const callableCapabilityIds = new Set(snapshot.capabilities.callable.map((item) => item.capabilityId));
  const capabilitiesById = new Map(
    [...snapshot.capabilities.inspectable, ...snapshot.capabilities.callable].map((item) => [item.capabilityId, item]),
  );
  for (const capability of capabilitiesById.values()) {
    const callable = Boolean(capability.callable || callableCapabilityIds.has(capability.capabilityId));
    rows.push({
      id: `capability:${capability.capabilityId}`,
      kind: "capability",
      label: capability.title ?? capability.capabilityId,
      source: capability.source,
      status: capability.reviewWarning
        ? "blocked"
        : callable
          ? statusForPosture(capability.posture)
          : capability.proposalId || capability.candidateId
            ? "experimental"
            : "not_callable",
      trustState: capability.trustLabel ?? capability.lifecycleState ?? "Unknown",
      callable,
      callableState: callable ? "callable" : "inspectable",
      grants: capability.declaredTools,
      blockers: [capability.reviewWarning, ...(capability.requires ?? []).map((item) => `Requires ${item}`)].filter(
        (item): item is string => Boolean(item?.trim()),
      ),
      lastUse: null,
    });
  }
  for (const grant of snapshot.toolGrants) {
    const status = grant.decision === "deny" || grant.revokedAt ? "blocked" : statusForPosture(grant.posture);
    rows.push({
      id: `tool-grant:${grant.grantId ?? grant.toolPattern ?? rows.length}`,
      kind: "tool",
      label: grant.toolPattern ?? grant.grantId ?? "Tool grant",
      source: grant.source,
      status,
      trustState: grant.decision ?? "Unknown",
      callable: status === "ready",
      callableState: status === "ready" ? "callable" : "blocked",
      grants: [grant.scope, grant.grantType, grant.scopeRef].filter((item): item is string => Boolean(item)),
      blockers: [
        grant.revokedAt ? "Revoked" : undefined,
        grant.expiresAt ? `Expires ${grant.expiresAt}` : undefined,
      ].filter((item): item is string => Boolean(item)),
      lastUse: null,
    });
  }
  for (const server of snapshot.mcpServers) {
    const evidence = findLastUseEvidence(snapshot.lastUseEvidence, "mcp_server", server.serverId);
    rows.push({
      id: `mcp-server:${server.serverId ?? server.label ?? rows.length}`,
      kind: "source",
      label: server.label ?? server.serverId ?? "MCP server",
      source: server.source,
      status: server.enabled ? statusForPosture(server.posture) : "blocked",
      trustState: server.trustTier ?? server.status ?? "Unknown",
      callable: server.enabled && server.posture === "callable",
      callableState: server.enabled && server.posture === "callable" ? "callable" : "blocked",
      grants: [server.transport, server.policy?.requireFirstToolApproval ? "First tool approval" : undefined].filter(
        (item): item is string => Boolean(item),
      ),
      blockers: [server.lastError, server.enabled ? undefined : "Disabled"].filter((item): item is string =>
        Boolean(item),
      ),
      lastUse: evidenceToLastUse(evidence),
    });
    for (const tool of server.tools) {
      rows.push({
        id: `mcp-tool:${server.serverId ?? server.label}:${tool.toolName ?? rows.length}`,
        kind: "tool",
        label: tool.toolName ?? "MCP tool",
        source: tool.source,
        status: tool.enabled ? statusForPosture(tool.posture) : "blocked",
        trustState: server.trustTier ?? "Unknown",
        callable: tool.enabled && tool.posture === "callable",
        callableState: tool.enabled && tool.posture === "callable" ? "callable" : "blocked",
        grants: [server.label, server.transport].filter((item): item is string => Boolean(item)),
        blockers: tool.enabled ? [] : ["Disabled"],
        lastUse: evidenceToLastUse(evidence),
      });
    }
  }
  for (const skill of snapshot.skills) {
    const evidence = findLastUseEvidence(snapshot.lastUseEvidence, "skill", skill.skillId);
    const elevatedDeclarations = skill.posture === "medium_trust_unverified" || Boolean(skill.bundleWarnings?.length);
    rows.push({
      id: `skill:${skill.skillId ?? skill.name ?? rows.length}`,
      kind: "source",
      label: skill.name ?? skill.skillId ?? "Skill",
      source: skill.source,
      status: skill.reviewWarning
        ? "blocked"
        : elevatedDeclarations
          ? "medium_trust"
          : skill.callable
            ? statusForPosture(skill.posture)
            : skill.lifecycleState === "candidate"
              ? "experimental"
              : "not_callable",
      trustState: skill.trustLabel ?? skill.lifecycleState ?? skill.state,
      callable: skill.callable,
      callableState: skill.callable ? "callable" : "not_callable",
      grants: skill.declaredTools,
      blockers: [skill.reviewWarning, ...(skill.requires ?? []).map((item) => `Requires ${item}`)].filter(
        (item): item is string => Boolean(item?.trim()),
      ),
      declaredMetadata: skill.declaredMetadata,
      bundleWarnings: skill.bundleWarnings,
      missingRequiredEnv: skill.missingRequiredEnv,
      lastUse: evidenceToLastUse(evidence) ?? {
        at: skill.lastUsedAt,
        label: skill.usageCount ? `${skill.usageCount} uses` : undefined,
      },
    });
  }
  for (const addon of snapshot.addons) {
    const evidence = findLastUseEvidence(snapshot.lastUseEvidence, "addon", addon.addonId);
    rows.push({
      id: `addon:${addon.addonId ?? addon.label ?? rows.length}`,
      kind: "source",
      label: addon.label ?? addon.addonId ?? "Add-on",
      source: addon.source,
      status: addon.enabled === false ? "blocked" : statusForPosture(addon.posture),
      trustState: addon.trustTier ?? addon.status,
      callable: addon.enabled !== false && addon.posture === "callable",
      callableState: addon.enabled !== false && addon.posture === "callable" ? "callable" : "blocked",
      grants: [addon.category, addon.runtimeType].filter((item): item is string => Boolean(item)),
      blockers: [addon.lastError, addon.enabled === false ? "Disabled" : undefined].filter((item): item is string =>
        Boolean(item),
      ),
      lastUse: evidenceToLastUse(evidence),
    });
  }
  for (const profile of snapshot.permissionProfiles) {
    const profileCallable = profile.posture === "callable";
    const profileCallableState = profileCallable
      ? profile.approvalMode === "approve_all"
        ? "approval_required"
        : "callable"
      : profile.posture === "non_callable" || profile.posture === "not_installed"
        ? "not_callable"
        : "blocked";
    rows.push({
      id: `permission-profile:${profile.profileId ?? profile.label ?? rows.length}`,
      kind: "source",
      label: profile.label ?? profile.profileId ?? "Permission profile",
      source: profile.source,
      status:
        profileCallable && profile.approvalMode === "approve_all"
          ? "approval_required"
          : statusForPosture(profile.posture),
      trustState: profile.status,
      callable: profileCallable,
      callableState: profileCallableState,
      grants: [profile.scope, profile.approvalMode, ...(profile.allow ?? [])].filter((item): item is string =>
        Boolean(item),
      ),
      blockers: [profile.archivedAt ? "Archived" : undefined, ...(profile.deny ?? [])].filter((item): item is string =>
        Boolean(item),
      ),
      lastUse: null,
    });
  }
  for (const override of snapshot.localOperatorOverrides) {
    rows.push({
      id: `local-override:${override.overrideId ?? rows.length}`,
      kind: "source",
      label: override.reason ?? override.overrideId ?? "Local Operator Override",
      source: override.source,
      status: override.status === "active" ? "approval_required" : statusForPosture(override.posture),
      trustState: override.status,
      callable: override.status === "active",
      callableState: override.status === "active" ? "approval_required" : "blocked",
      grants: [override.scope, override.scopeRef, override.operatorId].filter((item): item is string => Boolean(item)),
      blockers: [
        override.revokedAt ? "Revoked" : undefined,
        override.expiresAt ? `Expires ${override.expiresAt}` : undefined,
      ].filter((item): item is string => Boolean(item)),
      lastUse: null,
    });
  }
  return rows.map(withTrustPolicyOwnerAction);
}

function withTrustPolicyOwnerAction(row: TrustPolicyMatrixRow): TrustPolicyMatrixRow {
  const status = normalizeTrustPolicyStatus(row.status);
  const owner = ownerForTrustPolicyRow(row);
  const blockers = row.blockers?.map((item) => item.trim()).filter(Boolean) ?? [];
  const missingEnv = row.missingRequiredEnv?.map((item) => item.trim()).filter(Boolean) ?? [];
  const actionNeeded =
    missingEnv.length > 0
      ? `Set required env before runtime use: ${missingEnv.join(", ")}.`
      : status === "medium_trust"
        ? "Review the declared env, state directories, and dependencies before trusting this skill."
        : status === "ready"
          ? "No action needed; monitor last-use evidence and grants."
          : status === "approval_required"
            ? "Review the approval or grant before allowing runtime use."
            : status === "blocked" || status === "quarantined"
              ? (blockers[0] ?? "Resolve the blocker in the owner surface before runtime use.")
              : status === "not_callable"
                ? "Use as inspectable context only until an owner promotes it."
                : status === "experimental"
                  ? "Evaluate and approve through the owner lifecycle before promotion."
                  : "Refresh the snapshot or inspect the owner source for missing evidence.";
  return {
    ...row,
    owner,
    actionNeeded,
  };
}

function ownerForTrustPolicyRow(row: TrustPolicyMatrixRow): string {
  switch (row.source) {
    case "tools.permissionProfiles":
      return "Settings / Permissions";
    case "tools.grants":
      return "Settings / Tools";
    case "tools.localOperatorOverrides":
      return "Ops / Approvals";
    case "capabilities.catalog":
      return "Library / Capabilities";
    case "mcp.servers":
    case "mcp.tools":
      return "Settings / MCP";
    case "skills.lifecycle":
      return "Library / Skills";
    case "addons.catalog":
    case "addons.installed":
      return "Settings / Add-ons";
    default:
      return row.kind === "tool"
        ? "Settings / Tools"
        : row.kind === "capability"
          ? "Library / Capabilities"
          : "Settings";
  }
}

function statusForPosture(posture: TrustPolicyPosture | string): TrustPolicyDashboardStatus {
  switch (posture) {
    case "callable":
      return "ready";
    case "non_callable":
    case "not_installed":
      return "not_callable";
    case "quarantined":
      return "quarantined";
    case "medium_trust_unverified":
      return "medium_trust";
    case "blocked":
    case "disabled":
    case "unavailable":
      return "blocked";
    default:
      return "unknown";
  }
}

function findLastUseEvidence(
  evidence: TrustPolicyLastUseEvidence[],
  subjectType: string,
  subjectId: string | undefined,
): TrustPolicyLastUseEvidence | undefined {
  if (!subjectId) {
    return undefined;
  }
  return evidence.find((item) => item.subjectType === subjectType && item.subjectId === subjectId);
}

function evidenceToLastUse(evidence: TrustPolicyLastUseEvidence | undefined): TrustPolicyMatrixRow["lastUse"] {
  if (!evidence) {
    return null;
  }
  return {
    at: evidence.lastUsedAt ?? evidence.lastConnectedAt ?? evidence.latestToolUpdatedAt ?? evidence.updatedAt,
    label: evidence.status ?? (evidence.usageCount !== undefined ? `${evidence.usageCount} uses` : evidence.source),
    runId: evidence.runId,
    approvalId: evidence.approvalId,
    evidenceRef: evidence.evidenceRef,
  };
}
