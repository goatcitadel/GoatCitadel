import { createHash } from "node:crypto";
import type {
  ChamberSensitivity,
  CitadelChamber,
  CitadelCharter,
  CitadelCouncilAssignment,
  CitadelIntegrationGrant,
  CitadelIntegrationMode,
  CitadelKind,
  CitadelMember,
  CitadelModelPolicy,
  CitadelPassage,
  CitadelRecord,
  CitadelRiskPosture,
  CitadelRole,
  CitadelWardRecord,
  MasonAnswers,
  MasonSession,
  MasonSessionStatus,
  WardEffect,
} from "@goatcitadel/contracts";
import { safeJsonParse } from "./safe-json.js";

// Row shapes and row mappers for CitadelRepository, kept beside it so the
// repository file stays within its size budget.

export interface CharterRow {
  citadel_id: string;
  purpose: string;
  kind: string;
  goals_json: string;
  boundaries_json: string;
  success_definition_json: string;
  default_chamber_id: string | null;
  risk_posture: string;
  model_policy_default: string;
  created_at: string;
  updated_at: string;
}

export interface CitadelRecordRow {
  citadel_id: string;
  name: string;
  description: string | null;
  slug: string;
  kind: string;
  lifecycle_status: "active" | "archived";
  archived_at: string | null;
  default_workspace_id: string | null;
  created_at: string;
  updated_at: string;
  has_charter?: number | boolean | null;
}

export interface ChamberRow {
  chamber_id: string;
  citadel_id: string;
  name: string;
  sensitivity: string;
  sealed: number;
  created_at: string;
  updated_at: string;
}

export interface CouncilAssignmentRow {
  assignment_id: string;
  citadel_id: string;
  agent_id: string;
  created_at: string;
}

export interface WardRow {
  ward_id: string;
  citadel_id: string;
  name: string;
  action_pattern: string;
  effect: string;
  created_at: string;
}

export interface PassageRow {
  passage_id: string;
  source_citadel_id: string;
  source_chamber_id: string | null;
  destination_citadel_id: string;
  allowed_fields_json: string;
  expires_at: string | null;
  created_at: string;
}

export interface MemberRow {
  member_id: string;
  citadel_id: string;
  subject_id: string;
  role: string;
  created_at: string;
  updated_at: string;
}

export interface MasonSessionRow {
  session_id: string;
  answers_json: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface IntegrationGrantRow {
  grant_id: string;
  citadel_id: string;
  provider: string;
  account: string | null;
  capabilities_json: string;
  mode: string;
  expires_at: string | null;
  created_at: string;
}

export function mapCitadelRecord(row: CitadelRecordRow): CitadelRecord {
  // Derived hasCharter is intentionally excluded, so list/detail reviews agree.
  const revision = createHash("sha256")
    .update(
      JSON.stringify([
        "citadel-record-review-v1",
        row.citadel_id,
        row.name,
        row.description,
        row.slug,
        row.kind,
        row.lifecycle_status,
        row.archived_at,
        row.default_workspace_id,
        row.created_at,
        row.updated_at,
      ]),
    )
    .digest("hex");
  return {
    citadelId: row.citadel_id,
    revision,
    name: row.name,
    description: row.description ?? undefined,
    slug: row.slug,
    kind: row.kind as CitadelKind,
    lifecycleStatus: row.lifecycle_status,
    archivedAt: row.archived_at ?? undefined,
    defaultWorkspaceId: row.default_workspace_id ?? undefined,
    ...(row.has_charter !== undefined ? { hasCharter: Boolean(row.has_charter) } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapCharter(row: CharterRow): CitadelCharter {
  return {
    citadelId: row.citadel_id,
    purpose: row.purpose,
    kind: row.kind as CitadelKind,
    goals: safeJsonParse<string[]>(row.goals_json, []),
    boundaries: safeJsonParse<string[]>(row.boundaries_json, []),
    successDefinition: safeJsonParse<string[]>(row.success_definition_json, []),
    defaultChamberId: row.default_chamber_id ?? undefined,
    riskPosture: row.risk_posture as CitadelRiskPosture,
    modelPolicyDefault: row.model_policy_default as CitadelModelPolicy,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapChamber(row: ChamberRow): CitadelChamber {
  return {
    chamberId: row.chamber_id,
    citadelId: row.citadel_id,
    name: row.name,
    sensitivity: row.sensitivity as ChamberSensitivity,
    sealed: row.sealed === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapCouncilAssignment(row: CouncilAssignmentRow): CitadelCouncilAssignment {
  return {
    assignmentId: row.assignment_id,
    citadelId: row.citadel_id,
    agentId: row.agent_id,
    createdAt: row.created_at,
  };
}

export function mapWard(row: WardRow): CitadelWardRecord {
  return {
    wardId: row.ward_id,
    citadelId: row.citadel_id,
    name: row.name,
    actionPattern: row.action_pattern,
    effect: row.effect as WardEffect,
    createdAt: row.created_at,
  };
}

export function mapPassage(row: PassageRow): CitadelPassage {
  return {
    passageId: row.passage_id,
    sourceCitadelId: row.source_citadel_id,
    sourceChamberId: row.source_chamber_id ?? undefined,
    destinationCitadelId: row.destination_citadel_id,
    allowedFields: safeJsonParse<string[]>(row.allowed_fields_json, []),
    expiresAt: row.expires_at ?? undefined,
    createdAt: row.created_at,
  };
}

export function mapMember(row: MemberRow): CitadelMember {
  return {
    memberId: row.member_id,
    citadelId: row.citadel_id,
    subjectId: row.subject_id,
    role: row.role as CitadelRole,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapMasonSession(row: MasonSessionRow): MasonSession {
  return {
    sessionId: row.session_id,
    answers: safeJsonParse<Partial<MasonAnswers>>(row.answers_json, {}),
    status: row.status as MasonSessionStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapIntegrationGrant(row: IntegrationGrantRow): CitadelIntegrationGrant {
  return {
    grantId: row.grant_id,
    citadelId: row.citadel_id,
    provider: row.provider,
    account: row.account ?? undefined,
    capabilities: safeJsonParse<string[]>(row.capabilities_json, []),
    mode: row.mode as CitadelIntegrationMode,
    expiresAt: row.expires_at ?? undefined,
    createdAt: row.created_at,
  };
}
