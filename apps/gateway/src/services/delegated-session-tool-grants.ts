import type {
  ToolGrantConstraints,
  ToolGrantCreateInput,
  ToolGrantRecord,
} from "@goatcitadel/contracts";

export function buildDelegatedSessionToolGrantCopies(input: {
  parentSessionId: string;
  childSessionId: string;
  parentGrants: ToolGrantRecord[];
  childGrants?: ToolGrantRecord[];
}): ToolGrantCreateInput[] {
  const activeDenies = [...input.parentGrants, ...(input.childGrants ?? [])]
    .filter(isActiveToolGrant)
    .filter((grant) => grant.decision === "deny")
    .filter(
      (grant) =>
        (grant.scope === "session" && grant.scopeRef === input.parentSessionId) ||
        (grant.scope === "session" && grant.scopeRef === input.childSessionId),
    );
  const childKeys = new Set(
    (input.childGrants ?? [])
      .filter((grant) => grant.scope === "session" && grant.scopeRef === input.childSessionId)
      .filter(isActiveToolGrant)
      .filter((grant) => grant.grantType !== "one_time")
      .map(buildGrantSignature),
  );

  return input.parentGrants
    .filter((grant) => grant.scope === "session" && grant.scopeRef === input.parentSessionId)
    .filter(isActiveToolGrant)
    // One-time approvals should stay bound to the original session.
    .filter((grant) => grant.grantType !== "one_time")
    .filter(
      (grant) =>
        grant.decision !== "allow" ||
        !activeDenies.some((deny) => toolPatternsOverlap(deny.toolPattern, grant.toolPattern)),
    )
    .filter((grant) => !childKeys.has(buildGrantSignature(grant)))
    .map((grant) => ({
      toolPattern: grant.toolPattern,
      decision: grant.decision,
      scope: "session",
      scopeRef: input.childSessionId,
      grantType: grant.grantType,
      constraints: cloneToolGrantConstraints(grant.constraints),
      createdBy: "system-delegated-session-inherit",
      expiresAt: grant.expiresAt,
      usesRemaining: grant.usesRemaining,
    }));
}

function toolPatternsOverlap(denyPattern: string, allowPattern: string): boolean {
  if (denyPattern === allowPattern) {
    return true;
  }
  if (denyPattern.includes("*")) {
    return patternPrefix(allowPattern).startsWith(patternPrefix(denyPattern));
  }
  if (allowPattern.includes("*")) {
    return patternPrefix(denyPattern).startsWith(patternPrefix(allowPattern));
  }
  return false;
}

function patternPrefix(pattern: string): string {
  const wildcardIndex = pattern.indexOf("*");
  return wildcardIndex >= 0 ? pattern.slice(0, wildcardIndex) : pattern;
}

function cloneToolGrantConstraints(constraints?: ToolGrantConstraints): ToolGrantConstraints | undefined {
  if (!constraints) {
    return undefined;
  }
  return {
    ...constraints,
    allowedHosts: constraints.allowedHosts ? [...constraints.allowedHosts] : undefined,
    allowedPaths: constraints.allowedPaths ? [...constraints.allowedPaths] : undefined,
    referenceRoots: constraints.referenceRoots
      ? constraints.referenceRoots.map((item) => ({ ...item }))
      : undefined,
  };
}

function buildGrantSignature(grant: Pick<
  ToolGrantRecord,
  "toolPattern" | "decision" | "grantType" | "constraints" | "expiresAt" | "usesRemaining"
>): string {
  return JSON.stringify({
    toolPattern: grant.toolPattern,
    decision: grant.decision,
    grantType: grant.grantType,
    constraints: grant.constraints ?? null,
    expiresAt: grant.expiresAt ?? null,
    usesRemaining: grant.usesRemaining ?? null,
  });
}

function isActiveToolGrant(grant: ToolGrantRecord): boolean {
  if (grant.revokedAt) {
    return false;
  }
  if (grant.expiresAt) {
    const expiry = Date.parse(grant.expiresAt);
    if (Number.isFinite(expiry) && expiry <= Date.now()) {
      return false;
    }
  }
  if (grant.grantType === "one_time") {
    return (grant.usesRemaining ?? 0) > 0;
  }
  return true;
}
