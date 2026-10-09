import type { ApprovalRequest, RuntimeLifecycleResponse } from "@goatcitadel/contracts";
import { presentApprovalOutcome, presentApprovalStatus } from "./status-vocabulary.js";
import { externalSourceKnowledgeApprovalEvidence } from "./external-source-approval-evidence.js";
import { communicationsMailSendApprovalEvidence } from "./communications-approval-evidence.js";

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
  /** The same targets as label/value pairs, when the generic builder labelled them. Absent for purpose-specific models. */
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
function addTarget(collector: { targets: Set<string>; targetEntries: Map<string, ApprovalTargetEntry> }, label: string, value: string): void {
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
        const lines = ["target", "scopeSummary", "consequence", "requestedTitle", "requestedContent", "pinnedSummary", "ttlSummary", "withheldSummary"]
          .filter(key => typeof row[key] === "string")
          .map(key => isMemoryLifecycleSummaryKey(record.reviewKind, key) ? String(row[key]) : humanizeKey(key) + ": " + String(row[key]));
        pushEvidenceBlock(collector.changes, collector.seenBlocks, "Memory target " + (index + 1), lines.join("\n"), collector.exact, true);
      });
      continue;
    }
    for (const [key, value] of Object.entries(record)) {
      if (typeof record.reviewKind === "string" && record.reviewKind.startsWith("memory.lifecycle.") && ["fieldCodes", "subjectKind", "subjectId", "action"].includes(key)) continue;
      if (collector.exact && /hash|staging|candidate|remaining|outputIntent/i.test(key) && ["string", "number", "boolean"].includes(typeof value)) {
        collector.supporting.add(`${humanizeKey(key)}: ${String(value)}`);
      }
      if (typeof value === "string") {
        if (isMemoryLifecycleSummaryKey(record.reviewKind, key)) {
          collector.supporting.add(collector.exact ? value : truncateEvidence(value, 180));
        } else if (record.reviewKind === "memory.lifecycle.patch" && (key === "requestedContent" || key === "requestedTitle")) {
          pushEvidenceBlock(collector.changes, collector.seenBlocks, key === "requestedContent" ? "Requested memory content" : "Requested memory title", value, collector.exact, true);
        } else if (record.reviewKind === "knowledge.operation" && (key === "query" || key === "source")) {
          pushEvidenceBlock(collector.changes, collector.seenBlocks, key === "query" ? "Knowledge query" : "Knowledge source", value, collector.exact, true);
        } else if (isFilesystemKey(key) || /^(candidateId|versionId|subjectId|subjectKind|scopeKind)$/.test(key)) {
          addTarget(collector, humanizeKey(key), value);
        } else if (isLikelyCommandKey(key) && value.trim()) {
          collector.commands.add(`${humanizeKey(key)}: ${collector.exact ? value : truncateEvidence(value, 140)}`);
        } else if (key === "content" && (record.toolName === "memory.write" || record.toolName === "memory.upsert")) {
          // The server's allowlisted, redacted memory body is review evidence even on one line.
          pushEvidenceBlock(collector.changes, collector.seenBlocks, "Memory content", value, collector.exact, true);
        } else if (isLikelyCodeKey(key) && value.includes("\n")) {
          pushEvidenceBlock(collector.changes, collector.seenBlocks, humanizeKey(key), value, collector.exact);
        } else if (isLikelySupportKey(key)) {
          collector.supporting.add(`${humanizeKey(key)}: ${collector.exact ? value : truncateEvidence(value, 180)}`);
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
  return buildApprovalReviewEvidenceModel(approval.preview);
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
