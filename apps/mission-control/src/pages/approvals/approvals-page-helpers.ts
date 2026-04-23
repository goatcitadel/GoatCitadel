import type { ApprovalRequest, RuntimeLifecycleResponse } from "@goatcitadel/contracts";

export interface ApprovalEvidenceBlock {
  label: string;
  content: string;
}

export interface ApprovalEvidenceModel {
  targets: string[];
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
): void {
  const normalized = content.trim();
  if (!normalized) {
    return;
  }
  const key = `${label}:${normalized}`;
  if (seenBlocks.has(key)) {
    return;
  }
  seenBlocks.add(key);
  codeBlocks.push({
    label,
    content: truncateEvidence(normalized, 1200),
  });
}

function collectApprovalEvidence(
  source: unknown,
  collector: {
    targets: Set<string>;
    commands: Set<string>;
    supporting: Set<string>;
    changes: ApprovalEvidenceBlock[];
    seenBlocks: Set<string>;
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
    for (const [key, value] of Object.entries(record)) {
      if (typeof value === "string") {
        if (isFilesystemKey(key)) {
          collector.targets.add(`${humanizeKey(key)}: ${value}`);
        } else if (isLikelyCommandKey(key) && value.trim()) {
          collector.commands.add(`${humanizeKey(key)}: ${truncateEvidence(value, 140)}`);
        } else if (isLikelyCodeKey(key) && value.includes("\n")) {
          pushEvidenceBlock(collector.changes, collector.seenBlocks, humanizeKey(key), value);
        } else if (isLikelySupportKey(key)) {
          collector.supporting.add(`${humanizeKey(key)}: ${truncateEvidence(value, 180)}`);
        }
      } else if (Array.isArray(value)) {
        if (value.every((item) => typeof item === "string")) {
          const strings = value.filter((item): item is string => typeof item === "string");
          if (isFilesystemKey(key)) {
            collector.targets.add(
              `${humanizeKey(key)}: ${strings.slice(0, 4).join(", ")}${strings.length > 4 ? "..." : ""}`,
            );
          } else if (isLikelyCommandKey(key)) {
            collector.commands.add(
              `${humanizeKey(key)}: ${strings.slice(0, 3).join(" | ")}${strings.length > 3 ? "..." : ""}`,
            );
          } else if (isLikelyCodeCollectionKey(key)) {
            for (const item of strings.slice(0, 2)) {
              if (item.includes("\n")) {
                pushEvidenceBlock(collector.changes, collector.seenBlocks, humanizeKey(key), item);
              }
            }
          } else if (isLikelySupportKey(key)) {
            collector.supporting.add(
              `${humanizeKey(key)}: ${strings.slice(0, 3).join(", ")}${strings.length > 3 ? "..." : ""}`,
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
  const targets = new Set<string>();
  const commands = new Set<string>();
  const supporting = new Set<string>();
  const changes: ApprovalEvidenceBlock[] = [];
  const seenBlocks = new Set<string>();

  for (const source of sources) {
    collectApprovalEvidence(source, {
      targets,
      commands,
      supporting,
      changes,
      seenBlocks,
    });
  }

  if (targets.size === 0 && commands.size === 0 && supporting.size === 0 && changes.length === 0) {
    return null;
  }

  return {
    targets: [...targets].slice(0, 6),
    commands: [...commands].slice(0, 4),
    supporting: [...supporting].slice(0, 4),
    changes: changes.slice(0, 4),
  };
}
