import type { ApprovalRequest } from "@goatcitadel/contracts";
import { externalSourceKnowledgeApprovalEvidence } from "./external-source-approval-evidence.js";
import { communicationsMailSendApprovalEvidence } from "./communications-approval-evidence.js";
import { skillStateApprovalEvidence } from "./skill-state-approval-evidence.js";
import { codeModeRequestInput } from "./code-mode-request-input.js";
import {
  buildApprovalReviewEvidenceModel,
  hasPurposeSpecificApprovalEvidence,
  type ApprovalEvidenceModel,
  type ApprovalTargetEntry,
} from "./approval-generic-evidence.js";

/** Purpose-specific approvals must match their own original payload and scope. */
export function buildApprovalRequestReviewEvidenceModel(approval: ApprovalRequest): ApprovalEvidenceModel | null {
  if (!hasPurposeSpecificApprovalEvidence(approval.kind)) return buildApprovalReviewEvidenceModel(approval.preview);
  if (approval.kind === "external_source.knowledge_snapshot") return externalSourceKnowledgeApprovalEvidence(approval);
  if (approval.kind === "communications.mail.send") return communicationsMailSendApprovalEvidence(approval);
  if (approval.kind === "change.request") return changeRequestApprovalEvidence(approval);
  if (approval.kind === "code_mode.request") {
    const codeEvidence = codeModeRequestApprovalEvidence(approval);
    if (codeEvidence) return codeEvidence;
  }
  if (approval.kind === "change_plan_effect") {
    const planEvidence = changePlanEffectApprovalEvidence(approval);
    if (planEvidence) return planEvidence;
  }
  if (approval.kind === "browser.errand.action") {
    const errandEvidence = browserErrandActionApprovalEvidence(approval);
    if (errandEvidence) return errandEvidence;
  }
  if (approval.kind === "skill.lifecycle") {
    const skillEvidence = skillStateApprovalEvidence(approval);
    if (skillEvidence) return skillEvidence;
  }
  return citadelWardApprovalEvidence(approval) ?? buildApprovalReviewEvidenceModel(approval.preview);
}

const nonEmptyText = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/** The hash of a Change Plan's request, as the Gateway stores it: 64 lowercase hex characters. */
const PLAN_REQUEST_HASH = /^[0-9a-f]{64}$/;

/**
 * A Change Plan's approval (R91). Its preview is the plan's own title, summary and impact, the lines the adapter wrote
 * from the hash-bound request and the operator confirms in Settings, Capabilities or Chat; the Gateway applies only
 * the plan this approval names, as planned. Listed only for an approval bound to its plan (its plan id and the hash of
 * the plan's request, intentHash) with a title and summary; anything less keeps the generic model, which offers
 * nothing exact to approve. A real approval never carries the plan's action snapshot hash (the Gateway can only know it
 * once the approval exists), so it is not asked for.
 */
export function changePlanEffectApprovalEvidence(approval: ApprovalRequest): ApprovalEvidenceModel | null {
  const payload = approval.payload as Record<string, unknown> | undefined;
  const preview = approval.preview as Record<string, unknown> | undefined;
  const requestHash = payload?.intentHash;
  if (!nonEmptyText(payload?.planId) || typeof requestHash !== "string" || !PLAN_REQUEST_HASH.test(requestHash)) {
    return null;
  }
  const title = nonEmptyText(preview?.title);
  const summary = nonEmptyText(preview?.summary);
  if (!title || !summary) return null;
  const impact = nonEmptyText(preview?.impact);
  const entries: ApprovalTargetEntry[] = [
    { label: "Change", value: title },
    { label: "What it does", value: summary },
    ...(impact ? [{ label: "Impact", value: impact }] : []),
  ];
  return {
    targets: entries.map((entry) => `${entry.label}: ${entry.value}`),
    targetEntries: entries,
    commands: [],
    changes: [],
    supporting: [],
    // Only some plans apply on approval; a Chat-linked plan, for one, waits to be continued (approval reconciliation).
    consequence:
      "Approving lets this one change apply once, exactly as planned. Some changes then wait for you to continue them. " +
      "Denying cancels it.",
  };
}

/**
 * A Chat `code_mode.request` approval carries the exact goal and script as its payload (the Gateway runs only that
 * script, bound by hash), with the files and folders it may read and the input its code gets: the input decides what
 * the code reads, so it is shown too. Without a goal and a script there is nothing exact to approve.
 */
export function codeModeRequestApprovalEvidence(approval: ApprovalRequest): ApprovalEvidenceModel | null {
  const payload = approval.payload as Record<string, unknown> | undefined;
  const goal = nonEmptyText(payload?.goal);
  const source = typeof payload?.source === "string" && payload.source.trim() ? payload.source : undefined;
  if (!goal || !source) return null;
  const reads = Array.isArray(payload?.reads) ? payload.reads.flatMap((entry) => nonEmptyText(entry) ?? []) : [];
  const input = codeModeRequestInput(payload?.input);
  const entries: ApprovalTargetEntry[] = [
    { label: "Goal", value: goal },
    // The Gateway refuses every helper call in the run that names anything else, so with none listed its helpers read
    // no files.
    { label: "Reads", value: reads.length ? reads.join(", ") : "No files" },
    ...(input ? [{ label: "Input", value: input }] : []),
  ];
  return {
    targets: entries.map((entry) => `${entry.label}: ${entry.value}`),
    targetEntries: entries,
    commands: [],
    changes: [{ label: "Code to run", content: source }],
    supporting: [],
    // The limit is the Gateway's check on every helper call, not the sandbox (the code is trusted, never claimed to be
    // contained as hostile code), so the line says GoatCitadel holds the reads to the list.
    consequence:
      "Approving runs this exact code once, on this computer in a restricted sandbox. " +
      (reads.length
        ? "GoatCitadel lets it read only what is listed under Reads. "
        : "GoatCitadel lets it read no files. ") +
      "Denying keeps it from running.",
  };
}

/**
 * A browser errand's risky step (a click or entry the errand wants to make). The Gateway's preview carries the step's
 * title, a summary (that title plus what the step does) and the page's address; it carries no page title. The step and
 * the page address are the targets; the screenshot the Gateway captured with it is shown beside the decision. Without
 * a step there is nothing exact to review here, so the generic model applies.
 */
export function browserErrandActionApprovalEvidence(approval: ApprovalRequest): ApprovalEvidenceModel | null {
  const preview = approval.preview as Record<string, unknown> | undefined;
  // The summary already starts with the title, so the title stands alone only when there is no summary.
  const step = nonEmptyText(preview?.summary) ?? nonEmptyText(preview?.title);
  if (!step) return null;
  const url = nonEmptyText(preview?.url);
  const entries: ApprovalTargetEntry[] = [
    { label: "Step", value: step },
    ...(url ? [{ label: "Page", value: url }] : []),
  ];
  return {
    targets: entries.map((entry) => `${entry.label}: ${entry.value}`),
    targetEntries: entries,
    commands: [],
    changes: [],
    supporting: [],
    consequence: "Approving lets the browser errand take this one step. Denying ends the errand.",
  };
}

/** A well-formed `preview.requestSummary` (non-empty label/value lines), or null when missing or malformed. */
function readRequestSummaryEntries(approval: ApprovalRequest): ApprovalTargetEntry[] | null {
  const summary = (approval.preview as Record<string, unknown> | undefined)?.requestSummary;
  if (!Array.isArray(summary) || summary.length === 0) return null;
  const entries = summary.filter(
    (entry): entry is ApprovalTargetEntry =>
      !!entry && typeof entry.label === "string" && typeof entry.value === "string",
  );
  return entries.length === summary.length ? entries : null;
}

/**
 * `change.request` approvals carry the policy engine's redacted, display-only `preview.requestSummary` of the
 * requested intent; it is withheld when the intent can't be listed exactly. The executor re-validates the
 * approved args. Without a summary there is nothing exact to approve, so no generic fallback applies.
 */
export function changeRequestApprovalEvidence(approval: ApprovalRequest): ApprovalEvidenceModel | null {
  const entries = readRequestSummaryEntries(approval);
  if (!entries) return null;
  return {
    targets: entries.map((entry) => `${entry.label}: ${entry.value}`),
    targetEntries: entries.map((entry) => ({ label: entry.label, value: entry.value })),
    commands: [],
    changes: [],
    supporting: [],
    consequence:
      "Approving lets the assistant request this Change Plan once, so you can inspect it. The request never confirms or applies the change; denying withholds it.",
  };
}

const CITADEL_WARD_CONSEQUENCES: Readonly<Record<string, string>> = {
  "citadel_ward.integration_action":
    "Approving runs this exact integration action once. GoatCitadel re-checks the Citadel Ward first, so a ward that now denies still wins.",
  "citadel_ward.a2a_outbound":
    "Approving sends this exact A2A call to the peer once. GoatCitadel re-checks the Citadel Ward first, so a ward that now denies still wins.",
  "citadel_ward.a2a_push":
    "Approving delivers this one push event to the peer once, only if its push URL and citadel are unchanged. GoatCitadel re-checks the Citadel Ward first.",
};

/**
 * Citadel Ward approvals carry a bounded, redacted `preview.requestSummary` of the gated request; the gateway
 * executes the hash-bound payload, never this summary. Without a well-formed summary the generic model applies.
 */
export function citadelWardApprovalEvidence(approval: ApprovalRequest): ApprovalEvidenceModel | null {
  const consequence = CITADEL_WARD_CONSEQUENCES[approval.kind];
  const entries = consequence ? readRequestSummaryEntries(approval) : null;
  if (!consequence || !entries) return null;
  const payload = approval.payload as Record<string, unknown> | undefined;
  const citadelId = typeof payload?.citadelId === "string" ? payload.citadelId : undefined;
  const wardAction = typeof payload?.wardAction === "string" ? payload.wardAction : undefined;
  const workspaceId =
    approval.linkage?.workspaceId ?? (typeof payload?.workspaceId === "string" ? payload.workspaceId : undefined);
  const citadel = citadelId ? `citadel ${citadelId}` : "an unrecorded citadel";
  return {
    targets: entries.map((entry) => `${entry.label}: ${entry.value}`),
    targetEntries: entries.map((entry) => ({ label: entry.label, value: entry.value })),
    commands: [],
    changes: [],
    supporting: [],
    scopeSummary: workspaceId ? `Workspace ${workspaceId}, ${citadel}.` : `No workspace binding; ${citadel}.`,
    consequence,
    technicalDetails: [
      {
        label: "Citadel Ward",
        content: `Ward action: ${wardAction ?? "not recorded"}\nCitadel ID: ${citadelId ?? "not recorded"}`,
      },
    ],
  };
}
