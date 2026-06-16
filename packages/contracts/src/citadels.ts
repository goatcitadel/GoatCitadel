// Citadel domain types and scope helpers.
//
// A Citadel is a protected AI operating space. Identity decision (see
// docs/citadel_update/reuse-audit.md): a Citadel IS a Workspace — `citadelId`
// is an alias for `workspaceId` — enriched with a Charter and one or more
// Chambers (sub-scopes). A workspace becomes a Citadel once it has a Charter.
//
// These helpers are the reusable enforcement primitives. They currently live in
// @goatcitadel/contracts; they can be extracted into a dedicated `citadel-core`
// package later without changing their contracts.

export type CitadelKind =
  | "personal"
  | "company"
  | "project"
  | "household"
  | "client"
  | "creator"
  | "learning"
  | "team"
  | "custom";

export type ChamberSensitivity =
  | "public"
  | "internal"
  | "private"
  | "sensitive"
  | "restricted"
  | "secret";

export type CitadelRiskPosture = "conservative" | "balanced" | "collaborative" | "automation_forward";

export type CitadelModelPolicy = "local_only" | "hybrid_guarded" | "approved_cloud" | "hosted_team";

export interface CitadelCharter {
  /** 1:1 with its Citadel (= workspace). Its presence is what makes a workspace a Citadel. */
  citadelId: string;
  purpose: string;
  kind: CitadelKind;
  goals: string[];
  boundaries: string[];
  successDefinition: string[];
  defaultChamberId?: string;
  riskPosture: CitadelRiskPosture;
  modelPolicyDefault: CitadelModelPolicy;
  createdAt: string;
  updatedAt: string;
}

export interface CitadelChamber {
  chamberId: string;
  citadelId: string;
  name: string;
  sensitivity: ChamberSensitivity;
  sealed: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Citadel {
  /** Equal to the underlying workspaceId. */
  citadelId: string;
  charter: CitadelCharter;
  chambers: CitadelChamber[];
}

export interface CitadelCharterInput {
  citadelId: string;
  purpose: string;
  kind: CitadelKind;
  goals?: string[];
  boundaries?: string[];
  successDefinition?: string[];
  defaultChamberId?: string;
  riskPosture?: CitadelRiskPosture;
  modelPolicyDefault?: CitadelModelPolicy;
}

export interface CitadelChamberInput {
  citadelId: string;
  name: string;
  sensitivity?: ChamberSensitivity;
  sealed?: boolean;
}

/**
 * A Citadel's Council is the set of EXISTING agents assigned to it. This is a thin
 * reference (it stores `agentId`, which points at an `AgentProfileRecord` in the
 * agents system) — it deliberately does NOT duplicate the agent's name/role/tools.
 * Resolve agent details from the agents system, not from here.
 */
export interface CitadelCouncilAssignment {
  assignmentId: string;
  citadelId: string;
  agentId: string;
  createdAt: string;
}

export interface CitadelCouncilAssignmentInput {
  citadelId: string;
  agentId: string;
}

// --- Scope: the (citadelId, chamberId?) tuple that scopes every Citadel-bound action ---

export interface CitadelScope {
  citadelId: string;
  chamberId?: string;
}

/**
 * A request-like object that may carry Citadel scope. `citadelId` is treated as
 * an alias for `workspaceId` (a Citadel IS a workspace), so either field resolves
 * the scope.
 */
export interface CitadelScopeSource {
  citadelId?: string;
  workspaceId?: string;
  chamberId?: string;
}

/**
 * Resolve the Citadel scope from a request-like object. Returns `undefined` when
 * no citadel/workspace identity is present (an unscoped / global request).
 */
export function resolveCitadelScope(source: CitadelScopeSource | null | undefined): CitadelScope | undefined {
  if (!source) {
    return undefined;
  }
  const citadelId = trimmedOrUndefined(source.citadelId) ?? trimmedOrUndefined(source.workspaceId);
  if (!citadelId) {
    return undefined;
  }
  const chamberId = trimmedOrUndefined(source.chamberId);
  return chamberId ? { citadelId, chamberId } : { citadelId };
}

/**
 * Isolation predicate: is an item living in `itemScope` visible to a viewer
 * operating in `viewerScope`?
 *
 * - Unscoped viewer (global operator surface) => sees everything.
 * - Different Citadel => never visible (hard boundary).
 * - Unscoped item => not visible to a Citadel-scoped viewer.
 * - Chamber-scoped viewer => only that Chamber, plus Citadel-general items
 *   (items with no chamber). Citadel-scoped viewer => all Chambers of the Citadel.
 */
export function isWithinCitadelScope(
  itemScope: CitadelScope | undefined,
  viewerScope: CitadelScope | undefined,
): boolean {
  if (!viewerScope) {
    return true;
  }
  if (!itemScope) {
    return false;
  }
  if (itemScope.citadelId !== viewerScope.citadelId) {
    return false;
  }
  if (viewerScope.chamberId) {
    return !itemScope.chamberId || itemScope.chamberId === viewerScope.chamberId;
  }
  return true;
}

function trimmedOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

// --- Gatehouse: a read-only security-posture summary of a Citadel ---

const CHAMBER_SENSITIVITIES: ChamberSensitivity[] = [
  "public",
  "internal",
  "private",
  "sensitive",
  "restricted",
  "secret",
];

export interface CitadelGatehouseSummary {
  citadelId: string;
  hasCharter: boolean;
  chamberCount: number;
  sealedChamberCount: number;
  sensitivityCounts: Record<ChamberSensitivity, number>;
  riskPosture: CitadelRiskPosture;
  modelPolicyDefault: CitadelModelPolicy;
  sharingDefault: "private";
  externalWritesDefault: "approval_required";
}

export function summarizeCitadelGatehouse(citadel: Citadel): CitadelGatehouseSummary {
  const sensitivityCounts = Object.fromEntries(
    CHAMBER_SENSITIVITIES.map((sensitivity) => [sensitivity, 0]),
  ) as Record<ChamberSensitivity, number>;
  let sealedChamberCount = 0;
  for (const chamber of citadel.chambers) {
    sensitivityCounts[chamber.sensitivity] = (sensitivityCounts[chamber.sensitivity] ?? 0) + 1;
    if (chamber.sealed) {
      sealedChamberCount += 1;
    }
  }
  return {
    citadelId: citadel.citadelId,
    hasCharter: Boolean(citadel.charter),
    chamberCount: citadel.chambers.length,
    sealedChamberCount,
    sensitivityCounts,
    riskPosture: citadel.charter.riskPosture,
    modelPolicyDefault: citadel.charter.modelPolicyDefault,
    sharingDefault: "private",
    externalWritesDefault: "approval_required",
  };
}

// --- Templates: starter Citadels (a Charter + default Chambers) ---

export interface CitadelTemplateChamber {
  name: string;
  sensitivity?: ChamberSensitivity;
  sealed?: boolean;
}

export interface CitadelTemplate {
  id: string;
  name: string;
  description: string;
  kind: CitadelKind;
  purpose: string;
  goals: string[];
  boundaries: string[];
  successDefinition: string[];
  chambers: CitadelTemplateChamber[];
  riskPosture?: CitadelRiskPosture;
  modelPolicyDefault?: CitadelModelPolicy;
}

export const CITADEL_TEMPLATES: CitadelTemplate[] = [
  {
    id: "personal-chief-of-staff",
    name: "Personal Chief of Staff",
    description: "A private Citadel for life admin, routines, commitments, documents, and goals.",
    kind: "personal",
    purpose: "Help the owner run daily life, commitments, goals, documents, and personal routines.",
    goals: ["Keep track of important commitments", "Reduce missed follow-ups", "Support weekly planning"],
    boundaries: [
      "Do not send messages without approval",
      "Do not share sealed Chambers with other Citadels unless explicitly allowed",
    ],
    successDefinition: [
      "The owner gets a useful daily brief",
      "The owner completes a weekly review",
      "Important documents and commitments are easy to find",
    ],
    chambers: [
      { name: "General" },
      { name: "Calendar & Commitments" },
      { name: "People & Relationships" },
      { name: "Documents" },
      { name: "Private Reflection", sensitivity: "sensitive", sealed: true },
    ],
  },
  {
    id: "company-co-founder",
    name: "Company Co-Founder",
    description: "A Citadel for running product, customers, growth, finance, and operations.",
    kind: "company",
    purpose: "Help a founder run product, customers, growth, finance, and operations.",
    goals: ["Maintain a current operating picture", "Surface what needs attention", "Support a weekly business review"],
    boundaries: [
      "Production writes require approval",
      "External emails are draft-only by default",
      "Billing changes require explicit approval",
    ],
    successDefinition: [
      "A useful daily founder brief",
      "A completed weekly business review",
      "Customer feedback is captured and reviewed",
    ],
    riskPosture: "conservative",
    chambers: [
      { name: "General" },
      { name: "Product" },
      { name: "Customers" },
      { name: "Growth" },
      { name: "Finance", sensitivity: "restricted", sealed: true },
      { name: "Legal", sensitivity: "restricted", sealed: true },
      { name: "Founder", sensitivity: "sensitive", sealed: true },
    ],
  },
  {
    id: "project-command",
    name: "Project Command",
    description: "A Citadel for planning, executing, and reviewing an ambitious project.",
    kind: "project",
    purpose: "Plan, execute, and review an ambitious project with AI coworkers.",
    goals: ["Define scope and milestones", "Track risks and decisions", "Review progress weekly"],
    boundaries: ["No external writes without approval", "Project-specific integrations only"],
    successDefinition: ["A clear scope and milestone plan", "Tracked risks and decisions", "A weekly project review"],
    chambers: [
      { name: "General" },
      { name: "Requirements" },
      { name: "Tasks" },
      { name: "Decisions" },
      { name: "Artifacts" },
    ],
  },
];

export function findCitadelTemplate(id: string): CitadelTemplate | undefined {
  return CITADEL_TEMPLATES.find((template) => template.id === id);
}

/** The subset of Citadel persistence a template needs to instantiate itself. */
export interface CitadelTemplateTarget {
  upsertCharter(input: CitadelCharterInput): CitadelCharter;
  createChamber(input: CitadelChamberInput): CitadelChamber;
  getCitadel(citadelId: string): Citadel | undefined;
}

/**
 * Instantiate a Citadel (= workspace) from a template: upsert the Charter and
 * create the default Chambers, then return the assembled Citadel.
 */
export function applyCitadelTemplate(
  target: CitadelTemplateTarget,
  citadelId: string,
  template: CitadelTemplate,
): Citadel {
  target.upsertCharter({
    citadelId,
    purpose: template.purpose,
    kind: template.kind,
    goals: template.goals,
    boundaries: template.boundaries,
    successDefinition: template.successDefinition,
    riskPosture: template.riskPosture,
    modelPolicyDefault: template.modelPolicyDefault,
  });
  for (const chamber of template.chambers) {
    target.createChamber({
      citadelId,
      name: chamber.name,
      sensitivity: chamber.sensitivity,
      sealed: chamber.sealed,
    });
  }
  const citadel = target.getCitadel(citadelId);
  if (!citadel) {
    throw new Error(`Failed to instantiate citadel ${citadelId} from template ${template.id}`);
  }
  return citadel;
}
