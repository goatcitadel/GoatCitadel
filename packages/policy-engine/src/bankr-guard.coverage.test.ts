import { describe, expect, it } from "vitest";
import type { BankrActionPreviewRequest, BankrActionType } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import {
  appendBankrActionAudit,
  applyBankrBudgetUsage,
  evaluateBankrActionPreview,
  getDefaultBankrSafetyPolicy,
  normalizeBankrAction,
  normalizeBankrSafetyPolicy,
  readBankrDailyUsage,
  readBankrSafetyPolicy,
  releaseBankrBudgetReservation,
  reserveBankrBudget,
  writeBankrSafetyPolicy,
} from "./bankr-guard.js";

function createStorageStub(): {
  storage: Storage;
  daily: Map<string, number>;
  auditRows: Array<Record<string, unknown>>;
} {
  const settings = new Map<string, unknown>();
  const daily = new Map<string, number>();
  const auditRows: Array<Record<string, unknown>> = [];

  const storage = {
    systemSettings: {
      get: <T>(key: string) => {
        if (!settings.has(key)) {
          return undefined;
        }
        return {
          key,
          value: settings.get(key) as T,
        };
      },
      set: (key: string, value: unknown) => {
        settings.set(key, value);
      },
    },
    db: {
      prepare: (sql: string) => ({
        run: (params: Record<string, unknown>) => {
          if (sql.includes("bankr_budget_usage_daily")) {
            const day = String(params.day ?? "");
            const amount = Number(params.usdTotal ?? 0);
            if (sql.includes("usd_total = @usdTotal")) {
              daily.set(day, Number.isFinite(amount) ? amount : 0);
              return { changes: 1 };
            }
            const prior = daily.get(day) ?? 0;
            daily.set(day, prior + (Number.isFinite(amount) ? amount : 0));
            return { changes: 1 };
          }
          if (sql.includes("bankr_action_audit")) {
            auditRows.push({ ...params });
            return { changes: 1 };
          }
          return { changes: 0 };
        },
        get: (params: Record<string, unknown>) => {
          if (sql.includes("FROM bankr_budget_usage_daily")) {
            const day = String(params.day ?? "");
            return { usdTotal: daily.get(day) ?? 0 };
          }
          return undefined;
        },
      }),
    },
    // Supports reserveBankrBudget's atomic check-and-increment path.
    runImmediateTransaction: <T>(callback: () => T): T => {
      // In a real SQLite db this acquires a reserved lock; the stub
      // simply executes the callback synchronously (single-threaded).
      return callback();
    },
  } as unknown as Storage;

  return { storage, daily, auditRows };
}

describe("bankr guard coverage sweep", () => {
  it("normalizes policy input and persists settings", () => {
    const { storage } = createStorageStub();
    const defaults = getDefaultBankrSafetyPolicy();
    expect(defaults.mode).toBe("read_only");

    const updated = writeBankrSafetyPolicy(storage, {
      mode: "read_write",
      dailyUsdCap: "900" as unknown as number,
      perActionUsdCap: "120" as unknown as number,
      allowedChains: ["BASE", "solana", "base"] as unknown as string[],
      allowedActionTypes: ["trade", "read"],
      blockedSymbols: [" eth ", "btc", "BTC"] as unknown as string[],
      requireApprovalEveryWrite: false,
    });

    expect(updated.mode).toBe("read_write");
    expect(updated.dailyUsdCap).toBe(900);
    expect(updated.perActionUsdCap).toBe(120);
    expect(updated.allowedChains).toEqual(["base", "solana"]);
    expect(updated.allowedActionTypes).toEqual(["trade", "read"]);
    expect(updated.blockedSymbols).toEqual(["ETH", "BTC"]);
    expect(updated.requireApprovalEveryWrite).toBe(true);
    expect(readBankrSafetyPolicy(storage).mode).toBe("read_write");
  });

  it("evaluates read/write actions against mode, symbol, and budget caps", () => {
    const { storage } = createStorageStub();
    const testDay = new Date("2026-03-05T10:00:00.000Z");

    writeBankrSafetyPolicy(storage, {
      mode: "read_only",
      blockedSymbols: ["RUG"],
    });
    const readOnlyTrade = evaluateBankrActionPreview(storage, {
      actionType: "trade",
      chain: "base",
      symbol: "ETH",
      usdEstimate: 25,
    });
    expect(readOnlyTrade.allowed).toBe(false);
    expect(readOnlyTrade.reasonCode).toBe("read_only_mode");

    const blockedSymbol = evaluateBankrActionPreview(storage, {
      actionType: "read",
      chain: "base",
      symbol: "RUG",
    });
    expect(blockedSymbol.allowed).toBe(false);
    expect(blockedSymbol.reasonCode).toBe("symbol_blocked");

    writeBankrSafetyPolicy(storage, {
      enabled: true,
      mode: "read_write",
      dailyUsdCap: 100,
      perActionUsdCap: 40,
      allowedChains: ["base"],
      allowedActionTypes: ["trade", "read"],
      blockedSymbols: [],
    });

    const tooLarge = evaluateBankrActionPreview(
      storage,
      {
        actionType: "trade",
        chain: "base",
        symbol: "ETH",
        usdEstimate: 55,
      },
      testDay,
    );
    expect(tooLarge.allowed).toBe(false);
    expect(tooLarge.reasonCode).toBe("per_action_cap_exceeded");

    const writeAllowed = evaluateBankrActionPreview(
      storage,
      {
        actionType: "trade",
        chain: "base",
        symbol: "ETH",
        usdEstimate: 35,
      },
      testDay,
    );
    expect(writeAllowed.allowed).toBe(true);
    expect(writeAllowed.remainingPerActionUsd).toBe(5);

    const afterUsage = applyBankrBudgetUsage(storage, 70, testDay);
    expect(afterUsage).toBe(70);
    expect(readBankrDailyUsage(storage, "2026-03-05")).toBe(70);

    const dailyExceeded = evaluateBankrActionPreview(
      storage,
      {
        actionType: "trade",
        chain: "base",
        symbol: "ETH",
        usdEstimate: 40,
      },
      testDay,
    );
    expect(dailyExceeded.allowed).toBe(false);
    expect(dailyExceeded.reasonCode).toBe("daily_cap_exceeded");
  });

  it("uses the same UTC day for preview and budget usage when an explicit date is provided", () => {
    const { storage } = createStorageStub();
    const boundary = new Date("2026-03-05T23:59:59.900Z");

    writeBankrSafetyPolicy(storage, {
      enabled: true,
      mode: "read_write",
      dailyUsdCap: 100,
      perActionUsdCap: 100,
      allowedChains: ["base"],
      allowedActionTypes: ["trade"],
      blockedSymbols: [],
    });

    applyBankrBudgetUsage(storage, 80, boundary);
    const preview = evaluateBankrActionPreview(
      storage,
      {
        actionType: "trade",
        chain: "base",
        symbol: "ETH",
        usdEstimate: 25,
      },
      boundary,
    );

    expect(preview.allowed).toBe(false);
    expect(preview.reasonCode).toBe("daily_cap_exceeded");
  });

  it("still defaults to the current UTC day when no explicit date is provided", () => {
    const { storage } = createStorageStub();
    const now = new Date();

    writeBankrSafetyPolicy(storage, {
      enabled: true,
      mode: "read_write",
      dailyUsdCap: 100,
      perActionUsdCap: 100,
      allowedChains: ["base"],
      allowedActionTypes: ["trade"],
      blockedSymbols: [],
    });

    applyBankrBudgetUsage(storage, 60, now);
    const preview = evaluateBankrActionPreview(storage, {
      actionType: "trade",
      chain: "base",
      symbol: "ETH",
      usdEstimate: 30,
    });

    expect(preview.allowed).toBe(true);
    expect(preview.dailyUsageUsd).toBe(60);
  });

  // --- Atomic budget enforcement (reserveBankrBudget) ---
  // The old check-then-increment pattern (evaluateBankrActionPreview + applyBankrBudgetUsage)
  // was non-atomic: concurrent tool executions could each pass the cap check individually
  // and collectively exceed the daily hard cap.  reserveBankrBudget wraps the read, check,
  // and increment in a BEGIN IMMEDIATE transaction so only one writer can proceed at a time.

  it("reserveBankrBudget atomically checks and increments daily usage", () => {
    const { storage } = createStorageStub();
    const testDay = new Date("2026-03-10T12:00:00.000Z");
    const dailyCap = 100;

    // First reservation: $60 against a $100 cap → should succeed
    const r1 = reserveBankrBudget(storage, 60, dailyCap, testDay);
    expect(r1.reserved).toBe(true);
    expect(r1.dailyTotal).toBe(60);

    // Second reservation: $30 more → $90 total, still under cap
    const r2 = reserveBankrBudget(storage, 30, dailyCap, testDay);
    expect(r2.reserved).toBe(true);
    expect(r2.dailyTotal).toBe(90);

    // Third reservation: $20 more → $110 would exceed cap → rejected
    const r3 = reserveBankrBudget(storage, 20, dailyCap, testDay);
    expect(r3.reserved).toBe(false);
    expect(r3.dailyTotal).toBe(90); // unchanged

    // Verify the daily total was not incremented by the rejected reservation
    expect(readBankrDailyUsage(storage, "2026-03-10")).toBe(90);

    // A reservation that exactly hits the cap ($10 more → $100 total) should succeed
    const r4 = reserveBankrBudget(storage, 10, dailyCap, testDay);
    expect(r4.reserved).toBe(true);
    expect(r4.dailyTotal).toBe(100);

    // Now at exactly $100 — even $0.01 more should fail
    const r5 = reserveBankrBudget(storage, 0.01, dailyCap, testDay);
    expect(r5.reserved).toBe(false);
    expect(r5.dailyTotal).toBe(100);
  });

  it("reserveBankrBudget skips reservation for zero/negative/NaN amounts", () => {
    const { storage } = createStorageStub();
    const testDay = new Date("2026-03-10T12:00:00.000Z");

    const r1 = reserveBankrBudget(storage, 0, 100, testDay);
    expect(r1.reserved).toBe(true);
    expect(r1.dailyTotal).toBe(0);

    const r2 = reserveBankrBudget(storage, -5, 100, testDay);
    expect(r2.reserved).toBe(true);
    expect(r2.dailyTotal).toBe(0);

    const r3 = reserveBankrBudget(storage, NaN, 100, testDay);
    expect(r3.reserved).toBe(true);
    expect(r3.dailyTotal).toBe(0);
  });

  it("reserveBankrBudget uses separate buckets per day", () => {
    const { storage } = createStorageStub();
    const day1 = new Date("2026-03-10T12:00:00.000Z");
    const day2 = new Date("2026-03-11T12:00:00.000Z");

    const r1 = reserveBankrBudget(storage, 80, 100, day1);
    expect(r1.reserved).toBe(true);

    // Different day should have its own budget
    const r2 = reserveBankrBudget(storage, 80, 100, day2);
    expect(r2.reserved).toBe(true);
    expect(r2.dailyTotal).toBe(80);

    // Day 1 usage is unaffected
    expect(readBankrDailyUsage(storage, "2026-03-10")).toBe(80);
  });

  it("releaseBankrBudgetReservation refunds a reserved amount without going negative", () => {
    const { storage } = createStorageStub();
    const testDay = new Date("2026-03-10T12:00:00.000Z");

    const reserved = reserveBankrBudget(storage, 40, 100, testDay);
    expect(reserved.reserved).toBe(true);
    expect(readBankrDailyUsage(storage, "2026-03-10")).toBe(40);

    const refunded = releaseBankrBudgetReservation(storage, 15, testDay);
    expect(refunded).toBe(25);

    const clamped = releaseBankrBudgetReservation(storage, 100, testDay);
    expect(clamped).toBe(0);
  });

  it("normalizes prompt-derived action/chain/symbol/usd and appends audit", () => {
    const { storage, auditRows } = createStorageStub();

    const normalized = normalizeBankrAction({
      prompt: "Please trade $250 ETH on Base right now",
    });
    expect(normalized.actionType).toBe("trade");
    expect(normalized.chain).toBe("base");
    expect(normalized.symbol).toBe("ETH");
    expect(normalized.usdEstimate).toBe(250);

    const fallback = normalizeBankrSafetyPolicy(undefined, undefined);
    expect(fallback.enabled).toBe(true);
    expect(fallback.allowedChains.includes("ethereum")).toBe(true);

    const audit = appendBankrActionAudit(storage, {
      sessionId: "session-1",
      actorId: "operator",
      actionType: "read",
      status: "blocked",
      chain: normalized.chain,
      symbol: normalized.symbol,
      usdEstimate: normalized.usdEstimate,
      details: { note: "coverage" },
    });

    expect(audit.actionId.length).toBeGreaterThan(10);
    expect(auditRows.length).toBe(1);
    expect(auditRows[0]?.detailsJson).toContain("coverage");
  });

  it("covers disabled, action, chain, and missing-estimate preview blocks", () => {
    const { storage } = createStorageStub();

    writeBankrSafetyPolicy(storage, { enabled: false });
    expect(evaluateBankrActionPreview(storage, { actionType: "read" }).reasonCode).toBe("policy_disabled");

    writeBankrSafetyPolicy(storage, {
      enabled: true,
      mode: "read_write",
      allowedActionTypes: ["read"],
    });
    expect(evaluateBankrActionPreview(storage, { actionType: "trade", chain: "base", usdEstimate: 1 }).reasonCode).toBe(
      "action_type_not_allowed",
    );

    writeBankrSafetyPolicy(storage, {
      enabled: true,
      mode: "read_write",
      allowedActionTypes: ["trade"],
      allowedChains: ["base"],
    });
    expect(
      evaluateBankrActionPreview(storage, { actionType: "trade", chain: "polygon", usdEstimate: 1 }).reasonCode,
    ).toBe("chain_not_allowed");
    expect(evaluateBankrActionPreview(storage, { actionType: "trade", chain: "base" }).reasonCode).toBe(
      "usd_estimate_required",
    );

    writeBankrSafetyPolicy(storage, {
      enabled: true,
      mode: "read_write",
      allowedActionTypes: ["read", "trade"],
      allowedChains: ["base"],
    });
    expect(evaluateBankrActionPreview(storage, { actionType: "read", chain: "base" })).toMatchObject({
      allowed: true,
      reason: "Bankr read action passed policy checks.",
    });

    expect(evaluateBankrActionPreview(storage, [] as unknown as BankrActionPreviewRequest)).toMatchObject({
      normalized: {
        actionType: "read",
      },
    });
  });

  it("returns current daily usage for invalid apply/release amounts", () => {
    const { storage } = createStorageStub();
    const testDay = new Date("2026-03-20T12:00:00.000Z");

    applyBankrBudgetUsage(storage, 30, testDay);

    expect(applyBankrBudgetUsage(storage, 0, testDay)).toBe(30);
    expect(applyBankrBudgetUsage(storage, Number.NaN, testDay)).toBe(30);
    expect(releaseBankrBudgetReservation(storage, 0, testDay)).toBe(30);
    expect(releaseBankrBudgetReservation(storage, Number.NaN, testDay)).toBe(30);
  });

  it("normalizes prompt fallbacks for write action types and chains", () => {
    expect(normalizeBankrAction([] as unknown as Record<string, unknown>)).toEqual({
      actionType: "read",
      chain: undefined,
      symbol: undefined,
      usdEstimate: undefined,
      prompt: undefined,
    });

    expect(normalizeBankrAction({ prompt: "deploy on mainnet" })).toMatchObject({
      actionType: "deploy",
      chain: "ethereum",
    });
    expect(normalizeBankrAction({ prompt: "submit raw transaction on polygon" })).toMatchObject({
      actionType: "submit",
      chain: "polygon",
    });
    expect(normalizeBankrAction({ prompt: "sign message on solana" })).toMatchObject({
      actionType: "sign",
      chain: "solana",
    });
    expect(normalizeBankrAction({ prompt: "send funds to unichain" })).toMatchObject({
      actionType: "transfer",
      chain: "unichain",
    });
    expect(normalizeBankrAction({ prompt: "look up holdings" })).toMatchObject({
      actionType: "read",
      chain: undefined,
      usdEstimate: undefined,
    });
    expect(normalizeBankrAction({ prompt: "buy ETH with $12.50", usdEstimate: "42" })).toMatchObject({
      actionType: "trade",
      symbol: "ETH",
      usdEstimate: 42,
    });
  });

  it("falls back when policy array and currency inputs are malformed", () => {
    const normalized = normalizeBankrSafetyPolicy(
      {
        dailyUsdCap: -1,
        perActionUsdCap: "nope" as unknown as number,
        allowedChains: [null, ""] as unknown as string[],
        allowedActionTypes: [null, "nope"] as unknown as BankrActionType[],
        blockedSymbols: [null, ""] as unknown as string[],
      },
      {
        enabled: true,
        mode: "read_only",
        dailyUsdCap: 9,
        perActionUsdCap: 3,
        requireApprovalEveryWrite: true,
        allowedChains: ["base"],
        allowedActionTypes: ["read"],
        blockedSymbols: ["ETH"],
      },
    );

    expect(normalized.dailyUsdCap).toBe(9);
    expect(normalized.perActionUsdCap).toBe(3);
    expect(normalized.allowedChains).toEqual(["base", "ethereum", "polygon", "solana", "unichain"]);
    expect(normalized.allowedActionTypes).toEqual(["read", "trade", "transfer", "sign", "submit", "deploy"]);
    expect(normalized.blockedSymbols).toEqual([]);
  });

  it("stores null USD estimates in audit rows when amounts are invalid", () => {
    const { storage, auditRows } = createStorageStub();

    appendBankrActionAudit(storage, {
      sessionId: "session-2",
      actorId: "operator",
      actionType: "read",
      status: "preview_allowed",
      usdEstimate: Number.NaN,
    });

    expect(auditRows[0]?.usdEstimate).toBeNull();
  });

  it("covers final normalization fallbacks for empty rows, aliases, and blank strings", () => {
    const storage = {
      db: {
        prepare: () => ({
          get: () => undefined,
        }),
      },
    } as unknown as Storage;

    expect(readBankrDailyUsage(storage, "2026-03-31")).toBe(0);
    expect(normalizeBankrAction({ chain: "mainnet" })).toMatchObject({ chain: "ethereum" });
    expect(normalizeBankrAction({ prompt: "buy ETH with $0" })).toMatchObject({ usdEstimate: undefined });
    expect(normalizeBankrAction({ prompt: "   " })).toMatchObject({ prompt: undefined });
  });
});
