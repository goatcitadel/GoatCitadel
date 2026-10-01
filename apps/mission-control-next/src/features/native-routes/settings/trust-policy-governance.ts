import type { TrustPolicySkillDeclaredMetadata } from "@goatcitadel/mission-control-shared/api/trust";
import type { TrustPolicyDeclaredGovernanceView, TrustPolicyMatrixRow } from "./trust-policy-types";

export function labelForKind(kind: TrustPolicyMatrixRow["kind"]): string {
  if (kind === "capability") {
    return "Capability";
  }
  if (kind === "tool") {
    return "Tool";
  }
  return "Source";
}

export function hasDeclaredDependencies(deps: TrustPolicyDeclaredGovernanceView["dependencies"]): boolean {
  return Boolean((deps.tools?.length ?? 0) || (deps.skillIds?.length ?? 0) || (deps.capabilities?.length ?? 0));
}

export function normalizeDeclaredGovernance(
  meta: TrustPolicySkillDeclaredMetadata | undefined,
): TrustPolicyDeclaredGovernanceView | undefined {
  if (!isRecord(meta)) {
    return undefined;
  }
  const dependencies = isRecord(meta.dependencies) ? meta.dependencies : {};
  return {
    requiredEnv: readObjectArray(meta.requiredEnv)
      .map((env) => ({
        name: readString(env.name),
        secret: env.secret === true,
      }))
      .filter((env): env is { name: string; secret: boolean } => Boolean(env.name)),
    stateDirs: readObjectArray(meta.stateDirs)
      .map((dir) => ({
        path: readString(dir.path),
        writeable: dir.writeable === true,
      }))
      .filter((dir): dir is { path: string; writeable: boolean } => Boolean(dir.path)),
    dependencies: {
      tools: readStringArray(dependencies.tools),
      skillIds: readStringArray(dependencies.skillIds),
      capabilities: readStringArray(dependencies.capabilities),
    },
  };
}

function readObjectArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => readString(item)).filter((item): item is string => Boolean(item))
    : [];
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
