import { randomUUID } from "node:crypto";
import type {
  MemoryActionLedgerEntry,
  MemoryActionLedgerOperationKind,
  MemoryActionLedgerStatus,
  MemoryBatchMutationOperationKind,
} from "@goatcitadel/contracts";

const DEFAULT_MEMORY_ACTION_SOURCE = "gateway.memory.batch_mutation";
const SECRET_LIKE_LEDGER_PATTERN =
  /(?:(?:api[_-]?key|auth|cookie|credential|password|secret|token)\s*[:=]\s*["']?[a-z0-9._/-]{8,}|sk-[a-z0-9_-]{16,}|ghp_[a-z0-9_]{16,}|xox[baprs]-[a-z0-9-]{16,}|bearer\s+[a-z0-9._-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;

export interface MemoryActionLedgerOperationSummary {
  kind: MemoryBatchMutationOperationKind;
  itemId: string;
  changedFields?: string[];
}

export interface BuildMemoryActionLedgerInput {
  actionId?: string;
  ownerId: string;
  source?: string;
  status: MemoryActionLedgerStatus;
  operations: MemoryActionLedgerOperationSummary[];
  timestamp?: string;
  failureReason?: string;
}

export interface BuildMemoryActionContextInput {
  actionId?: string;
  ownerId: string;
  source?: string;
  defaultSource?: string;
  timestamp?: string;
}

export interface MemoryActionContext {
  actionId: string;
  ownerId: string;
  source: string;
  timestamp: string;
}

export function buildMemoryActionContext(input: BuildMemoryActionContextInput): MemoryActionContext {
  return {
    actionId: normalizeLedgerActionId(input.actionId),
    ownerId: safeLedgerText(input.ownerId, "operator"),
    source: safeLedgerText(input.source, input.defaultSource ?? DEFAULT_MEMORY_ACTION_SOURCE),
    timestamp: input.timestamp ?? new Date().toISOString(),
  };
}

export function buildMemoryActionLedgerEntry(input: BuildMemoryActionLedgerInput): MemoryActionLedgerEntry {
  const context = buildMemoryActionContext(input);
  const operations = input.operations.map((operation) => ({
    ...operation,
    itemId: operation.itemId.trim(),
    changedFields: normalizeChangedFields(operation.changedFields),
  }));
  const targetItemIds = Array.from(new Set(operations.map((operation) => operation.itemId).filter(Boolean)));
  const operationKind = summarizeOperationKind(operations.map((operation) => operation.kind));
  const changedFields = Object.fromEntries(
    operations
      .filter((operation) => operation.changedFields && operation.changedFields.length > 0)
      .map((operation) => [operation.itemId, operation.changedFields ?? []]),
  );
  const hasChangedFields = Object.keys(changedFields).length > 0;

  return {
    ...context,
    status: input.status,
    targetItemIds,
    operationKind,
    operationCount: operations.length,
    reversal: buildReversalNote(operationKind, hasChangedFields),
    reapply: buildReapplyNote(operationKind, hasChangedFields),
    evidence: {
      storesRawContent: false,
      redactionNote:
        "Ledger evidence records item ids, operation kinds, and field names only; raw memory content is excluded.",
      ...(hasChangedFields ? { changedFields } : {}),
      ...(input.failureReason ? { failureReason: safeLedgerText(input.failureReason, "redacted failure") } : {}),
    },
  };
}

export function buildMemoryChangeLedgerPayload(
  ledger: MemoryActionLedgerEntry,
  operation: MemoryActionLedgerOperationSummary,
): Record<string, unknown> {
  return {
    actionId: ledger.actionId,
    ownerId: ledger.ownerId,
    source: ledger.source,
    timestamp: ledger.timestamp,
    status: ledger.status,
    targetItemIds: ledger.targetItemIds,
    operationKind: operation.kind,
    changedFields: normalizeChangedFields(operation.changedFields),
    reversal: ledger.reversal,
    reapply: ledger.reapply,
    storesRawContent: false,
  };
}

function summarizeOperationKind(kinds: MemoryBatchMutationOperationKind[]): MemoryActionLedgerOperationKind {
  const uniqueKinds = new Set(kinds);
  if (uniqueKinds.size === 1) {
    return kinds[0] ?? "mixed";
  }
  return "mixed";
}

function buildReversalNote(
  operationKind: MemoryActionLedgerOperationKind,
  hasChangedFields: boolean,
): MemoryActionLedgerEntry["reversal"] {
  if (operationKind === "forget_item") {
    return {
      feasible: true,
      note: "Reverse through an operator-approved memory restore path by restoring prior status and clearing forgottenAt.",
    };
  }
  if (operationKind === "patch_item") {
    return {
      feasible: true,
      note: hasChangedFields
        ? "Reverse by applying prior values for the recorded field names from trusted item history or backup evidence."
        : "Reverse with the trusted pre-mutation item snapshot; ledger intentionally excludes raw field values.",
    };
  }
  return {
    feasible: true,
    note: "Reverse in the original operation order using operator-approved restore evidence for each item.",
  };
}

function buildReapplyNote(
  operationKind: MemoryActionLedgerOperationKind,
  hasChangedFields: boolean,
): MemoryActionLedgerEntry["reapply"] {
  if (operationKind === "forget_item") {
    return {
      feasible: true,
      note: "Reapply by running forget_item for the recorded target item ids.",
    };
  }
  return {
    feasible: !hasChangedFields,
    note: hasChangedFields
      ? "Reapply requires the original approved request or operator evidence because raw patch values are not stored in the ledger."
      : "Reapply from the original request context; the ledger records ids and operation kinds only.",
  };
}

function normalizeChangedFields(fields: string[] | undefined): string[] {
  return Array.from(new Set((fields ?? []).map((field) => field.trim()).filter(Boolean))).sort();
}

function normalizeLedgerActionId(value: string | undefined): string {
  const normalized = value
    ?.trim()
    .replace(/[^a-zA-Z0-9._:-]/gu, "")
    .slice(0, 120);
  if (!normalized || SECRET_LIKE_LEDGER_PATTERN.test(normalized)) {
    return randomUUID();
  }
  return normalized;
}

function safeLedgerText(value: string | undefined, fallback: string): string {
  const normalized = value?.trim();
  if (!normalized || SECRET_LIKE_LEDGER_PATTERN.test(normalized)) {
    return fallback;
  }
  return normalized.slice(0, 160);
}
