import { randomUUID } from "node:crypto";
import type {
  BankrActionAuditRecord,
  BankrActionPreviewRequest,
  BankrActionPreviewResponse,
  BankrActionType,
  BankrSafetyPolicy,
} from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";

export const BANKR_POLICY_SETTINGS_KEY = "bankr_policy_v1";

const BANKR_SUPPORTED_CHAINS = [
  "base",
  "ethereum",
  "polygon",
  "solana",
  "unichain",
] as const;

const BANKR_ACTION_TYPES: BankrActionType[] = [
  "read",
  "trade",
  "transfer",
  "sign",
  "submit",
  "deploy",
];

const WRITE_ACTION_TYPES = new Set<BankrActionType>([
  "trade",
  "transfer",
  "sign",
  "submit",
  "deploy",
]);

const DEFAULT_BANKR_POLICY: BankrSafetyPolicy = {
  enabled: true,
  mode: "read_only",
  dailyUsdCap: 250,
  perActionUsdCap: 50,
  requireApprovalEveryWrite: true,
  allowedChains: [...BANKR_SUPPORTED_CHAINS],
  allowedActionTypes: [...BANKR_ACTION_TYPES],
  blockedSymbols: [],
};

export function getDefaultBankrSafetyPolicy(): BankrSafetyPolicy {
  return { ...DEFAULT_BANKR_POLICY };
}

export function readBankrSafetyPolicy(storage: Storage): BankrSafetyPolicy {
  const stored = storage.systemSettings.get<BankrSafetyPolicy>(BANKR_POLICY_SETTINGS_KEY)?.value;
  return normalizeBankrSafetyPolicy(stored);
}

export function writeBankrSafetyPolicy(
  storage: Storage,
  input: Partial<BankrSafetyPolicy>,
): BankrSafetyPolicy {
  const current = readBankrSafetyPolicy(storage);
  const next = normalizeBankrSafetyPolicy(input, current);
  storage.systemSettings.set(BANKR_POLICY_SETTINGS_KEY, next);
  return next;
}

export function normalizeBankrSafetyPolicy(
  input?: Partial<BankrSafetyPolicy>,
  current?: BankrSafetyPolicy,
): BankrSafetyPolicy {
  const base = current ?? getDefaultBankrSafetyPolicy();
  const allowedChains = normalizeStringArray(
    input?.allowedChains,
    base.allowedChains,
    "lower",
  );
  const allowedActionTypes = normalizeActionTypes(
    input?.allowedActionTypes,
    base.allowedActionTypes,
  );
  const blockedSymbols = normalizeStringArray(
    input?.blockedSymbols,
    base.blockedSymbols ?? [],
    "upper",
  );

  return {
    enabled: input?.enabled ?? base.enabled,
    mode: input?.mode ?? base.mode,
    dailyUsdCap: normalizeCurrency(
      input?.dailyUsdCap,
      base.dailyUsdCap,
    ),
    perActionUsdCap: normalizeCurrency(
      input?.perActionUsdCap,
      base.perActionUsdCap,
    ),
    // Locked on in high-safety mode: every write path stays approval-gated.
    requireApprovalEveryWrite: true,
    allowedChains: allowedChains.length > 0 ? allowedChains : [...BANKR_SUPPORTED_CHAINS],
    allowedActionTypes: allowedActionTypes.length > 0 ? allowedActionTypes : [...BANKR_ACTION_TYPES],
    blockedSymbols,
  };
}

export function normalizeBankrAction(
  input: Record<string, unknown>,
): BankrActionPreviewResponse["normalized"] {
  const prompt = asString(input.prompt)
    ?? asString(input.content)
    ?? asString(input.text);
  const actionType = normalizeActionType(
    asString(input.actionType) ?? asString(input.action),
    prompt,
  );
  const chain = normalizeChain(asString(input.chain), prompt);
  const symbol = normalizeSymbol(asString(input.symbol), prompt);
  const usdEstimate = normalizeUsdEstimate(input.usdEstimate, prompt);
  return {
    actionType,
    chain,
    symbol,
    usdEstimate,
    prompt,
  };
}

export function evaluateBankrActionPreview(
  storage: Storage,
  input: BankrActionPreviewRequest,
  at = new Date(),
): BankrActionPreviewResponse {
  const policy = readBankrSafetyPolicy(storage);
  const normalized = normalizeBankrAction(toPlainRecord(input));
  const day = currentDayKey(at);
  const dailyUsageUsd = readBankrDailyUsage(storage, day);
  const isWrite = WRITE_ACTION_TYPES.has(normalized.actionType);

  if (!policy.enabled) {
    return blocked("policy_disabled", "Bankr integration is disabled.", policy, normalized, dailyUsageUsd);
  }

  if (!policy.allowedActionTypes.includes(normalized.actionType)) {
    return blocked(
      "action_type_not_allowed",
      `Action type ${normalized.actionType} is not allowed by Bankr policy.`,
      policy,
      normalized,
      dailyUsageUsd,
    );
  }

  if (normalized.chain && !policy.allowedChains.includes(normalized.chain)) {
    return blocked(
      "chain_not_allowed",
      `Chain ${normalized.chain} is not allowed by Bankr policy.`,
      policy,
      normalized,
      dailyUsageUsd,
    );
  }

  if (
    normalized.symbol
    && (policy.blockedSymbols ?? []).includes(normalized.symbol)
  ) {
    return blocked(
      "symbol_blocked",
      `Symbol ${normalized.symbol} is blocked by Bankr policy.`,
      policy,
      normalized,
      dailyUsageUsd,
    );
  }

  if (isWrite && policy.mode !== "read_write") {
    return blocked(
      "read_only_mode",
      "Bankr policy is read-only. Switch mode to read_write for money-moving operations.",
      policy,
      normalized,
      dailyUsageUsd,
    );
  }

  if (isWrite) {
    if (!Number.isFinite(normalized.usdEstimate)) {
      return blocked(
        "usd_estimate_required",
        "Write action requires usdEstimate. Preview must include the estimated USD amount.",
        policy,
        normalized,
        dailyUsageUsd,
      );
    }
    if ((normalized.usdEstimate ?? 0) > policy.perActionUsdCap) {
      return blocked(
        "per_action_cap_exceeded",
        `Estimated USD amount exceeds per-action cap ($${policy.perActionUsdCap}).`,
        policy,
        normalized,
        dailyUsageUsd,
      );
    }
    if (dailyUsageUsd + (normalized.usdEstimate ?? 0) > policy.dailyUsdCap) {
      return blocked(
        "daily_cap_exceeded",
        `Estimated USD amount exceeds remaining daily cap ($${Math.max(0, policy.dailyUsdCap - dailyUsageUsd)}).`,
        policy,
        normalized,
        dailyUsageUsd,
      );
    }
  }

  const remainingDailyUsd = Math.max(
    0,
    policy.dailyUsdCap - dailyUsageUsd - (isWrite ? (normalized.usdEstimate ?? 0) : 0),
  );
  const remainingPerActionUsd = Math.max(
    0,
    policy.perActionUsdCap - (normalized.usdEstimate ?? 0),
  );

  return {
    allowed: true,
    reasonCode: "allowed",
    reason: isWrite
      ? "Bankr write action passed policy and budget checks."
      : "Bankr read action passed policy checks.",
    policy,
    normalized,
    dailyUsageUsd,
    remainingDailyUsd,
    remainingPerActionUsd,
  };
}

export function applyBankrBudgetUsage(
  storage: Storage,
  usdEstimate: number,
  at = new Date(),
): number {
  if (!Number.isFinite(usdEstimate) || usdEstimate <= 0) {
    return readBankrDailyUsage(storage, currentDayKey(at));
  }
  const day = currentDayKey(at);
  const now = at.toISOString();
  storage.db.prepare(`
    INSERT INTO bankr_budget_usage_daily (day, usd_total, updated_at)
    VALUES (@day, @usdTotal, @updatedAt)
    ON CONFLICT(day) DO UPDATE SET
      usd_total = usd_total + excluded.usd_total,
      updated_at = excluded.updated_at
  `).run({
    day,
    usdTotal: usdEstimate,
    updatedAt: now,
  });
  return readBankrDailyUsage(storage, day);
}

/**
 * Atomically reserve budget for a write action.
 *
 * Uses a BEGIN IMMEDIATE transaction so that the read-check-increment
 * sequence is serialised.  Two concurrent callers cannot both pass the
 * cap check when their combined cost would exceed `dailyUsdCap`.
 *
 * Returns `{ reserved: true, newTotal }` on success, or
 * `{ reserved: false, currentTotal }` when the cap would be exceeded.
 */
export function reserveBankrBudget(
  storage: Storage,
  usdEstimate: number,
  dailyUsdCap: number,
  at = new Date(),
): { reserved: boolean; dailyTotal: number } {
  if (!Number.isFinite(usdEstimate) || usdEstimate <= 0) {
    const total = readBankrDailyUsage(storage, currentDayKey(at));
    return { reserved: true, dailyTotal: total };
  }

  const day = currentDayKey(at);
  const now = at.toISOString();

  // BEGIN IMMEDIATE acquires a reserved lock immediately, serialising
  // concurrent writers so the read+check+write is atomic.
  return storage.runImmediateTransaction(() => {
    const currentTotal = readBankrDailyUsage(storage, day);

    if (currentTotal + usdEstimate > dailyUsdCap) {
      return { reserved: false, dailyTotal: currentTotal };
    }

    storage.db.prepare(`
      INSERT INTO bankr_budget_usage_daily (day, usd_total, updated_at)
      VALUES (@day, @usdTotal, @updatedAt)
      ON CONFLICT(day) DO UPDATE SET
        usd_total = usd_total + excluded.usd_total,
        updated_at = excluded.updated_at
    `).run({
      day,
      usdTotal: usdEstimate,
      updatedAt: now,
    });

    const newTotal = readBankrDailyUsage(storage, day);
    return { reserved: true, dailyTotal: newTotal };
  });
}

export function releaseBankrBudgetReservation(
  storage: Storage,
  usdEstimate: number,
  at = new Date(),
): number {
  if (!Number.isFinite(usdEstimate) || usdEstimate <= 0) {
    return readBankrDailyUsage(storage, currentDayKey(at));
  }

  const day = currentDayKey(at);
  const now = at.toISOString();

  return storage.runImmediateTransaction(() => {
    const currentTotal = readBankrDailyUsage(storage, day);
    const nextTotal = Math.max(0, currentTotal - usdEstimate);
    storage.db.prepare(`
      INSERT INTO bankr_budget_usage_daily (day, usd_total, updated_at)
      VALUES (@day, @usdTotal, @updatedAt)
      ON CONFLICT(day) DO UPDATE SET
        usd_total = @usdTotal,
        updated_at = excluded.updated_at
    `).run({
      day,
      usdTotal: nextTotal,
      updatedAt: now,
    });
    return readBankrDailyUsage(storage, day);
  });
}

export function readBankrDailyUsage(storage: Storage, day = currentDayKey()): number {
  const row = storage.db.prepare(`
    SELECT usd_total AS usdTotal
    FROM bankr_budget_usage_daily
    WHERE day = @day
  `).get({ day }) as { usdTotal?: number } | undefined;
  return Number.isFinite(row?.usdTotal) ? Number(row?.usdTotal) : 0;
}

export function appendBankrActionAudit(
  storage: Storage,
  input: Omit<BankrActionAuditRecord, "actionId" | "createdAt"> & {
    actionId?: string;
    createdAt?: string;
  },
): BankrActionAuditRecord {
  const actionId = input.actionId ?? randomUUID();
  const createdAt = input.createdAt ?? new Date().toISOString();
  const record: BankrActionAuditRecord = {
    actionId,
    sessionId: input.sessionId,
    actorId: input.actorId,
    actionType: input.actionType,
    chain: input.chain,
    symbol: input.symbol,
    usdEstimate: input.usdEstimate,
    status: input.status,
    approvalId: input.approvalId,
    policyReason: input.policyReason,
    details: input.details,
    createdAt,
  };
  const usdEstimate = typeof record.usdEstimate === "number" && Number.isFinite(record.usdEstimate)
    ? record.usdEstimate
    : null;
  storage.db.prepare(`
    INSERT INTO bankr_action_audit (
      action_id,
      session_id,
      actor_id,
      action_type,
      chain,
      symbol,
      usd_estimate,
      status,
      approval_id,
      policy_reason,
      details_json,
      created_at
    ) VALUES (
      @actionId,
      @sessionId,
      @actorId,
      @actionType,
      @chain,
      @symbol,
      @usdEstimate,
      @status,
      @approvalId,
      @policyReason,
      @detailsJson,
      @createdAt
    )
  `).run({
    actionId: record.actionId,
    sessionId: record.sessionId,
    actorId: record.actorId,
    actionType: record.actionType,
    chain: record.chain ?? null,
    symbol: record.symbol ?? null,
    usdEstimate,
    status: record.status,
    approvalId: record.approvalId ?? null,
    policyReason: record.policyReason ?? null,
    detailsJson: record.details ? JSON.stringify(record.details) : null,
    createdAt: record.createdAt,
  });
  return record;
}

function blocked(
  reasonCode: string,
  reason: string,
  policy: BankrSafetyPolicy,
  normalized: BankrActionPreviewResponse["normalized"],
  dailyUsageUsd: number,
): BankrActionPreviewResponse {
  return {
    allowed: false,
    reasonCode,
    reason,
    policy,
    normalized,
    dailyUsageUsd,
    remainingDailyUsd: Math.max(0, policy.dailyUsdCap - dailyUsageUsd),
    remainingPerActionUsd: Number.isFinite(normalized.usdEstimate)
      ? Math.max(0, policy.perActionUsdCap - (normalized.usdEstimate ?? 0))
      : policy.perActionUsdCap,
  };
}

function normalizeActionType(
  raw: string | undefined,
  prompt: string | undefined,
): BankrActionType {
  if (raw) {
    const normalized = raw.trim().toLowerCase();
    if (BANKR_ACTION_TYPES.includes(normalized as BankrActionType)) {
      return normalized as BankrActionType;
    }
  }

  const source = (prompt ?? "").toLowerCase();
  if (!source) {
    return "read";
  }
  if (/\b(deploy|launch)\b/.test(source)) {
    return "deploy";
  }
  if (/\b(submit|broadcast|raw transaction)\b/.test(source)) {
    return "submit";
  }
  if (/\b(sign|signature)\b/.test(source)) {
    return "sign";
  }
  if (/\b(send|transfer|bridge)\b/.test(source)) {
    return "transfer";
  }
  if (/\b(buy|sell|swap|trade|order|dca|twap|long|short|leverage|bet)\b/.test(source)) {
    return "trade";
  }
  return "read";
}

function normalizeChain(
  rawChain: string | undefined,
  prompt: string | undefined,
): string | undefined {
  const value = rawChain?.trim().toLowerCase();
  if (value) {
    return value === "mainnet" ? "ethereum" : value;
  }
  const source = (prompt ?? "").toLowerCase();
  if (!source) {
    return undefined;
  }
  if (/\bbase\b/.test(source)) return "base";
  if (/\bethereum\b|\bmainnet\b/.test(source)) return "ethereum";
  if (/\bpolygon\b/.test(source)) return "polygon";
  if (/\bsolana\b/.test(source)) return "solana";
  if (/\bunichain\b/.test(source)) return "unichain";
  return undefined;
}

function normalizeSymbol(
  rawSymbol: string | undefined,
  prompt: string | undefined,
): string | undefined {
  if (rawSymbol?.trim()) {
    return rawSymbol.trim().toUpperCase();
  }
  const source = prompt ?? "";
  const match = source.match(/\b[A-Z]{2,10}\b/);
  return match?.[0]?.toUpperCase();
}

function normalizeUsdEstimate(
  raw: unknown,
  prompt: string | undefined,
): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return raw;
  }
  if (typeof raw === "string") {
    const parsed = Number(raw.trim());
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  const source = prompt ?? "";
  const match = source.match(/\$([0-9]+(?:\.[0-9]+)?)/);
  if (!match?.[1]) {
    return undefined;
  }
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizeCurrency(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Number(value);
  }
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return fallback;
}

function normalizeActionTypes(
  value: unknown,
  fallback: BankrActionType[],
): BankrActionType[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }
  const allowed = new Set<BankrActionType>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const normalized = item.trim().toLowerCase() as BankrActionType;
    if (BANKR_ACTION_TYPES.includes(normalized)) {
      allowed.add(normalized);
    }
  }
  return [...allowed];
}

function normalizeStringArray(
  value: unknown,
  fallback: string[],
  mode: "lower" | "upper",
): string[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }
  const out = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    out.add(mode === "lower" ? trimmed.toLowerCase() : trimmed.toUpperCase());
  }
  return [...out];
}

function currentDayKey(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toPlainRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return { ...value };
}
