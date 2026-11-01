import type {
  CapabilityPluginDetail,
  CapabilityPluginInspection,
  CapabilityPluginPieceState,
  CapabilityPluginPieceView,
  CapabilitySkillActionOutcome,
  CapabilitySkillOperationRequest,
  ChangePlanRecord,
  ChangePlanStatus,
  PluginActionOutcome,
} from "@goatcitadel/contracts";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";

// A plugin and a Gateway that installs it, for the install flow's tests: the inspection, the plugin plan, the plugin's
// detail and each skill's two steps, moved the way the Gateway moves them.

export const PLUGIN_ID = "meeting-tools";
export const INSPECTION_ID = "insp-1";
export const PLAN_ID = "plan-1";
export const PLUGIN_APPROVAL = "approval-plugin";
export const PLUGIN_KEY = `plugin:${PLUGIN_ID}`;

export const CALENDAR: CapabilityPluginPieceView = {
  pieceId: "calendar",
  kind: "connector",
  label: "Calendar",
  asksFirst: "Reading runs freely; creating or changing something asks first in Chat.",
  check: { status: "ready" },
  hosts: ["calendar.example.com", "api.calendar.example.com"],
};
export const NOTES: CapabilityPluginPieceView = {
  pieceId: "notes",
  kind: "skill",
  label: "Meeting notes",
  asksFirst: "Follows your tool rules. Added after GoatCitadel's checks, then switched on.",
  check: { status: "ready" },
  skillSnapshotId: "snap-notes",
};
export const AGENDA: CapabilityPluginPieceView = {
  ...NOTES,
  pieceId: "agenda",
  label: "Agenda",
  skillSnapshotId: "snap-agenda",
};
export const WATCH: CapabilityPluginPieceView = {
  pieceId: "watch",
  kind: "hook",
  label: "After a tool call",
  asksFirst: "Sends event details, never message text, to hooks.example.com: After a tool call.",
  check: { status: "ready" },
  hosts: ["hooks.example.com"],
  needsSecret: true,
};

export function inspectionOf(
  pieces: CapabilityPluginPieceView[] = [CALENDAR, NOTES],
  overrides: Partial<CapabilityPluginInspection> = {},
): CapabilityPluginInspection {
  return {
    inspectionId: INSPECTION_ID,
    workspaceId: "ws-1",
    pluginId: PLUGIN_ID,
    name: "Meeting tools",
    description: "Notes and agendas for meetings.",
    version: "1.2.0",
    author: "Acme",
    trust: "built_in",
    sourceKind: "built_in",
    sourceDisplay: "Ships with GoatCitadel",
    pin: { kind: "content", treeSha256: "c".repeat(64) },
    manifestSha256: "d".repeat(64),
    pieces,
    ignored: [],
    installable: true,
    inspectedAt: "2026-11-01T10:00:00.000Z",
    expiresAt: "2026-11-02T10:00:00.000Z",
    ...overrides,
  };
}

export const httpError = (status: number, body: unknown, path = "/api/v1/capabilities/plugins") =>
  new ApiRequestError(
    typeof (body as { error?: unknown })?.error === "string" ? String((body as { error: string }).error) : "refused",
    {
      kind: "http",
      method: "POST",
      path,
      status,
      body,
    },
  );

export const networkError = () =>
  new ApiRequestError("Failed to fetch", { kind: "network", method: "POST", path: "/api/v1/capabilities/plugins" });

/** The Gateway as the tests drive it. */
export interface FakeGateway {
  inspection: CapabilityPluginInspection;
  /** The operator's setting to skip approvals for their own changes. */
  skip: boolean;
  /** The plugin plan, once an install was confirmed. */
  plan?: { status: ChangePlanStatus; approvalId?: string; failureCode?: string; summary?: string };
  /** The plugin's record exists (the plan began applying). */
  installed: boolean;
  workspaceId: string;
  /** Each piece's state, as the detail reads it. */
  pieces: Record<string, CapabilityPluginPieceState>;
  /** The approval a waiting piece waits for. */
  pending: Record<string, string>;
  /** Where a piece goes on the read after the one that found it installing. */
  next: Record<string, CapabilityPluginPieceState>;
  /** Each skill step asked for, as `<snapshot> <kind>`. */
  steps: string[];
  /** Each request and read, in order. */
  calls: string[];
}

export function fakeGateway(inspection = inspectionOf()): FakeGateway {
  return {
    inspection,
    skip: true,
    installed: false,
    workspaceId: inspection.workspaceId,
    pieces: {},
    pending: {},
    next: {},
    steps: [],
    calls: [],
  };
}

/** The plugin's detail as the Gateway reads it now. A piece found installing moves on for the next read. */
export function readDetail(gateway: FakeGateway): CapabilityPluginDetail {
  gateway.calls.push("detail");
  const pieces = gateway.inspection.pieces.map((piece) => {
    const state = gateway.pieces[piece.pieceId] ?? (piece.kind === "skill" ? "check_passed" : "added");
    if (state === "installing" && gateway.next[piece.pieceId]) {
      gateway.pieces[piece.pieceId] = gateway.next[piece.pieceId]!;
      delete gateway.next[piece.pieceId];
    }
    const pendingApprovalId = gateway.pending[piece.pieceId];
    return {
      ...piece,
      state,
      ...(state === "waiting_for_approval" && pendingApprovalId ? { pendingApprovalId } : {}),
    };
  });
  const { inspection } = gateway;
  return {
    pluginId: inspection.pluginId,
    name: inspection.name,
    description: inspection.description,
    version: inspection.version,
    ...(inspection.author ? { author: inspection.author } : {}),
    trust: inspection.trust,
    sourceDisplay: inspection.sourceDisplay,
    sourceKind: inspection.sourceKind,
    workspaceId: gateway.workspaceId,
    state: pieces.every((piece) => piece.state === "added" || piece.state === "kept")
      ? "installed"
      : "install_not_finished",
    pieceCounts: {},
    pin: inspection.pin,
    manifestSha256: inspection.manifestSha256,
    installPlanId: PLAN_ID,
    installedAt: "2026-11-01T10:01:00.000Z",
    pieces,
  };
}

/** Confirms an install: with the skip on the plan applies at once, without it the plan waits for its approval. */
export function install(gateway: FakeGateway): PluginActionOutcome {
  gateway.calls.push("install");
  if (gateway.skip) {
    gateway.plan = { status: "completed" };
    gateway.installed = true;
    return { planId: PLAN_ID, outcome: "applied", summary: "Installed Meeting tools." };
  }
  gateway.plan = { status: "awaiting_approval", approvalId: PLUGIN_APPROVAL };
  return { planId: PLAN_ID, outcome: "waiting", approvalId: PLUGIN_APPROVAL, summary: "Install Meeting tools." };
}

/** The plugin plan's approval was approved: the plan applies and writes the record. */
export function approvePlugin(gateway: FakeGateway) {
  gateway.plan = { status: "completed" };
  gateway.installed = true;
}

export function readPlan(gateway: FakeGateway): ChangePlanRecord {
  gateway.calls.push(`plan ${gateway.plan?.status ?? "none"}`);
  const plan = gateway.plan ?? { status: "draft" as const };
  return {
    planId: PLAN_ID,
    kind: "plugin_install",
    status: plan.status,
    title: "Install Meeting tools",
    summary: plan.summary ?? "Install Meeting tools.",
    ...(plan.approvalId && plan.status === "awaiting_approval"
      ? { requiredAction: { kind: "approval", approvalId: plan.approvalId } }
      : {}),
    ...(plan.failureCode || plan.summary
      ? { result: { summary: plan.summary ?? "", ...(plan.failureCode ? { failureCode: plan.failureCode } : {}) } }
      : {}),
  } as unknown as ChangePlanRecord;
}

/** One skill step: approved at once with the skip on, else waiting for its own approval. */
export function step(gateway: FakeGateway, request: CapabilitySkillOperationRequest): CapabilitySkillActionOutcome {
  const piece = gateway.inspection.pieces.find((entry) => entry.skillSnapshotId === request.snapshotId)!;
  gateway.steps.push(`${request.snapshotId} ${request.operationKind}`);
  gateway.calls.push(request.operationKind);
  const approvalId = `approval-${piece.pieceId}-${request.operationKind === "install_inactive" ? "install" : "on"}`;
  if (gateway.skip) {
    gateway.pieces[piece.pieceId] = "installing";
    gateway.next[piece.pieceId] = request.operationKind === "install_inactive" ? "installed_off" : "added";
    return { status: "approved", approvalId };
  }
  gateway.pieces[piece.pieceId] = "waiting_for_approval";
  gateway.pending[piece.pieceId] = approvalId;
  return { status: "waiting", approvalId };
}

/** A skill step's approval was approved: it is applied, and the next read after finds it done. */
export function approveStep(gateway: FakeGateway, pieceId: string, kind: "install_inactive" | "activate") {
  delete gateway.pending[pieceId];
  gateway.pieces[pieceId] = "installing";
  gateway.next[pieceId] = kind === "install_inactive" ? "installed_off" : "added";
}
