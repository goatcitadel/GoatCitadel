import type { ToolInvokeRequest, ToolPolicyConfig } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeBankrSafetyPolicy } from "./bankr-guard.js";

const mocked = vi.hoisted(() => {
  const execFileAsync = vi.fn();
  const execFile = vi.fn();
  Object.defineProperty(execFile, Symbol.for("nodejs.util.promisify.custom"), {
    value: execFileAsync,
  });
  return {
    execFile,
    execFileAsync,
    spawn: vi.fn(),
  };
});

vi.mock("node:child_process", () => ({
  execFile: mocked.execFile,
  spawn: mocked.spawn,
}));

import { executeTool } from "./tool-executor.js";

const policyConfig: ToolPolicyConfig = {
  profiles: {
    danger: ["*"],
  },
  tools: {
    profile: "danger",
    approvalMode: "bypass",
    allow: [],
    deny: [],
  },
  agents: {},
  sandbox: {
    writeJailRoots: ["./workspace"],
    readOnlyRoots: ["./skills"],
    networkAllowlist: ["api.bankr.bot", "llm.bankr.bot"],
    riskyShellPatterns: [],
    requireApprovalForRiskyShell: true,
  },
};

describe("tool executor Bankr coverage", () => {
  beforeEach(() => {
    vi.useRealTimers();
    mocked.execFile.mockClear();
    mocked.spawn.mockClear();
    mocked.execFileAsync.mockReset();
    mocked.execFileAsync.mockImplementation(async (_file: string, args: string[]) => {
      if (args[0] === "--version") {
        return { stdout: "bankr 1.0.0\n", stderr: "" };
      }
      return { stdout: "bankr response\n", stderr: "bankr warning\n" };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports Bankr CLI availability through bankr.status", async () => {
    const result = await executeTool(bankrRequest("bankr.status", {}), policyConfig, createBankrStorage());

    expect(result).toMatchObject({
      cliAvailable: true,
      policy: {
        enabled: true,
      },
    });
  });

  it("blocks read/write mode mismatches before invoking the CLI", async () => {
    const storage = createBankrStorage();
    writeBankrSafetyPolicy(storage, {
      enabled: true,
      mode: "read_write",
      allowedActionTypes: ["read", "trade"],
      allowedChains: ["base"],
    });

    await expect(
      executeTool(
        bankrRequest("bankr.read", {
          prompt: "trade $10 ETH on base",
          actionType: "trade",
          chain: "base",
          usdEstimate: 10,
        }),
        policyConfig,
        storage,
      ),
    ).rejects.toThrow(/bankr\.read only supports read actions/i);

    await expect(
      executeTool(bankrRequest("bankr.write", { prompt: "show balance", actionType: "read" }), policyConfig, storage),
    ).rejects.toThrow(/money-moving action intent/i);
  });

  it("audits disabled policy and missing CLI failures", async () => {
    const disabledStorage = createBankrStorage();
    writeBankrSafetyPolicy(disabledStorage, { enabled: false });

    await expect(
      executeTool(
        bankrRequest("bankr.read", { prompt: "show balance", actionType: "read" }),
        policyConfig,
        disabledStorage,
      ),
    ).rejects.toThrow(/Bankr policy blocked action/i);

    mocked.execFileAsync.mockRejectedValueOnce(new Error("bankr missing"));
    const missingCliStorage = createBankrStorage();
    await expect(
      executeTool(
        bankrRequest("bankr.read", { prompt: "show balance", actionType: "read" }),
        policyConfig,
        missingCliStorage,
      ),
    ).rejects.toThrow(/Bankr CLI not found/i);
  });

  it("executes write prompts with budget reservation and thread flags", async () => {
    const storage = createBankrStorage();
    writeBankrSafetyPolicy(storage, {
      enabled: true,
      mode: "read_write",
      dailyUsdCap: 100,
      perActionUsdCap: 50,
      allowedActionTypes: ["trade", "read"],
      allowedChains: ["base"],
    });

    const result = await executeTool(
      bankrRequest("bankr.write", {
        prompt: "trade $25 ETH on base",
        actionType: "trade",
        chain: "base",
        symbol: "ETH",
        usdEstimate: 25,
        threadId: "thread-1",
      }),
      policyConfig,
      storage,
    );

    expect(result).toMatchObject({
      mode: "write",
      actionType: "trade",
      stdoutSnippet: "bankr response\n",
      stderrSnippet: "bankr warning\n",
      dailyUsageUsdAfter: 25,
    });
    expect(mocked.execFileAsync).toHaveBeenLastCalledWith(
      "bankr",
      ["prompt", "--thread", "thread-1", "trade $25 ETH on base"],
      expect.objectContaining({ windowsHide: true }),
    );
  });

  it("refunds reserved budget when Bankr CLI execution fails", async () => {
    const storage = createBankrStorage();
    writeBankrSafetyPolicy(storage, {
      enabled: true,
      mode: "read_write",
      dailyUsdCap: 100,
      perActionUsdCap: 50,
      allowedActionTypes: ["trade", "read"],
      allowedChains: ["base"],
    });
    const cliError = Object.assign(new Error("bankr failed"), {
      stdout: "partial output",
      stderr: "rejected",
      code: 7,
    });
    mocked.execFileAsync.mockResolvedValueOnce({ stdout: "bankr 1.0.0\n", stderr: "" }).mockRejectedValueOnce(cliError);

    await expect(
      executeTool(
        bankrRequest("bankr.write", {
          prompt: "trade $30 ETH on base",
          actionType: "trade",
          chain: "base",
          symbol: "ETH",
          usdEstimate: 30,
          continue: true,
        }),
        policyConfig,
        storage,
      ),
    ).rejects.toThrow(/Bankr command failed: rejected/i);

    expect(readDailyUsage(storage, "2026-03-22")).toBe(0);
  });

  it("blocks write prompts when an atomic daily budget reservation would exceed the cap", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T12:00:00.000Z"));
    const storage = createBankrStorage();
    writeBankrSafetyPolicy(storage, {
      enabled: true,
      mode: "read_write",
      dailyUsdCap: 10,
      perActionUsdCap: 10,
      allowedActionTypes: ["trade", "read"],
      allowedChains: ["base"],
    });
    const originalPrepare = storage.db.prepare.bind(storage.db);
    let budgetReadCount = 0;
    storage.db.prepare = ((sql: string) => {
      const statement = originalPrepare(sql);
      if (sql.includes("FROM bankr_budget_usage_daily")) {
        return {
          ...statement,
          get: (params: Record<string, unknown>) => {
            budgetReadCount += 1;
            return budgetReadCount === 1 ? { usdTotal: 0 } : { usdTotal: 9, day: params.day };
          },
        };
      }
      return statement;
    }) as Storage["db"]["prepare"];

    await expect(
      executeTool(
        bankrRequest("bankr.write", {
          prompt: "trade $5 ETH on base",
          actionType: "trade",
          chain: "base",
          symbol: "ETH",
          usdEstimate: 5,
        }),
        policyConfig,
        storage,
      ),
    ).rejects.toThrow(/remaining daily cap \(\$1\)/i);

    expect(readDailyUsage(storage, "2026-03-22")).toBe(9);
    expect(mocked.execFileAsync).toHaveBeenCalledTimes(1);
  });
});

function bankrRequest(toolName: string, args: Record<string, unknown>): ToolInvokeRequest {
  return {
    toolName,
    args,
    agentId: "agent-bankr",
    sessionId: "session-bankr",
  };
}

function createBankrStorage(): Storage {
  const settings = new Map<string, unknown>();
  const daily = new Map<string, number>();
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
            daily.set(day, (daily.get(day) ?? 0) + (Number.isFinite(amount) ? amount : 0));
            return { changes: 1 };
          }
          return { changes: 1 };
        },
        get: (params: Record<string, unknown>) => {
          if (sql.includes("FROM bankr_budget_usage_daily")) {
            return { usdTotal: daily.get(String(params.day ?? "")) ?? 0 };
          }
          return undefined;
        },
      }),
    },
    runImmediateTransaction: <T>(callback: () => T) => callback(),
  } as unknown as Storage;

  return storage;
}

function readDailyUsage(storage: Storage, day: string): number {
  const statement = storage.db.prepare(
    "SELECT usd_total AS usdTotal FROM bankr_budget_usage_daily WHERE day = @day",
  ) as {
    get(params: Record<string, unknown>): { usdTotal?: number } | undefined;
  };
  return Number(statement.get({ day })?.usdTotal ?? 0);
}
