import type { OrchestrationRole } from "../orchestration/types.js";

export const DEFAULT_DELEGATION_ROLES = ["product", "architect", "coder", "qa", "ops"] as const;

const HANDOFF_HINT_PATTERN = /->|route this through|multi-agent|agents work together|handoff/;

function stripDiacritics(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

function normalizeRoutingText(value: string): string {
  return stripDiacritics(value).trim().toLowerCase();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createKeywordPattern(terms: readonly string[]): RegExp {
  return new RegExp(`\\b(?:${terms.map((term) => escapeRegex(term)).join("|")})\\b`, "i");
}

function normalizeDelegationRoleValue(role: string): string {
  return normalizeRoutingText(role)
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const DELEGATION_ROLE_HINTS: Array<{ role: string; patterns: RegExp[] }> = [
  {
    role: "product",
    patterns: [
      createKeywordPattern([
        "product",
        "prd",
        "requirement",
        "requirements",
        "requisito",
        "requisitos",
        "exigence",
        "exigences",
        "anforderung",
        "anforderungen",
      ]),
    ],
  },
  {
    role: "architect",
    patterns: [
      createKeywordPattern([
        "architect",
        "architecture",
        "design",
        "architecte",
        "architecture",
        "conception",
        "arquitecto",
        "arquitectura",
        "disenar",
        "architekt",
        "architektur",
        "entwerfen",
        "arquiteto",
        "arquitetura",
        "desenhar",
      ]),
    ],
  },
  {
    role: "coder",
    patterns: [
      createKeywordPattern([
        "coder",
        "developer",
        "implementation",
        "implement",
        "engineer",
        "build",
        "desarrollador",
        "desarrollar",
        "implementar",
        "construir",
        "developpeur",
        "developper",
        "implementer",
        "construire",
        "entwickler",
        "entwickeln",
        "implementieren",
        "bauen",
        "desenvolvedor",
        "desenvolver",
        "implementar",
        "construir",
        "engenheiro",
      ]),
    ],
  },
  {
    role: "qa",
    patterns: [
      createKeywordPattern([
        "qa",
        "test",
        "tests",
        "testing",
        "validation",
        "validator",
        "prueba",
        "pruebas",
        "validacion",
        "teste",
        "testes",
        "validacao",
        "verifier",
        "validation",
        "tester",
        "testen",
        "validierung",
      ]),
    ],
  },
  {
    role: "ops",
    patterns: [
      createKeywordPattern([
        "ops",
        "deploy",
        "rollout",
        "release",
        "infra",
        "desplegar",
        "despliegue",
        "lanzamiento",
        "deployer",
        "deploiement",
        "mise-en-production",
        "bereitstellen",
        "ausrollen",
        "freigabe",
        "implantar",
        "implantacao",
        "lancamento",
        "infraestrutura",
      ]),
    ],
  },
  {
    role: "researcher",
    patterns: [
      createKeywordPattern([
        "research",
        "analyze",
        "analysis",
        "source",
        "sources",
        "investigar",
        "investigacion",
        "analizar",
        "analisis",
        "fuente",
        "fuentes",
        "recherche",
        "analyser",
        "analyse",
        "source",
        "sources",
        "recherche",
        "analysieren",
        "analyse",
        "quelle",
        "quellen",
        "pesquisa",
        "pesquisar",
        "analisar",
        "analise",
        "fonte",
        "fontes",
      ]),
    ],
  },
  {
    role: "reviewer",
    patterns: [
      createKeywordPattern([
        "review",
        "audit",
        "security",
        "critic",
        "revisar",
        "revision",
        "auditoria",
        "seguridad",
        "critique",
        "revision",
        "audit",
        "securite",
        "kritik",
        "prufen",
        "pruefung",
        "sicherheit",
        "revisao",
        "auditoria",
        "seguranca",
        "critica",
      ]),
    ],
  },
  {
    role: "worker",
    patterns: [
      createKeywordPattern([
        "execute",
        "execution",
        "follow-through",
        "followthrough",
        "hacer",
        "ejecutar",
        "executer",
        "durchfuhren",
        "ausfuhren",
        "executar",
      ]),
    ],
  },
];

const SPECIALIST_BASE_ROLE_PATTERNS: Array<{ role: OrchestrationRole; patterns: RegExp[] }> = [
  {
    role: "researcher",
    patterns: [
      createKeywordPattern([
        "research",
        "analyst",
        "market",
        "source",
        "intel",
        "investigar",
        "investigacion",
        "analizar",
        "analisis",
        "fuente",
        "fuentes",
        "recherche",
        "analyser",
        "analyse",
        "sources",
        "recherche",
        "analysieren",
        "quelle",
        "quellen",
        "pesquisa",
        "analisar",
        "analise",
        "fontes",
      ]),
    ],
  },
  {
    role: "qa-validator",
    patterns: [
      createKeywordPattern([
        "qa",
        "test",
        "tester",
        "validation",
        "validator",
        "prueba",
        "pruebas",
        "validacion",
        "teste",
        "testes",
        "validacao",
        "verifier",
        "testen",
        "validierung",
      ]),
    ],
  },
  {
    role: "reviewer",
    patterns: [
      createKeywordPattern([
        "review",
        "critic",
        "audit",
        "security",
        "revisar",
        "revision",
        "auditoria",
        "seguridad",
        "critique",
        "revision",
        "securite",
        "kritik",
        "prufen",
        "pruefung",
        "sicherheit",
        "revisao",
        "seguranca",
        "critica",
      ]),
    ],
  },
  {
    role: "coder",
    patterns: [
      createKeywordPattern([
        "coder",
        "developer",
        "implement",
        "implementation",
        "engineer",
        "build",
        "desarrollador",
        "implementar",
        "construir",
        "developpeur",
        "implementer",
        "construire",
        "entwickler",
        "implementieren",
        "bauen",
        "desenvolvedor",
        "implementar",
        "construir",
        "engenheiro",
      ]),
    ],
  },
  {
    role: "planner",
    patterns: [
      createKeywordPattern([
        "product",
        "architect",
        "planner",
        "plan",
        "design",
        "requirements",
        "producto",
        "arquitecto",
        "planificar",
        "disenar",
        "requisitos",
        "produit",
        "architecte",
        "planifier",
        "conception",
        "exigences",
        "produkt",
        "architekt",
        "planen",
        "entwerfen",
        "anforderungen",
        "produto",
        "arquiteto",
        "planejar",
        "desenhar",
        "requisitos",
      ]),
    ],
  },
  {
    role: "worker",
    patterns: [
      createKeywordPattern([
        "ops",
        "deploy",
        "release",
        "infra",
        "execute",
        "worker",
        "desplegar",
        "lanzamiento",
        "ejecutar",
        "deployer",
        "mise-en-production",
        "executer",
        "bereitstellen",
        "ausrollen",
        "ausfuhren",
        "implantar",
        "lancamento",
        "executar",
      ]),
    ],
  },
];

export function normalizeDelegationRoles(roles: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const role of roles) {
    const normalized = normalizeDelegationRoleValue(role);
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

function normalizeDelegationRolesWithoutFallback(roles: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const role of roles) {
    const normalized = normalizeDelegationRoleValue(role);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function detectDelegationRoles(objective: string): string[] {
  const normalized = normalizeRoutingText(objective);
  const roles = DELEGATION_ROLE_HINTS.filter((hint) => hint.patterns.some((pattern) => pattern.test(normalized))).map(
    (hint) => hint.role,
  );
  if (roles.length > 0) {
    return roles;
  }
  if (HANDOFF_HINT_PATTERN.test(normalized)) {
    return [...DEFAULT_DELEGATION_ROLES.slice(0, 3)];
  }
  return [];
}

export function resolveDelegationRoles(
  objective: string,
  explicitRoles?: string[],
  fallbackRoles: readonly string[] = DEFAULT_DELEGATION_ROLES.slice(0, 3),
): string[] {
  const explicit = explicitRoles?.length ? normalizeDelegationRolesWithoutFallback(explicitRoles) : [];
  if (explicit.length > 0) {
    return explicit;
  }
  const detected = normalizeDelegationRolesWithoutFallback(detectDelegationRoles(objective));
  return detected.length > 0 ? detected : [...fallbackRoles];
}

export function inferSpecialistBaseRole(role: string): OrchestrationRole {
  const normalized = normalizeRoutingText(role);
  for (const candidate of SPECIALIST_BASE_ROLE_PATTERNS) {
    if (candidate.patterns.some((pattern) => pattern.test(normalized))) {
      return candidate.role;
    }
  }
  return "worker";
}
