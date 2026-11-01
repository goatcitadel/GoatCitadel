import type { ApprovalRequest, RuntimeLifecycleResponse } from "@goatcitadel/contracts";
import { presentApprovalOutcome, presentApprovalStatus } from "./status-vocabulary.js";
import { externalSourceKnowledgeApprovalEvidence } from "./external-source-approval-evidence.js";
import { communicationsMailSendApprovalEvidence } from "./communications-approval-evidence.js";
import { skillStateApprovalEvidence } from "./skill-state-approval-evidence.js";
import { codeModeRequestInput } from "./code-mode-request-input.js";

export interface ApprovalEvidenceBlock {
  label: string;
  content: string;
}

/** Display canonical reasons without treating legacy notes as operator intent. */
export function approvalResolutionLabel(approval: ApprovalRequest): string {
  if (isExpiredApproval(approval)) return presentApprovalOutcome("expired").label.toLowerCase();
  if (approval.status === "pending") return "pending";
  if (approval.resolutionOutcome) return presentApprovalOutcome(approval.resolutionOutcome).label.toLowerCase();
  return presentApprovalStatus(approval.status).label.toLowerCase();
}

export interface ApprovalTargetEntry {
  label: string;
  value: string;
}

export interface ApprovalEvidenceModel {
  scopeSummary?: string;
  consequence?: string;
  technicalDetails?: ApprovalEvidenceBlock[];
  targets: string[];
  /** The same targets as label/value pairs, when they carry labels (generic and Citadel Ward models). Absent otherwise. */
  targetEntries?: ApprovalTargetEntry[];
  commands: string[];
  changes: ApprovalEvidenceBlock[];
  supporting: string[];
}

export function findTraceMetadata(payload: unknown): { correlationId?: string; traceId?: string } | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const stack: unknown[] = [payload];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== "object") {
      continue;
    }
    const record = current as Record<string, unknown>;
    const correlationId = typeof record.correlationId === "string" ? record.correlationId : undefined;
    const traceId = typeof record.traceId === "string" ? record.traceId : undefined;
    if (correlationId || traceId) {
      return { correlationId, traceId };
    }
    for (const value of Object.values(record)) {
      if (value && typeof value === "object") {
        stack.push(value);
      }
    }
  }
  return null;
}

export function mergeApprovals(groups: ApprovalRequest[][]): ApprovalRequest[] {
  const byId = new Map<string, ApprovalRequest>();
  for (const items of groups) {
    for (const item of items) {
      const current = byId.get(item.approvalId);
      if (!current || Date.parse(item.createdAt) >= Date.parse(current.createdAt)) {
        byId.set(item.approvalId, item);
      }
    }
  }
  return Array.from(byId.values()).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export function hasRecoveryLinkage(approval: ApprovalRequest): boolean {
  return Boolean(
    approval.linkage?.durableRunId ||
    approval.linkage?.proactiveRunId ||
    approval.linkage?.taskId ||
    approval.linkage?.correlationId ||
    approval.linkage?.traceId,
  );
}

export function isExpiredApproval(approval: ApprovalRequest): boolean {
  if (approval.status !== "pending" || !approval.expiresAt) {
    return false;
  }
  const expiresAtMs = Date.parse(approval.expiresAt);
  return Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now();
}

export function getCanonicalDurableRunId(lifecycle: RuntimeLifecycleResponse): string | null {
  return lifecycle.canonical?.runId ?? lifecycle.approval?.linkage?.durableRunId ?? null;
}

export function isBlockedDurableStatus(status: string): boolean {
  return status === "paused" || status === "waiting";
}

export function formatInferredIds(ids: string[], canonicalId?: string | null): string {
  const inferred = ids.filter((id) => id !== canonicalId);
  return inferred.length > 0 ? inferred.join(", ") : "none";
}

function isFilesystemKey(key: string): boolean {
  return /path|paths|file|files|root|roots|target|targets/i.test(key);
}

function isLikelyCommandKey(key: string): boolean {
  return /command|cmd|script|shell/i.test(key);
}

function isLikelyCodeKey(key: string): boolean {
  return /diff|patch|before|after|code|content|snippet/i.test(key);
}

function isLikelyCodeCollectionKey(key: string): boolean {
  return /diffs|patches|snippets|files/i.test(key);
}

function isLikelySupportKey(key: string): boolean {
  return /url|uri|reason|summary|description|title|selector|field|input|prompt/i.test(key);
}

function humanizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (char) => char.toUpperCase());
}

function truncateEvidence(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit).trimEnd()}\n...` : value;
}

/**
 * Shortens a one-line preview at a word boundary so a reviewer never reads a half word ("a separate s…").
 * Text with no break in the second half of the window (an id or a long token) is cut at the limit.
 */
function truncateLine(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const window = value.slice(0, limit);
  const lastBreak = window.search(/\s\S*$/u);
  return `${(lastBreak > limit / 2 ? window.slice(0, lastBreak) : window).trimEnd()}…`;
}

function pushEvidenceBlock(
  codeBlocks: ApprovalEvidenceBlock[],
  seenBlocks: Set<string>,
  label: string,
  content: string,
  exact = false,
  preserveWhitespace = false,
): void {
  const normalized = exact && preserveWhitespace ? content : content.trim();
  if (!normalized.trim() && !(exact && preserveWhitespace && content.length > 0)) {
    return;
  }
  const key = `${label}:${normalized}`;
  if (seenBlocks.has(key)) {
    return;
  }
  seenBlocks.add(key);
  codeBlocks.push({
    label,
    content: exact ? normalized : truncateEvidence(normalized, 1200),
  });
}

/** Records a target both as its labelled line and as a label/value pair, so a renderer never re-labels it. */
function addTarget(
  collector: { targets: Set<string>; targetEntries: Map<string, ApprovalTargetEntry> },
  label: string,
  value: string,
): void {
  const line = `${label}: ${value}`;
  collector.targets.add(line);
  if (!collector.targetEntries.has(line)) collector.targetEntries.set(line, { label, value });
}

// Memory lifecycle review summaries are sentences the Gateway already labels ("Requested TTL: 600 seconds",
// "Unpin item"); a generated key label in front of them would only repeat it ("Ttl Summary: Requested TTL: …").
function isMemoryLifecycleSummaryKey(reviewKind: unknown, key: string): boolean {
  return typeof reviewKind === "string" && reviewKind.startsWith("memory.lifecycle.") && /Summary$/.test(key);
}

function collectApprovalEvidence(
  source: unknown,
  collector: {
    targets: Set<string>;
    targetEntries: Map<string, ApprovalTargetEntry>;
    commands: Set<string>;
    supporting: Set<string>;
    changes: ApprovalEvidenceBlock[];
    seenBlocks: Set<string>;
    exact: boolean;
  },
): void {
  if (!source || typeof source !== "object") {
    return;
  }

  const visited = new Set<unknown>();
  const stack: unknown[] = [source];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== "object" || visited.has(current)) {
      continue;
    }
    visited.add(current);

    if (Array.isArray(current)) {
      current.forEach((item) => stack.push(item));
      continue;
    }

    const record = current as Record<string, unknown>;
    if (record.reviewKind === "memory.lifecycle.batch" && Array.isArray(record.reviewedItems)) {
      record.reviewedItems.forEach((item, index) => {
        if (!item || typeof item !== "object") return;
        const row = item as Record<string, unknown>;
        const lines = [
          "target",
          "scopeSummary",
          "consequence",
          "requestedTitle",
          "requestedContent",
          "pinnedSummary",
          "ttlSummary",
          "withheldSummary",
        ]
          .filter((key) => typeof row[key] === "string")
          .map((key) =>
            isMemoryLifecycleSummaryKey(record.reviewKind, key)
              ? String(row[key])
              : humanizeKey(key) + ": " + String(row[key]),
          );
        pushEvidenceBlock(
          collector.changes,
          collector.seenBlocks,
          "Memory target " + (index + 1),
          lines.join("\n"),
          collector.exact,
          true,
        );
      });
      continue;
    }
    for (const [key, value] of Object.entries(record)) {
      if (
        typeof record.reviewKind === "string" &&
        record.reviewKind.startsWith("memory.lifecycle.") &&
        ["fieldCodes", "subjectKind", "subjectId", "action"].includes(key)
      )
        continue;
      if (
        collector.exact &&
        /hash|staging|candidate|remaining|outputIntent/i.test(key) &&
        ["string", "number", "boolean"].includes(typeof value)
      ) {
        collector.supporting.add(`${humanizeKey(key)}: ${String(value)}`);
      }
      if (typeof value === "string") {
        if (isMemoryLifecycleSummaryKey(record.reviewKind, key)) {
          collector.supporting.add(collector.exact ? value : truncateLine(value, 180));
        } else if (
          record.reviewKind === "memory.lifecycle.patch" &&
          (key === "requestedContent" || key === "requestedTitle")
        ) {
          pushEvidenceBlock(
            collector.changes,
            collector.seenBlocks,
            key === "requestedContent" ? "Requested memory content" : "Requested memory title",
            value,
            collector.exact,
            true,
          );
        } else if (record.reviewKind === "knowledge.operation" && (key === "query" || key === "source")) {
          pushEvidenceBlock(
            collector.changes,
            collector.seenBlocks,
            key === "query" ? "Knowledge query" : "Knowledge source",
            value,
            collector.exact,
            true,
          );
        } else if (isFilesystemKey(key) || /^(candidateId|versionId|subjectId|subjectKind|scopeKind)$/.test(key)) {
          addTarget(collector, humanizeKey(key), value);
        } else if (isLikelyCommandKey(key) && value.trim()) {
          collector.commands.add(`${humanizeKey(key)}: ${collector.exact ? value : truncateLine(value, 140)}`);
        } else if (key === "content" && (record.toolName === "memory.write" || record.toolName === "memory.upsert")) {
          // The server's allowlisted, redacted memory body is review evidence even on one line.
          pushEvidenceBlock(collector.changes, collector.seenBlocks, "Memory content", value, collector.exact, true);
        } else if (isLikelyCodeKey(key) && value.includes("\n")) {
          pushEvidenceBlock(collector.changes, collector.seenBlocks, humanizeKey(key), value, collector.exact);
        } else if (isLikelySupportKey(key)) {
          collector.supporting.add(`${humanizeKey(key)}: ${collector.exact ? value : truncateLine(value, 180)}`);
        }
      } else if (Array.isArray(value)) {
        if (value.every((item) => typeof item === "string")) {
          const strings = value.filter((item): item is string => typeof item === "string");
          if (isFilesystemKey(key)) {
            addTarget(
              collector,
              humanizeKey(key),
              `${(collector.exact ? strings : strings.slice(0, 4)).join(", ")}${!collector.exact && strings.length > 4 ? "…" : ""}`,
            );
          } else if (isLikelyCommandKey(key)) {
            collector.commands.add(
              `${humanizeKey(key)}: ${(collector.exact ? strings : strings.slice(0, 3)).join(" | ")}${!collector.exact && strings.length > 3 ? "…" : ""}`,
            );
          } else if (isLikelyCodeCollectionKey(key)) {
            for (const item of collector.exact ? strings : strings.slice(0, 2)) {
              if (item.includes("\n")) {
                pushEvidenceBlock(collector.changes, collector.seenBlocks, humanizeKey(key), item, collector.exact);
              }
            }
          } else if (isLikelySupportKey(key)) {
            collector.supporting.add(
              `${humanizeKey(key)}: ${(collector.exact ? strings : strings.slice(0, 3)).join(", ")}${!collector.exact && strings.length > 3 ? "…" : ""}`,
            );
          }
        }
        value.forEach((item) => stack.push(item));
      } else if (value && typeof value === "object") {
        stack.push(value);
      }
    }
  }
}

export function buildApprovalEvidenceModel(...sources: Array<unknown>): ApprovalEvidenceModel | null {
  return buildEvidence(sources, false);
}
/** Exact target/command review; compact summaries must never authorize a truncated action. */
export function buildApprovalReviewEvidenceModel(...sources: Array<unknown>): ApprovalEvidenceModel | null {
  return buildEvidence(sources, true);
}
/** Purpose-specific approvals must match their own original payload and scope. */
export function buildApprovalRequestReviewEvidenceModel(approval: ApprovalRequest): ApprovalEvidenceModel | null {
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
 * A browser errand's risky step (a click or entry the errand wants to make). The preview names the step, the page it
 * is on (the target) and that page's address (supporting); the screenshot the Gateway captured with it is shown beside
 * the decision. Without a step or a page title there is nothing exact to review here, so the generic model applies.
 */
export function browserErrandActionApprovalEvidence(approval: ApprovalRequest): ApprovalEvidenceModel | null {
  const preview = approval.preview as Record<string, unknown> | undefined;
  const summary = nonEmptyText(preview?.summary);
  const title = nonEmptyText(preview?.title);
  if (!summary && !title) return null;
  const url = nonEmptyText(preview?.url);
  const entries: ApprovalTargetEntry[] = [
    ...(summary ? [{ label: "Step", value: summary }] : []),
    ...(title ? [{ label: "Page", value: title }] : []),
  ];
  return {
    targets: entries.map((entry) => `${entry.label}: ${entry.value}`),
    targetEntries: entries,
    commands: [],
    changes: [],
    supporting: url ? [url] : [],
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
function buildEvidence(sources: Array<unknown>, exact: boolean): ApprovalEvidenceModel | null {
  const targets = new Set<string>();
  const targetEntries = new Map<string, ApprovalTargetEntry>();
  const commands = new Set<string>();
  const supporting = new Set<string>();
  const changes: ApprovalEvidenceBlock[] = [];
  const seenBlocks = new Set<string>();

  for (const source of sources) {
    collectApprovalEvidence(source, {
      targets,
      targetEntries,
      commands,
      supporting,
      changes,
      seenBlocks,
      exact,
    });
  }

  if (targets.size === 0 && commands.size === 0 && supporting.size === 0 && changes.length === 0) {
    return null;
  }

  const targetLines = exact ? [...targets] : [...targets].slice(0, 6);
  return {
    targets: targetLines,
    targetEntries: targetLines.map((line) => targetEntries.get(line) ?? { label: "Target", value: line }),
    commands: exact ? [...commands] : [...commands].slice(0, 4),
    supporting: exact ? [...supporting] : [...supporting].slice(0, 4),
    changes: exact ? changes : changes.slice(0, 4),
  };
}
