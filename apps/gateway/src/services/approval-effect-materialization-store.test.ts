import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hasCanonicalAssistantMessage, lockApprovalMaterializationRun, lockApprovalMaterializationTrace,
  runApprovalEffectTransaction, runClaimedApprovalEffectTransaction,
} from "./approval-effect-materialization-store.js";

afterEach(() => vi.unstubAllEnvs());

describe("approval materialization persistence fences", () => {
  it("refuses production work without an immediate transaction", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const work = vi.fn();
    await expect(runApprovalEffectTransaction({} as never, work)).rejects.toThrow("transaction ownership");
    expect(work).not.toHaveBeenCalled();
  });

  it.each(["missing", "expired", "current"])("requires a %s claim before materialization", async mode => {
    vi.stubEnv("NODE_ENV", "production");
    let inTransaction = false;
    const lockFreshClaimForUpdate = vi.fn(async () => {
      expect(inTransaction).toBe(true);
      return mode === "current" ? { effectId: "effect" } : undefined;
    });
    const storage = {
      async runImmediateTransaction(work: () => Promise<unknown>) {
        inTransaction = true;
        try { return await work(); } finally { inTransaction = false; }
      },
      approvalEffects: mode === "missing" ? {} : { lockFreshClaimForUpdate },
    };
    const work = vi.fn(async () => { expect(inTransaction).toBe(true); return "committed"; });
    const pending = runClaimedApprovalEffectTransaction(storage as never, { effectId: "effect", version: 7 } as never, "worker", work);
    if (mode === "current") await expect(pending).resolves.toBe("committed");
    else await expect(pending).rejects.toThrow();
    expect(work).toHaveBeenCalledTimes(mode === "current" ? 1 : 0);
    if (mode !== "missing") expect(lockFreshClaimForUpdate).toHaveBeenCalledWith("effect", "worker", 7);
  });

  it.each(["run", "trace"])("refuses a non-locking production %s read", async kind => {
    vi.stubEnv("NODE_ENV", "production");
    const get = vi.fn();
    const storage = { durableRuns: { getRun: get }, chatTurnTraces: { get } };
    await expect(kind === "run" ? lockApprovalMaterializationRun(storage as never, "id")
      : lockApprovalMaterializationTrace(storage as never, "id")).rejects.toThrow("row-lock ownership");
    expect(get).not.toHaveBeenCalled();
  });

  it.each(["run", "trace"])("uses the canonical production %s row-lock owner", async kind => {
    vi.stubEnv("NODE_ENV", "production");
    const row = { id: "id" }, locked = vi.fn(async () => row);
    const storage = { durableRuns: { getRunForUpdate: locked }, chatTurnTraces: { getForUpdate: locked } };
    await expect(kind === "run" ? lockApprovalMaterializationRun(storage as never, "id")
      : lockApprovalMaterializationTrace(storage as never, "id")).resolves.toBe(row);
    expect(locked).toHaveBeenCalledWith("id");
  });

  it.each(["matching", "foreign", "user", "missing"])("accepts only a canonical assistant message: %s", async mode => {
    const get = vi.fn(async () => mode === "missing" ? undefined : {
      role: mode === "user" ? "user" : "assistant", sessionId: mode === "foreign" ? "other" : "session",
    });
    await expect(hasCanonicalAssistantMessage({ chatMessages: { get } } as never,
      { assistantMessageId: "message", sessionId: "session" } as never)).resolves.toBe(mode === "matching");
    expect(get).toHaveBeenCalledWith("message");
  });
});
