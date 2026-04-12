const DEFAULT_DELEGATION_ROLES = ["product", "architect", "coder", "qa", "ops"];

const PIPELINE_TEMPLATES: Record<string, string[]> = {
  prd: ["product", "architect"],
  build: ["architect", "coder", "qa"],
  triage: ["qa", "ops", "product"],
  release: ["qa", "ops", "product"],
};

export function parseSlashCommand(input: string): string[] | undefined {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return undefined;
  }
  const parts = trimmed.split(/\s+/g).filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

export function parseDelegateCommand(input: string): { roles: string[]; objective?: string; error?: string } {
  const body = input
    .trim()
    .replace(/^\/delegate/i, "")
    .trim();
  const delimiterIndex = body.indexOf("::");
  if (delimiterIndex < 0) {
    return { roles: [], error: "missing delimiter" };
  }
  const rolesRaw = body.slice(0, delimiterIndex).trim();
  const objective = body.slice(delimiterIndex + 2).trim();
  const roles = normalizeDelegationRoles(
    rolesRaw
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
  if (roles.length === 0 || !objective) {
    return { roles, objective, error: "invalid delegate payload" };
  }
  return { roles, objective };
}

export function parsePipelineCommand(
  input: string,
): { template: string; roles: string[]; objective: string } | undefined {
  const body = input
    .trim()
    .replace(/^\/pipeline/i, "")
    .trim();
  const delimiterIndex = body.indexOf("::");
  if (delimiterIndex < 0) {
    return undefined;
  }
  const template = body.slice(0, delimiterIndex).trim().toLowerCase();
  const objective = body.slice(delimiterIndex + 2).trim();
  const roles = PIPELINE_TEMPLATES[template];
  if (!roles || !objective) {
    return undefined;
  }
  return {
    template,
    roles,
    objective,
  };
}

function normalizeDelegationRoles(roles: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const role of roles) {
    const normalized = role
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  if (out.length === 0) {
    return [...DEFAULT_DELEGATION_ROLES];
  }
  return out;
}
